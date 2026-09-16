// OPERATOR OVERLAY (2026-09-16) — the durability property, stated as tests.
//
// THE BUG. `zilberman` was granted `site_apply_brand_imagery` through project.update, twice, and
// `workspace.audit_capabilities({projectId:"zilberman"})` kept reporting
// `route_tool_blocked_by_policy:zilberman:site_apply_brand_imagery`. Nothing was cached: the audit
// reads the record live. The grant was gone from the record, because `toolPolicies` is a MANAGED map —
// `migrateDefaultProjectConfig` replaces it wholesale with the genesis profile (minted tenants) or the
// code definition (the five code projects) on the first read after a definitionVersion bump, and
// `planGenesisReconcile` patches it wholesale too. The verb is on GENESIS_WITHHELD_ROUTE_VERBS, so the
// profile does not name it, so every rewrite deleted the grant and answered ok:true.
//
// The fix is a second field the managed rewrites do not own. These tests are the proof that they
// don't: each one performs the exact rewrite that used to erase the grant, and asserts the effective
// permission afterwards rather than the shape of any map.
import { describe, expect, it } from "vitest";
import { deriveOperatorToolPolicies, managedPolicyBaseline, migrateDefaultProjectConfig } from "../../../src/agent/projects/defaultMigration.js";
import { genesisParityDivergences, declaredRouteVerbs } from "../../../src/agent/projects/genesisParity.js";
import { runGenesisReconcile } from "../../../src/agent/capture/genesisReconcile.js";
import { GENESIS_TENANT_DEFINITION_VERSION, genesisTenantProfile } from "../../../src/agent/projects/genesisTenantProfile.js";
import { GENESIS_DEFAULT_OBJECT_TYPE, GENESIS_REQUEST_ID_PATTERN } from "../../../src/agent/capture/siteGenesis.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import { updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { effectiveToolPermission, toToolPolicyMap, type ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// The fixture verb is one the managed baseline does NOT name, which is the whole premise of an
// operator overlay. It WAS `site_apply_brand_imagery` — the verb whose disappearing grant found this
// bug — until the same day's tenant-route-parity change made the profile grant that verb to every
// tenant. `ownership_transfer` is a real tenant verb no route declares and no baseline grants, so it
// plays the same role without being hostage to a policy decision made elsewhere.
const VERB = "ownership_transfer";

const mintedTenant = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig => ({
  projectId: "zilberman",
  name: "Zilberman Film Foundation",
  clientSiteBinding: { netlifySiteName: "zilbermanfilmfoundation", netlifySiteId: "site-zilberman" },
  mcpEndpointEnvVar: "ZILBERMAN_MCP_ENDPOINT",
  mcpEndpoint: "https://zilbermanfilmfoundation.netlify.app/mcp",
  authMode: "bearer_env",
  tokenEnvVar: "ZILBERMAN_MCP_TOKEN",
  allowedTools: [],
  ...genesisTenantProfile(),
  tracking: { projectId: "zilberman" },
  objectDialect: {
    siteObjectId: "site_zilberman",
    taxonomyRegistryObjectId: "tax_zilberman",
    objectIdSource: "server_minted",
    requestIdPattern: GENESIS_REQUEST_ID_PATTERN,
    defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE,
    voiceObjectId: "voice_zilberman",
    strategyObjectId: "strat_zilberman"
  },
  contentContract: { contentContract: "content_source.v1" },
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "", autonomyMode: "autonomous" },
  status: "active",
  ...overrides
} as unknown as ProjectConnectionConfig);

const memoryRepository = (...configs: ProjectConnectionConfig[]): ProjectRepository => {
  const records = new Map(configs.map((config) => [config.projectId, structuredClone(config)]));
  return {
    list: async () => [...records.values()].map((record) => structuredClone(record)),
    get: async (projectId) => { const record = records.get(projectId); return record ? structuredClone(record) : undefined; },
    save: async (config) => { records.set(config.projectId, structuredClone(config)); return structuredClone(config); },
    delete: async (projectId) => records.delete(projectId),
    health: async () => ({ backend: "memory", writable: true, readable: true, version: "test" }) as never
  };
};

describe("operator tool-policy overlay", () => {
  it("outranks the managed map, the legacy allow-list and the client-wide default", () => {
    const config = mintedTenant({ operatorToolPolicies: { [VERB]: "allowed", object_publish: "blocked" } });
    expect(effectiveToolPermission(config, VERB)).toBe("allowed");
    // A pin can also WITHHOLD something the profile grants — the same field, both directions.
    expect(effectiveToolPermission(config, "object_publish")).toBe("blocked");
    // And the flattened map every surface renders agrees with it.
    expect(toToolPolicyMap(config)[VERB]).toBe("allowed");
    expect(toToolPolicyMap(config).object_publish).toBe("blocked");
  });

  it("survives the minted-tenant migration that replaces toolPolicies wholesale", () => {
    // A v2 record — exactly the state that made the live grant vanish on the next read.
    const stale = mintedTenant({ definitionVersion: 2, operatorToolPolicies: { [VERB]: "allowed" } });
    const migrated = migrateDefaultProjectConfig(stale);
    expect(migrated.changed).toBe(true);
    expect(migrated.config.definitionVersion).toBe(GENESIS_TENANT_DEFINITION_VERSION);
    // The managed map was rewritten to the profile, and the profile does not name this verb at all...
    expect(migrated.config.toolPolicies?.[VERB]).toBeUndefined();
    expect(genesisTenantProfile().toolPolicies[VERB]).toBeUndefined();
    // ...and the operator's decision still stands.
    expect(effectiveToolPermission(migrated.config, VERB)).toBe("allowed");
  });

  it("survives the code-project migration that replaces the WHOLE record", () => {
    const stale: ProjectConnectionConfig = {
      ...structuredClone(drLurieProjectConfig),
      definitionVersion: 0,
      operatorToolPolicies: { [VERB]: "blocked" }
    } as ProjectConnectionConfig;
    const migrated = migrateDefaultProjectConfig(stale);
    expect(migrated.changed).toBe(true);
    // dr-lurie is defaultToolPolicy "allowed", so the pin is the only thing that can withhold a verb.
    expect(effectiveToolPermission(migrated.config, VERB)).toBe("blocked");
  });

  it("survives genesis:reconcile --apply, which patches toolPolicies wholesale through updateProject", async () => {
    const repository = memoryRepository(mintedTenant({ definitionVersion: 2, operatorToolPolicies: { [VERB]: "allowed" }, tracking: undefined }));
    const applied = await runGenesisReconcile("zilberman", repository, { dryRun: false });
    expect(applied.applied).toBe(true);
    const reconciled = (await repository.get("zilberman"))!;
    expect(reconciled.operatorToolPolicies?.[VERB]).toBe("allowed");
    expect(effectiveToolPermission(reconciled, VERB)).toBe("allowed");
  });

  it("is not reported as genesis drift, so reconcile never chases a decision it cannot close", () => {
    // release_to_production is a DECLARED route verb (release_executor's manifest) that the profile
    // grants, so withholding it here is exactly the shape parity would otherwise report as drift.
    const pinned = mintedTenant({ operatorToolPolicies: { release_to_production: "blocked" } });
    expect(declaredRouteVerbs()).toContain("release_to_production");
    const divergences = genesisParityDivergences(pinned, { requestIdPattern: GENESIS_REQUEST_ID_PATTERN, defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE });
    expect(divergences.some((divergence) => divergence.field === "toolPolicies.release_to_production")).toBe(false);
    // ...and without the pin it IS drift, so the skip is doing the work, not the absence of a check.
    const unpinned = genesisParityDivergences(mintedTenant({ toolPolicies: { ...genesisTenantProfile().toolPolicies, release_to_production: "blocked" } }), { requestIdPattern: GENESIS_REQUEST_ID_PATTERN, defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE });
    expect(unpinned.some((divergence) => divergence.field === "toolPolicies.release_to_production")).toBe(true);
  });
});

describe("overlay derivation from an ordinary policy write", () => {
  it("pins the verb a toolPolicies write adds beyond the managed baseline", async () => {
    const repository = memoryRepository(mintedTenant());
    const profile = genesisTenantProfile();
    const summary = await updateProject(repository, "zilberman", {
      toolPolicies: { ...profile.toolPolicies, [VERB]: "allowed" }
    } as never);
    expect(summary.operatorToolPolicies).toEqual({ [VERB]: "allowed" });
    // Only the deviation is pinned — the 43 verbs the profile already grants stay managed, so a future
    // profile version can still add to them.
    expect(Object.keys(summary.operatorToolPolicies)).toHaveLength(1);
  });

  it("releases the pin when the verb is written back to its baseline value", async () => {
    const repository = memoryRepository(mintedTenant({ operatorToolPolicies: { [VERB]: "allowed" } }));
    const profile = genesisTenantProfile();
    const summary = await updateProject(repository, "zilberman", {
      toolPolicies: { ...profile.toolPolicies, [VERB]: "blocked" }
    } as never);
    expect(summary.operatorToolPolicies[VERB]).toBeUndefined();
  });

  it("keeps a pin a partial write simply omits, rather than making an accident permanent", async () => {
    const repository = memoryRepository(mintedTenant({ operatorToolPolicies: { [VERB]: "allowed" } }));
    const summary = await updateProject(repository, "zilberman", { toolPolicies: { ping: "allowed" } } as never);
    expect(summary.operatorToolPolicies[VERB]).toBe("allowed");
  });

  it("clears the overlay on an explicit null, handing the verbs back to the managed baseline", async () => {
    const repository = memoryRepository(mintedTenant({ operatorToolPolicies: { [VERB]: "allowed" } }));
    const summary = await updateProject(repository, "zilberman", { operatorToolPolicies: null } as never);
    expect(summary.operatorToolPolicies).toEqual({});
    expect(effectiveToolPermission((await repository.get("zilberman"))!, VERB)).toBe("blocked");
  });

  it("reads the baseline from code, not from the record it is checking", () => {
    const minted = mintedTenant();
    expect(managedPolicyBaseline(minted).toolPolicies?.object_publish).toBe("allowed");
    expect(managedPolicyBaseline(minted).toolPolicies?.[VERB]).toBeUndefined();
    expect(managedPolicyBaseline(drLurieProjectConfig).defaultToolPolicy).toBe(drLurieProjectConfig.defaultToolPolicy);
    // A project no code owns is its own baseline: nothing rewrites it, so nothing can erase an edit.
    const unmanaged = mintedTenant({ projectId: "hand-registered", clientSiteBinding: undefined, toolPolicies: { ping: "allowed" } });
    expect(deriveOperatorToolPolicies(unmanaged)).toEqual({});
  });
});
