// Registry of external project MCP connections that CMS-Agent can perform primitive, guarded tests
// against (initialize, tools/list, contract discovery, dry validation). Publishing execution is NOT
// part of this registry and remains disabled until a future explicit PUBLISH gate is implemented.

export const projectAuthModes = ["none", "bearer_env"] as const;
export type ProjectAuthMode = typeof projectAuthModes[number];

export const projectStatuses = ["active", "disabled"] as const;
export type ProjectStatus = typeof projectStatuses[number];

export type ProjectContentContract = {
  // Structured envelope the project hands work off with, e.g. "content_source.v1".
  contentContract: string;
  // Canonical article body artifact the project consumes/produces, e.g. "article_body.v1".
  canonicalArticleBody: string;
};

export type ProjectPublishingPolicy = {
  // Publishing execution is intentionally disabled. It may only be enabled by a future explicit
  // PUBLISH approval gate; this registry never performs publish side effects.
  publishEnabled: false;
  requiresExplicitPublish: true;
  description: string;
};

export type ProjectConnectionConfig = {
  projectId: string;
  // Monotonic code-definition version used to safely migrate persisted default project records.
  definitionVersion?: number;
  name: string;
  // The MCP endpoint and bearer token are resolved from environment variables at connection time and
  // are NEVER persisted or returned, so no project secrets are stored in workspace JSON / blobs.
  mcpEndpointEnvVar: string;
  authMode: ProjectAuthMode;
  tokenEnvVar?: string;
  allowedTools: string[];
  contentContract: ProjectContentContract;
  publishingPolicy: ProjectPublishingPolicy;
  status: ProjectStatus;
};

// Safe, caller-facing view of a project. Only non-secret metadata plus booleans indicating whether
// the endpoint/token env vars are populated — never the endpoint value, token, or headers.
export type ProjectConnectionState = {
  endpointConfigured: boolean;
  tokenConfigured: boolean;
  mcpEndpointEnvVar: string;
  tokenEnvVar?: string;
};

export type ProjectSummary = {
  projectId: string;
  name: string;
  authMode: ProjectAuthMode;
  allowedTools: string[];
  contentContract: ProjectContentContract;
  publishingPolicy: ProjectPublishingPolicy;
  status: ProjectStatus;
  connection: ProjectConnectionState;
};
