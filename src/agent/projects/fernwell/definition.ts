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

export const FERNWELL_DEFINITION_VERSION = 1;

export const fernwellProjectConfig: ProjectConnectionConfig = {
  projectId: "fernwell",
  definitionVersion: FERNWELL_DEFINITION_VERSION,
  name: "Fernwell",
  mcpEndpointEnvVar: "FERNWELL_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "FERNWELL_MCP_TOKEN",
  allowedTools: [...FERNWELL_SAFE_READ_ONLY_TOOLS],
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
