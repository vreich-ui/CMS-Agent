import { describe, expect, it } from "vitest";
import { declaredRouteVerbs, genesisParityDivergences } from "../../../src/agent/projects/genesisParity.js";
import { planGenesisReconcile, runGenesisReconcile } from "../../../src/agent/capture/genesisReconcile.js";
import { GENESIS_DEFAULT_OBJECT_TYPE, GENESIS_REQUEST_ID_PATTERN } from "../../../src/agent/capture/siteGenesis.js";
import { genesisTenantProfile } from "../../../src/agent/projects/genesisTenantProfile.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import { platformScaffoldObjectIds } from "../../../src/agent/projects/platformScaffoldIds.js";
import { genesisNetlifySiteName } from "../../../src/agent/projects/genesisSiteName.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

const options = { requestIdPattern: GENESIS_REQUEST_ID_PATTERN, defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE };

// A tenant as genesis mints one TODAY. Every test below starts here and removes one fact, so each
// assertion names exactly one divergence and its consequence.
const mintedTenant = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig => {
  const ids = platformScaffoldObjectIds("genesis-lab-3");
  return {
    projectId: "genesis-lab-3",
    // A2.3: the fleet convention is `kugel-<slug>` — the live mint named this site `genesis-lab-3`
    // and that IS the divergence the check now reports (see the site-name table below).
    clientSiteBinding: { netlifySiteName: "kugel-genesis-lab-3", netlifySiteId: "site-123", netlifySiteNameSource: "derived" as const },
    name: "genesis-lab-3",
    mcpEndpointEnvVar: "GENESIS_LAB_3_MCP_ENDPOINT",
    mcpEndpoint: "https://genesis-lab-3.netlify.app/mcp",
    authMode: "bearer_env",
    tokenEnvVar: "GENESIS_LAB_3_MCP_TOKEN",
    tokenSecretRef: "projects/cms-agent-503015/secrets/genesis-lab-3-mcp-token/versions/latest",
    allowedTools: [],
    ...genesisTenantProfile(),
    tracking: { projectId: "genesis-lab-3" },
    objectDialect: {
      siteObjectId: ids.siteObjectId,
      taxonomyRegistryObjectId: ids.taxonomyRegistryObjectId,
      objectIdSource: "server_minted",
      requestIdPattern: GENESIS_REQUEST_ID_PATTERN,
      defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE,
      voiceObjectId: ids.voiceObjectId,
      strategyObjectId: ids.strategyObjectId
    },
    contentContract: { contentContract: "content_source.v1" },
    publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "", autonomyMode: "autonomous" },
    status: "active",
    ...overrides
  } as unknown as ProjectConnectionConfig;
};

const memoryRepository = (config: ProjectConnectionConfig): ProjectRepository => {
  const records = new Map<string, ProjectConnectionConfig>([[config.projectId, config]]);
  return {
    list: async () => [...records.values()],
    get: async (projectId: string) => records.get(projectId),
    save: async (next: ProjectConnectionConfig) => {
      records.set(next.projectId, next);
      return next;
    },
    delete: async (projectId: string) => records.delete(projectId),
    health: async () => ({ readable: true, writable: true, backend: "memory", version: "memory.v1" })
  } as unknown as ProjectRepository;
};

describe("G5 — genesis parity against the fleet reference", () => {
  it("reports nothing for a tenant minted by the current birth path", () => {
    expect(genesisParityDivergences(mintedTenant(), options)).toEqual([]);
  });

  // The check run against the reference itself. Two properties are pinned here and both matter:
  //
  //   1. NO TOOL-POLICY FALSE POSITIVES. dr-lurie is `defaultToolPolicy: "allowed"` with a hand-tuned
  //      two-entry map; a minted tenant is `blocked` with an explicit 39-verb map. The two maps look
  //      nothing alike, and a check that diffed MAPS would flag the reference against itself. This
  //      one compares EFFECTIVE permissions, so it does not.
  //   2. THE REFERENCE'S OWN REAL GAPS ARE STILL REPORTED. dr-lurie and platform predate site
  //      genesis, carry no clientSiteBinding and no recorded sink partition, and the fleet credential
  //      reconciler therefore omits them from every plan (projectAdmin.ts's own advisory says so,
  //      2026-09-04). Those are true findings about a real tenant, not noise — so they are asserted
  //      rather than filtered away, and this test fails the day somebody backfills them.
  it("reports no tool-policy divergence for the reference, and still reports its real gaps", () => {
    const divergences = genesisParityDivergences(drLurieProjectConfig, options);
    expect(divergences.filter((divergence) => divergence.field.startsWith("toolPolicies."))).toEqual([]);
    // definitionVersion is per-DEFINITION and dr-lurie's is its own; the check must not compare it
    // for a code-defined project.
    expect(divergences.map((divergence) => divergence.field)).not.toContain("definitionVersion");
    expect(divergences.filter((divergence) => !divergence.field.startsWith("objectDialect.")).map((divergence) => divergence.field).sort()).toEqual([
      "clientSiteBinding.netlifySiteName",
      // See the note below: the reference's autonomy is a live-record fact its code definition does
      // not declare, so the check run against the DEFINITION reports it. Run against the live record
      // (which is what the CLI reads) it does not.
      "publishingPolicy.autonomyMode",
      "tracking.projectId"
    ]);
    // KNOWN, DELIBERATELY NOT FIXED HERE (recorded in docs/genesis/recon-2026-09-14.md §D6a):
    // dr-lurie's autonomyMode lives ONLY on the live record — it was set by hand on 2026-09-07 — and
    // its code definition is silent. `migrateDefaultProjectConfig` REPLACES a code project's whole
    // record the moment `definitionVersion` moves, so the next bump would revert that decision to
    // operator-gated with nothing naming why. Declaring it in the definition is a one-line fix and a
    // fleet-wide behaviour change (it re-baselines every publish-gate test in this repo, all of which
    // pin "no declared autonomy" as the default), so it is a decision for its own change, not a side
    // effect of genesis parity. Asserted as the CURRENT state so the day somebody declares it, this
    // test says so out loud rather than silently agreeing.
    expect(drLurieProjectConfig.publishingPolicy.autonomyMode).toBeUndefined();
  });

  it("names the blockage from the proof run when the dialect is missing", () => {
    const divergences = genesisParityDivergences(mintedTenant({ objectDialect: undefined }), options);
    const site = divergences.find((divergence) => divergence.field === "objectDialect.siteObjectId");
    expect(site).toBeDefined();
    expect(site!.expected).toBe("site_genesis_lab_3");
    expect(site!.actual).toBe("(unset)");
    expect(site!.consequence).toContain("artifact_site_scope_missing");
    expect(divergences.find((divergence) => divergence.field === "objectDialect.defaultObjectType")!.consequence).toContain("no_ceiling");
  });

  it("names the publish posture when autonomy is unset", () => {
    const divergences = genesisParityDivergences(
      mintedTenant({ publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "" } }),
      options
    );
    const autonomy = divergences.find((divergence) => divergence.field === "publishingPolicy.autonomyMode")!;
    expect(autonomy.expected).toBe("autonomous");
    expect(autonomy.consequence).toContain("publication_controller");
  });

  it("compares EFFECTIVE tool permission verb by verb, over the engine's own route manifests", () => {
    expect(declaredRouteVerbs().length).toBeGreaterThan(0);
    const crippled = mintedTenant({ toolPolicies: { ...genesisTenantProfile().toolPolicies, object_create: "blocked" } });
    const divergences = genesisParityDivergences(crippled, options);
    expect(divergences.map((divergence) => divergence.field)).toContain("toolPolicies.object_create");
  });

  // A tenant with a WIDER map than the fleet reference is a divergence too. Parity is equality, not
  // a floor: a minted tenant quietly holding a verb dr-lurie does not is the mirror image of the bug
  // this check exists for, and reads exactly as harmless right up until it is not.
  it("flags a verb the reference does not grant", () => {
    const reference = drLurieProjectConfig;
    const widened = mintedTenant({ toolPolicies: { ...genesisTenantProfile().toolPolicies, wipe_blob_stores: "allowed" } });
    // Only meaningful if the reference actually restricts it, which it does (needs_approval).
    expect(reference.toolPolicies?.wipe_blob_stores).toBe("needs_approval");
    const divergences = genesisParityDivergences(widened, options);
    const flagged = divergences.find((divergence) => divergence.field === "toolPolicies.wipe_blob_stores");
    // wipe_blob_stores is not a route-manifest verb, so it is out of scope by design — the check
    // walks what a RUN speaks, not the whole tool surface. Stated as a test so the scope is a
    // decision rather than an accident.
    expect(flagged).toBeUndefined();
  });
});

describe("G2 — genesis:reconcile repairs a tenant born before the birth path was right", () => {
  it("plans the dialect, the autonomy and the profile for a genesis-lab-2-shaped record", async () => {
    const stale = mintedTenant({
      projectId: "genesis-lab-2",
      objectDialect: undefined,
      publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "" },
      defaultToolPolicy: "allowed",
      toolPolicies: {},
      definitionVersion: undefined
    });
    const plan = planGenesisReconcile(stale);
    expect(plan.patch.objectDialect).toEqual({
      siteObjectId: "site_genesis_lab_2",
      taxonomyRegistryObjectId: "tax_genesis_lab_2",
      objectIdSource: "server_minted",
      requestIdPattern: GENESIS_REQUEST_ID_PATTERN,
      defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE,
      voiceObjectId: "voice_genesis_lab_2",
      strategyObjectId: "strat_genesis_lab_2"
    });
    expect(plan.patch.autonomyMode).toBe("autonomous");
    expect(plan.patch.defaultToolPolicy).toBe("blocked");
    expect(plan.patch.toolPolicies?.object_create).toBe("allowed");
  });

  it("is dry by default and idempotent once applied", async () => {
    const stale = mintedTenant({ projectId: "genesis-lab-2", objectDialect: undefined, publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "" } });
    const repository = memoryRepository(stale);

    const dry = await runGenesisReconcile("genesis-lab-2", repository);
    expect(dry.applied).toBe(false);
    expect((await repository.get("genesis-lab-2"))!.objectDialect).toBeUndefined();

    const applied = await runGenesisReconcile("genesis-lab-2", repository, { dryRun: false });
    expect(applied.applied).toBe(true);
    const repaired = (await repository.get("genesis-lab-2"))!;
    expect(repaired.objectDialect?.siteObjectId).toBe("site_genesis_lab_2");
    expect(repaired.publishingPolicy.autonomyMode).toBe("autonomous");
    expect(genesisParityDivergences(repaired, options).filter((divergence) => divergence.reconcilable)).toEqual([]);

    const second = await runGenesisReconcile("genesis-lab-2", repository, { dryRun: false });
    expect(second.applied).toBe(false);
  });

  it("NEVER overwrites a dialect pointer an operator deliberately set elsewhere", async () => {
    const configured = mintedTenant({
      objectDialect: {
        siteObjectId: "site_somewhere_else",
        taxonomyRegistryObjectId: "tax_genesis_lab_3",
        objectIdSource: "server_minted",
        requestIdPattern: GENESIS_REQUEST_ID_PATTERN,
        defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE,
        voiceObjectId: "voice_genesis_lab_3",
        strategyObjectId: "strat_genesis_lab_3"
      }
    });
    const plan = planGenesisReconcile(configured);
    expect(plan.patch.objectDialect).toBeUndefined();
    expect(plan.deferred.map((entry) => entry.field)).toContain("objectDialect.siteObjectId");
    expect(plan.deferred[0]!.reason).toContain("escape hatch");
  });

  it("never touches publishEnabled, a site binding or a token reference", async () => {
    const broken = mintedTenant({
      publishingPolicy: { publishEnabled: false, requiresExplicitPublish: false, description: "" },
      clientSiteBinding: undefined,
      tokenSecretRef: undefined,
      tokenEnvVar: undefined
    });
    const plan = planGenesisReconcile(broken);
    expect(plan.patch).not.toHaveProperty("publishEnabled");
    expect(plan.patch).not.toHaveProperty("clientSiteBinding");
    expect(plan.patch).not.toHaveProperty("tokenSecretRef");
    const deferredFields = plan.deferred.map((entry) => entry.field);
    expect(deferredFields).toContain("publishingPolicy.publishEnabled");
    expect(deferredFields).toContain("clientSiteBinding.netlifySiteName");
    expect(deferredFields).toContain("tokenSecretRef");
  });
});

// A2.3 (2026-09-15) — THE SITE-NAME CONVENTION, as a table.
//
// `genesis-lab-2` is `kugel-genesis-lab-2`; the live mint of `genesis-lab-3` produced `genesis-lab-3`.
// Both genesis paths defaulted to the bare slug and the prefix lived in an operator's habit, so the
// first unattended mint broke the convention with nothing to catch it.
describe("A2.3 — one Netlify site-name derivation, and a parity check that flags divergence", () => {
  it("derives kugel-<slug>, idempotently on the prefix", () => {
    const table: Array<[string, string]> = [
      ["genesis-lab-3", "kugel-genesis-lab-3"],
      ["seniorpets", "kugel-seniorpets"],
      ["fernwell", "kugel-fernwell"],
      // Idempotent: a re-run feeds whatever is already on the record back through here.
      ["kugel-platform", "kugel-platform"],
      ["kugel-genesis-lab-2", "kugel-genesis-lab-2"]
    ];
    for (const [slug, expected] of table) expect(genesisNetlifySiteName(slug)).toBe(expected);
  });

  it("flags a minted tenant whose site name is off-convention", () => {
    const divergences = genesisParityDivergences(
      mintedTenant({ clientSiteBinding: { netlifySiteName: "genesis-lab-3", netlifySiteId: "site-123", netlifySiteNameSource: "derived" } }),
      options
    );
    expect(divergences.map((divergence) => divergence.field)).toEqual(["clientSiteBinding.netlifySiteName"]);
    expect(divergences[0]).toMatchObject({ expected: "kugel-genesis-lab-3", actual: "genesis-lab-3", reconcilable: false });
  });

  it("stays silent for a recorded override, and for tenants that predate the convention", () => {
    // An operator who signed off on an off-convention name is not nagged about it forever.
    expect(
      genesisParityDivergences(mintedTenant({ clientSiteBinding: { netlifySiteName: "genesis-lab-3", netlifySiteId: "site-123", netlifySiteNameSource: "override" } }), options)
        .map((divergence) => divergence.field)
    ).toEqual([]);
    // No source recorded at all (every record written before this field existed) is not an override,
    // but it is also not a claim — so a name that already matches the convention is clean.
    expect(
      genesisParityDivergences(mintedTenant({ clientSiteBinding: { netlifySiteName: "kugel-genesis-lab-3", netlifySiteId: "site-123" } }), options)
        .map((divergence) => divergence.field)
    ).toEqual([]);
  });
});
