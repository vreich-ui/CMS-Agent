import { describe, expect, it } from "vitest";
import {
  EDITORIAL_STRATEGY_OBJECT_TYPE,
  GENESIS_DEFAULT_SET_BY,
  genesisEditorialStrategyDefault,
  getEditorialStrategy,
  isEditorialStrategyBody,
  type EditorialStrategyBody
} from "../../../src/agent/projects/genesisEditorialStrategy.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// W4 (2026-09-09, Wolf) — the resolver every strategy consumer reads through.
//
// Three things are pinned here, and each of them is a decision rather than an implementation detail:
//   1. The UNSET MARKER is provenance, not absence. An object that exists and says
//      set_by="genesis_default" degrades to source "default" with strategy_object_unconfigured, and
//      an object that does not exist at all earns THE SAME warning — to a consumer the two states
//      mean the identical thing.
//   2. Unset never blocks: every degraded path still returns a usable body where one can honestly be
//      built, and never throws on any of them.
//   3. The address resolves BY CONVENTION when no pointer is recorded, which is the whole reason the
//      fan-out can serve a genesis-minted tenant that carries no objectDialect at all.

const body = (overrides: Partial<EditorialStrategyBody> = {}): EditorialStrategyBody => ({
  name: "acme strategy",
  goal: "grow the newsletter",
  offer: "the paid tier",
  audience_segments: ["clinicians"],
  topic_weights: [{ label: "retinoids", weight: 0.6 }],
  angle_mix: [{ angle: "objection", share: 1 }],
  funnel_aggression: { tofu: 0.5, mofu: 0.3, bofu: 0.2 },
  cadence: "weekly",
  provenance: { set_by: "human", set_at: "2026-09-01T00:00:00.000Z" },
  ...overrides
});

const config = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig =>
  ({
    projectId: "acme-daily",
    name: "Acme Daily",
    mcpEndpointEnvVar: "ACME_DAILY_MCP_ENDPOINT",
    authMode: "bearer_env",
    allowedTools: [],
    contentContract: { contentContract: "content_source.v1" },
    publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
    status: "active",
    ...overrides
  }) as unknown as ProjectConnectionConfig;

const repositoryWith = (record?: ProjectConnectionConfig): ProjectRepository =>
  ({ get: async () => record } as unknown as ProjectRepository);

const resolve = async (record: ProjectConnectionConfig | undefined, call?: (args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>) =>
  getEditorialStrategy(
    { projectId: record?.projectId ?? "acme-daily" },
    {
      projectRepository: repositoryWith(record),
      ...(call ? { callReadTool: async (_config, _tool, args) => call(args) } : {})
    }
  );

describe("genesisEditorialStrategyDefault", () => {
  it("returns nothing when genesis knew neither a niche nor an audience — a default nobody can ground is boilerplate", () => {
    expect(genesisEditorialStrategyDefault({ slug: "acme" })).toBeUndefined();
  });

  it("marks itself as the unset marker and declares no offer it was not given", () => {
    const built = genesisEditorialStrategyDefault({ slug: "acme", niche: "skincare", audience: "clinicians" })!;
    expect(built.provenance.set_by).toBe(GENESIS_DEFAULT_SET_BY);
    expect(built.topic_weights).toEqual([]);
    expect(built.offer.toLowerCase()).toContain("none declared");
    expect(isEditorialStrategyBody(built)).toBe(true);
  });
});

describe("getEditorialStrategy", () => {
  it("reads the decided object at the conventional strat_<slug> address when the record carries no pointer", async () => {
    const seen: Record<string, unknown>[] = [];
    const result = await resolve(config(), async (args) => {
      seen.push(args);
      return { ok: true, result: { structuredContent: { record: { object_id: "strat_acmedaily", body: body() } } } };
    });
    expect(seen[0]).toEqual({ object_type: EDITORIAL_STRATEGY_OBJECT_TYPE, object_id: "strat_acmedaily" });
    expect(result.source).toBe("object");
    expect(result.objectIdSource).toBe("convention");
    expect(result.warningCode).toBeUndefined();
  });

  it("prefers the record's objectDialect.strategyObjectId over the convention", async () => {
    const seen: Record<string, unknown>[] = [];
    await resolve(
      config({ objectDialect: { siteObjectId: "site_acme", taxonomyRegistryObjectId: "tax_acme", objectIdSource: "server_minted", strategyObjectId: "strat_elsewhere" } }),
      async (args) => { seen.push(args); return { ok: true, result: { body: body() } }; }
    );
    expect(seen[0]!.object_id).toBe("strat_elsewhere");
  });

  it("calls a genesis-default object 'default', warns strategy_object_unconfigured, and still hands the body over", async () => {
    const result = await resolve(config(), async () => ({ ok: true, result: { body: body({ provenance: { set_by: GENESIS_DEFAULT_SET_BY, set_at: "2026-09-01T00:00:00.000Z" } }) } }));
    expect(result.source).toBe("default");
    expect(result.warningCode).toBe("strategy_object_unconfigured");
    // Unset never blocks: the body is still returned for the consumer to use.
    expect(result.strategy?.name).toBe("acme strategy");
  });

  it("gives a missing object the SAME warning as a genesis default — to a consumer they mean one thing", async () => {
    const result = await resolve(config(), async () => ({ ok: true, result: { not_found: true } }));
    expect(result.warningCode).toBe("strategy_object_unconfigured");
    expect(result.source).toBe("unavailable");
  });

  it("builds a fallback from the audience genesis already recorded on the voice fallback", async () => {
    const record = config({ editorialVoiceFallback: { audience: "dermatology residents" } as never });
    const result = await resolve(record, async () => ({ ok: false, error: "client_unreachable (TypeError)" }));
    expect(result.source).toBe("fallback");
    expect(result.warningCode).toBe("strategy_prefetch_unreachable");
    expect(result.strategy?.audience_segments).toEqual(["dermatology residents"]);
  });

  it("is a silent unavailable on an unknown project — a registration gap is not a strategy warning", async () => {
    const result = await resolve(undefined);
    expect(result.source).toBe("unavailable");
    // No warningCode, exactly as voicePrefetch.ts resolves the same case: a run whose projectId has
    // no record has no strategy CONCEPT, and stamping a strategy warning on it would make a
    // genuinely strategy-less project noisy on every single dispatch.
    expect(result.warningCode).toBeUndefined();
    expect(result.warning).toContain("Unknown projectId");
  });

  it("treats an object with no provenance block as decided rather than demoting it to a default", async () => {
    const { provenance: _dropped, ...withoutProvenance } = body();
    const result = await resolve(config(), async () => ({ ok: true, result: { body: withoutProvenance } }));
    expect(result.source).toBe("object");
  });
});
