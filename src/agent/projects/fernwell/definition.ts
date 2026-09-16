import type { ProjectConnectionConfig, ProjectObjectDialect } from "../projectTypes.js";

// Fernwell's project identity is the registry slug corresponding to Platform's committed
// site_fernwell/siteSlug=fernwell binding. Endpoint and bearer values remain deployment secrets.
export const FERNWELL_SAFE_READ_ONLY_TOOLS = [
  "ping",
  "registry_get",
  "object_inventory",
  "object_contract",
  "object_get",
  "object_list",
  "object_validate"
] as const;

export const FERNWELL_OBJECT_DIALECT: ProjectObjectDialect = {
  siteObjectId: "site_fernwell",
  taxonomyRegistryObjectId: "tax_fernwell",
  objectIdSource: "server_minted",
  requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$",
  defaultObjectType: "content_item",
  voiceObjectId: "voice_fernwell"
};

// TENANT ROUTE PARITY (2026-09-16, Wolf). Fernwell was declared with SEVEN read verbs and no
// defaultToolPolicy, which resolves to deny-all: every write route — capture emit, artifact
// materialization, pdf template mint/publish, theme bind, visual standard apply, publish, release —
// was refused pre-transport on this tenant. It never showed up as a broken run because the record is
// `status: "disabled"` and the capability audit skips disabled projects, so it would have surfaced as
// "why does nothing work on fernwell" on the day somebody enabled it.
//
// The fix is not a list in this file. `applyTenantRoutePolicy` (defaultMigration.ts) unions THE tenant
// route policy — derived from the route manifests — into every code-defined tenant as it is read, so
// fernwell inherits exactly what dr-lurie, platform and every minted tenant get, and a route that
// starts speaking a new verb reaches all of them at once with no per-tenant edit. This file keeps only
// what is fernwell's own: its read list, its dialect, its identity.
//
// Bumped 1 -> 2 (2026-09-16) so the live record re-seeds and picks that union up.
export const FERNWELL_DEFINITION_VERSION = 2;

export const fernwellProjectConfig: ProjectConnectionConfig = {
  projectId: "fernwell",
  definitionVersion: FERNWELL_DEFINITION_VERSION,
  name: "Fernwell",
  mcpEndpointEnvVar: "FERNWELL_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "FERNWELL_MCP_TOKEN",
  allowedTools: [...FERNWELL_SAFE_READ_ONLY_TOOLS],
  defaultToolPolicy: "blocked",
  contentContract: {
    contentContract: "content_source.v1"
  },
  objectDialect: { ...FERNWELL_OBJECT_DIALECT },
  publishingPolicy: {
    publishEnabled: true,
    requiresExplicitPublish: false,
    description: "Publishing is enabled (go-live 2026-07-31, operator decision). Set the per-project *_PUBLISH_ENABLED=false env flag to force publishing off."
  },
  status: "active"
};
