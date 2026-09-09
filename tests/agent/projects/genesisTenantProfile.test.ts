import { describe, expect, it } from "vitest";
import {
  GENESIS_EMISSION_VERBS,
  GENESIS_TENANT_DEFINITION_VERSION,
  GENESIS_TENANT_TOOL_POLICIES,
  genesisTenantProfile,
  isGenesisMintedProject
} from "../../../src/agent/projects/genesisTenantProfile.js";
import { migrateDefaultProjectConfig } from "../../../src/agent/projects/defaultMigration.js";
import { defaultProjectConnections } from "../../../src/agent/projects/defaultProjects.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// G5 ACCEPTANCE. Two failures are possible here and they point in opposite directions, which is why
// both are pinned:
//   1. TOO NARROW — a minted tenant is born `blocked` with an allowlist that misses an emission verb,
//      and every clone run stalls. This is the bug the old `defaultToolPolicy: "allowed"` was avoiding
//      by permitting everything, and re-creating it would be strictly worse than the drift we set out
//      to fix.
//   2. TOO BROAD — the migration reaches a minted tenant and applies the code-project path, which
//      REPLACES the whole record and would erase its endpoint, token custody, dialect and site
//      binding. `changed: true` on a record that lost its identity is not a migration, it is data loss.

const mintedTenant = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig =>
  ({
    projectId: "acme",
    clientSiteBinding: { netlifySiteName: "acme-site", netlifySiteId: "site-123" },
    name: "acme",
    mcpEndpointEnvVar: "ACME_MCP_ENDPOINT",
    mcpEndpoint: "https://acme.example/mcp",
    authMode: "bearer_env",
    tokenEnvVar: "ACME_MCP_TOKEN",
    tokenSecretRef: "projects/cms-agent-503015/secrets/acme-mcp-token/versions/latest",
    allowedTools: [],
    contentContract: { contentContract: "content_source.v1" },
    objectDialect: {
      siteObjectId: "site_acme",
      taxonomyRegistryObjectId: "tax_acme",
      objectIdSource: "server_minted"
    },
    publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, operatorDefault: "approved", autonomyMode: "autonomous" },
    status: "active",
    ...overrides
  }) as unknown as ProjectConnectionConfig;

describe("G5 — the genesis tenant profile", () => {
  it("permits every verb the capture and clone emission stages actually speak", () => {
    // The containment property IS the profile's safety guarantee. A future edit that drops a verb
    // from the map fails here rather than in production as a stalled clone run.
    for (const verb of GENESIS_EMISSION_VERBS) {
      expect(GENESIS_TENANT_TOOL_POLICIES[verb], `emission verb "${verb}" is not permitted by the genesis profile`).toBe("allowed");
    }
  });

  it("denies by default rather than permitting every verb the tenant surface happens to expose", () => {
    const profile = genesisTenantProfile();
    expect(profile.defaultToolPolicy).toBe("blocked");
    // A verb nobody named is refused — including one added to the tenant surface after birth, which
    // is the case `allowed` could never handle.
    expect(profile.toolPolicies?.wipe_blob_stores).toBeUndefined();
  });

  it("keeps the publish verbs the two authorized executor nodes exist to speak", () => {
    // Removing these would harden nothing: FORBIDDEN_PROJECT_VERBS already refuses them
    // pre-transport for every node except publish_executor and release_executor.
    expect(GENESIS_TENANT_TOOL_POLICIES.object_publish).toBe("allowed");
    expect(GENESIS_TENANT_TOOL_POLICIES.release_to_production).toBe("allowed");
  });

  it("returns a fresh policy map per call, so one tenant cannot mutate another's", () => {
    const first = genesisTenantProfile();
    first.toolPolicies!.ping = "needs_approval";
    expect(genesisTenantProfile().toolPolicies!.ping).toBe("allowed");
  });
});

describe("G5 — migrateDefaultProjectConfig now sees minted tenants", () => {
  it("migrates a genesis-born tenant WITHOUT touching its identity", () => {
    const before = mintedTenant({ defaultToolPolicy: "allowed", toolPolicies: {} });
    const { config, changed } = migrateDefaultProjectConfig(before);

    expect(changed).toBe(true);
    expect(config.defaultToolPolicy).toBe("blocked");
    expect(config.toolPolicies?.object_create).toBe("allowed");
    expect(config.definitionVersion).toBe(GENESIS_TENANT_DEFINITION_VERSION);

    // Everything that makes this record THIS tenant survives. This is the assertion that separates a
    // merge from the code-project path's whole-record replace.
    expect(config.projectId).toBe("acme");
    expect(config.mcpEndpoint).toBe("https://acme.example/mcp");
    expect(config.tokenSecretRef).toBe("projects/cms-agent-503015/secrets/acme-mcp-token/versions/latest");
    expect(config.objectDialect?.siteObjectId).toBe("site_acme");
    expect(config.clientSiteBinding?.netlifySiteId).toBe("site-123");
    expect(config.publishingPolicy).toEqual(before.publishingPolicy);
  });

  it("is a no-op once the tenant is already at the current profile version", () => {
    const current = mintedTenant({ ...genesisTenantProfile() });
    expect(migrateDefaultProjectConfig(current).changed).toBe(false);
  });

  it("leaves a project that is neither code-defined nor genesis-born alone", () => {
    // No clientSiteBinding — an ordinary hand-registered project. Inheriting a tenant profile it
    // never asked for would be a silent policy change on somebody else's record.
    const plain = mintedTenant({ clientSiteBinding: undefined, defaultToolPolicy: "allowed" });
    const { config, changed } = migrateDefaultProjectConfig(plain);
    expect(changed).toBe(false);
    expect(config.defaultToolPolicy).toBe("allowed");
  });

  it("does not disturb any of the five code-defined default projects", () => {
    // The regression that matters most: dr-lurie, platform, fernwell, pdf-tool and monetizer must
    // resolve exactly as they did before this branch existed.
    for (const project of defaultProjectConnections) {
      expect(isGenesisMintedProject(project), `${project.projectId} must not be treated as genesis-born`).toBe(false);
      const { config, changed } = migrateDefaultProjectConfig(structuredClone(project));
      expect(changed).toBe(false);
      expect(config).toEqual(project);
    }
  });
});
