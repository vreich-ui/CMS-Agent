import { describe, expect, it, vi } from "vitest";
import {
  GENESIS_FLEET_ENV_VARS,
  NETLIFY_AUTH_TOKEN_ENV,
  NETLIFY_DEFAULT_ENV_SCOPES,
  NETLIFY_SECRET_CONTEXTS,
  resolveGenesisFleetEnvVars,
  runSiteGenesis,
  type GenesisAction,
  type GenesisHumanChecklistItem
} from "../../../src/agent/capture/siteGenesis.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// T21.8 — "setting up tracking for a new tenant has to be part of the genesis process not manually"
// (Wolf, 2026-09-01). Two things are pinned here:
//
//   1. TRACKING_PROJECT_ID is the BARE slug — the tracking sink's partition id. Genesis used to
//      install `trk_<slug>`, which is the tracking_config OBJECT id: a genesis-provisioned tenant's
//      events landed in a partition nothing ever read (live: /stats?project_id=drlurie → 204
//      pageviews; ?project_id=trk_drlurie → 0).
//   2. The fleet-shared sink connection (+ NETLIFY_AUTH_TOKEN) is INSTALLED by genesis from this
//      deployment's own environment instead of being pasted per tenant — with a scope set that
//      includes `builds` (the tenant repo's postbuild tracking-dims-push reads them at BUILD time;
//      functions-only is why drluriescience's dims counters sat at zero), secrets written
//      per-context because Netlify refuses a secret with context "all", and NOTHING written when the
//      fleet value is absent — the human checklist entry stays as the fallback instead.
//
// Dry-run Netlify mode throughout: the fetch double fails the test on any network call.

const SOURCE_URL = "https://an-example-prospect-site.test/";

const memoryProjectRepository = (): ProjectRepository => {
  const records = new Map<string, ProjectConnectionConfig>();
  return {
    list: async () => [...records.values()],
    get: async (projectId: string) => records.get(projectId),
    save: async (config: ProjectConnectionConfig) => {
      records.set(config.projectId, config);
      return config;
    },
    delete: async (projectId: string) => records.delete(projectId),
    health: async () => ({ readable: true, writable: true, backend: "memory", version: "memory.v1" })
  } as unknown as ProjectRepository;
};

const baseEnv = (): NodeJS.ProcessEnv =>
  ({
    NETLIFY_API_TOKEN: "netlify-test-token-dry-run-only",
    CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp"
  }) as unknown as NodeJS.ProcessEnv;

const fleetEnv = (): NodeJS.ProcessEnv =>
  ({
    ...baseEnv(),
    [TRACKING_SINK_URL_ENV]: "https://sink.example/track",
    [TRACKING_SINK_TOKEN_ENV]: "fleet-sink-token",
    [NETLIFY_AUTH_TOKEN_ENV]: "fleet-netlify-token"
  }) as unknown as NodeJS.ProcessEnv;

const genesis = async (env: NodeJS.ProcessEnv) => {
  const netlifyFetch = vi.fn(async (url: string) => {
    throw new Error(`dry-run genesis must never call the Netlify API: ${url}`);
  });
  const result = await runSiteGenesis(
    { name: "acme", netlifySiteName: "acme-site", sourceUrl: SOURCE_URL },
    { projectRepository: memoryProjectRepository(), env, netlifyFetch: netlifyFetch as never }
  );
  expect(netlifyFetch).not.toHaveBeenCalled();
  return result;
};

const envSets = (ledger: GenesisAction[]) =>
  new Map(
    ledger
      .filter((action) => action.step === "netlify_set_env")
      .map((action) => [
        String((action.data as { key?: string }).key),
        action.data as { key: string; isSecret: boolean; scopes: string[]; contexts: string[] }
      ])
  );

const item = (checklist: GenesisHumanChecklistItem[], id: string) => checklist.find((entry) => entry.id === id)!;

describe("T21.8 — tracking provisioning is part of genesis", () => {
  it("installs TRACKING_PROJECT_ID as the BARE slug — the sink's partition id, never the trk_ tracking_config object id", async () => {
    const result = await genesis(fleetEnv());
    const trackingProjectId = result.ledger.find(
      (action) => action.step === "netlify_set_env" && (action.data as { key?: string }).key === "TRACKING_PROJECT_ID"
    );
    expect(trackingProjectId).toBeDefined();
    // The value never reaches the ledger by construction, so the id is proven the way the sink sees
    // it: no `trk_` string may appear anywhere in the genesis result, checklist detail included.
    expect(JSON.stringify(result)).not.toContain("TRACKING_PROJECT_ID deterministically to trk_");
    expect(item(result.humanChecklist, "tracking_sink").detail).toContain("Genesis set TRACKING_PROJECT_ID deterministically to acme —");
    expect(item(result.humanChecklist, "tracking_sink").detail).toContain("Do NOT set trk_acme");
  });

  it("provisions every tracking var it WRITES with a scope set containing `builds` — the postbuild dims push reads them at BUILD time", async () => {
    const result = await genesis(fleetEnv());
    const sets = envSets(result.ledger);
    for (const key of ["TRACKING_PROJECT_ID", NETLIFY_AUTH_TOKEN_ENV]) {
      expect(sets.get(key), `${key} was not provisioned`).toBeDefined();
      expect(sets.get(key)!.scopes, `${key} must be readable at build time`).toContain("builds");
      expect(sets.get(key)!.scopes).toContain("functions");
      expect(sets.get(key)!.scopes).toEqual([...NETLIFY_DEFAULT_ENV_SCOPES]);
    }
  });

  // C-11. The sink pair is an ACCOUNT-level variable every site in the team already reads. A
  // site-level copy OVERRIDES it, so writing one creates a second source of truth that wins silently
  // and then drifts — which is exactly how drluriescience ended up holding a 20-character token the
  // sink had stopped accepting, one rebuild away from losing that tenant's tracking entirely.
  it("NEVER writes a site-level copy of the sink pair — it inherits and checks by name", async () => {
    const result = await genesis(fleetEnv());
    const sets = envSets(result.ledger);
    for (const key of [TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV]) {
      expect(sets.has(key), `${key} must be inherited from the account, never copied onto the site`).toBe(false);
    }
    const checks = result.ledger.filter((action) => action.step === "netlify_check_env");
    expect(checks.map((action) => (action.data as { key: string }).key).sort())
      .toEqual([TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV].sort());
  });

  it("writes secrets per-context and NEVER with context `all` (the dev context forbids secrets)", async () => {
    const result = await genesis(fleetEnv());
    const sets = envSets(result.ledger);
    for (const key of [NETLIFY_AUTH_TOKEN_ENV]) {
      expect(sets.get(key)!.isSecret).toBe(true);
      expect(sets.get(key)!.contexts).toEqual([...NETLIFY_SECRET_CONTEXTS]);
      expect(sets.get(key)!.contexts).not.toContain("all");
    }
    // Every secret genesis writes, not only the tracking ones.
    for (const set of sets.values()) {
      if (set.isSecret) expect(set.contexts).not.toContain("all");
    }
    // The non-secret partition id is unaffected: it still rides every context.
    expect(sets.get("TRACKING_PROJECT_ID")!.isSecret).toBe(false);
    expect(sets.get("TRACKING_PROJECT_ID")!.contexts).toEqual(["all"]);
  });

  it("no fleet value ever leaks into the ledger, the checklist, or the returned document", async () => {
    const result = await genesis(fleetEnv());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("fleet-sink-token");
    expect(serialized).not.toContain("fleet-netlify-token");
    expect(serialized).not.toContain("https://sink.example/track");
    expect(serialized).not.toContain("netlify-test-token-dry-run-only");
  });

  it("shrinks the human checklist to the decision that is genuinely human once the fleet values are installed", async () => {
    const result = await genesis(fleetEnv());
    // The item is never dropped (absence of a step is itself audited) — it loses its envVars and
    // says what genesis did.
    const trackingSink = item(result.humanChecklist, "tracking_sink");
    expect(trackingSink.envVars).toBeUndefined();
    expect(trackingSink.title).toContain("genesis installed the fleet sink connection");
    expect(trackingSink.detail).toContain("were installed by genesis from this deployment's own fleet values");
    const fleetKeys = item(result.humanChecklist, "fleet_shared_keys");
    expect(fleetKeys.envVars).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(fleetKeys.detail).toContain(`${NETLIFY_AUTH_TOKEN_ENV} is no longer one either`);
    const fleetLedger = result.ledger.find((action) => action.step === "tracking_fleet_env")!;
    expect(fleetLedger.kind).toBe("dry_run");
    expect(fleetLedger.data).toMatchObject({
      provisioned: [NETLIFY_AUTH_TOKEN_ENV],
      inherited: [TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV],
      missing: []
    });
    expect(fleetLedger.detail).toContain("Inherited from the account, NOT copied");
  });

  it("falls back to the human checklist entry — never an empty value — when this deployment holds no COPIED fleet value", async () => {
    const result = await genesis(baseEnv());
    const sets = envSets(result.ledger);
    // Not written at all: an absent fleet value is never invented and never written empty. The sink
    // pair is absent for a different reason — it is inherited, never copied — so neither appears.
    for (const key of [TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV, NETLIFY_AUTH_TOKEN_ENV]) {
      expect(sets.has(key), `${key} must not be provisioned from an absent fleet value`).toBe(false);
    }
    // …and the deterministic partition id is still installed, because it is derived, not inherited.
    expect(sets.has("TRACKING_PROJECT_ID")).toBe(true);

    const fleetKeys = item(result.humanChecklist, "fleet_shared_keys");
    expect(fleetKeys.envVars).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", NETLIFY_AUTH_TOKEN_ENV]);
    expect(fleetKeys.detail).toContain(`${NETLIFY_AUTH_TOKEN_ENV} is NOT configured`);
    // The gap is audited, not silently skipped — and it is ONLY the copied key, because the account
    // supplies the sink pair regardless of what this deployment happens to hold.
    const fleetLedger = result.ledger.find((action) => action.step === "tracking_fleet_env")!;
    expect(fleetLedger.kind).toBe("requires_human");
    expect(fleetLedger.data).toMatchObject({ provisioned: [], inherited: [TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV], missing: [NETLIFY_AUTH_TOKEN_ENV] });
  });

  // The whole point of C-11: what this deployment holds is irrelevant to the sink pair. Holding a
  // stale copy must not cause one to be written, and holding nothing must not cause one to be missed.
  it("ignores this deployment's own copy of the sink pair entirely", async () => {
    const stale = { ...baseEnv(), [TRACKING_SINK_URL_ENV]: "https://stale.example/track", [TRACKING_SINK_TOKEN_ENV]: "stale-token" } as unknown as NodeJS.ProcessEnv;
    const result = await genesis(stale);
    const sets = envSets(result.ledger);
    expect(sets.has(TRACKING_SINK_URL_ENV)).toBe(false);
    expect(sets.has(TRACKING_SINK_TOKEN_ENV)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("stale-token");
    expect(JSON.stringify(result)).not.toContain("https://stale.example/track");
  });
});

describe("resolveGenesisFleetEnvVars — what genesis may hand a new tenant", () => {
  it("treats a blank or whitespace-only COPIED fleet value as absent rather than provisioning an empty one", () => {
    const resolution = resolveGenesisFleetEnvVars({
      [NETLIFY_AUTH_TOKEN_ENV]: "   "
    } as unknown as NodeJS.ProcessEnv);
    expect(resolution.missing).toEqual([NETLIFY_AUTH_TOKEN_ENV]);
    expect(resolution.provisioned).toEqual([]);
  });

  it("puts the sink pair in `inherited` and never reads its value from this environment", () => {
    const resolution = resolveGenesisFleetEnvVars({
      [TRACKING_SINK_URL_ENV]: "https://stale.example/track",
      [TRACKING_SINK_TOKEN_ENV]: "stale-token",
      [NETLIFY_AUTH_TOKEN_ENV]: " fleet-netlify-token "
    } as unknown as NodeJS.ProcessEnv);
    expect(resolution.inherited).toEqual([TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV]);
    expect(resolution.provisioned).toEqual([{ key: NETLIFY_AUTH_TOKEN_ENV, value: "fleet-netlify-token", isSecret: true }]);
    // An inherited key is never a "missing" one either: the account supplies it, not this process.
    expect(resolution.missing).toEqual([]);
    expect(JSON.stringify(resolution)).not.toContain("stale-token");
  });

  it("marks every fleet value as a secret, and marks exactly the sink pair as inherited", () => {
    expect(GENESIS_FLEET_ENV_VARS.every((fleetVar) => fleetVar.isSecret)).toBe(true);
    expect(GENESIS_FLEET_ENV_VARS.map((fleetVar) => fleetVar.key)).toEqual([TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV, NETLIFY_AUTH_TOKEN_ENV]);
    expect(GENESIS_FLEET_ENV_VARS.filter((fleetVar) => fleetVar.inherited).map((fleetVar) => fleetVar.key))
      .toEqual([TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV]);
  });
});
