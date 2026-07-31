// Registry of external project MCP connections that CMS-Agent can perform primitive, guarded tests
// against (initialize, tools/list, contract discovery, dry validation). Publishing execution is NOT
// part of this registry and remains disabled until a future explicit PUBLISH gate is implemented.

export const projectAuthModes = ["none", "bearer_env"] as const;
export type ProjectAuthMode = typeof projectAuthModes[number];

export const projectStatuses = ["active", "disabled"] as const;
export type ProjectStatus = typeof projectStatuses[number];

// Per-tool permission, mirroring Claude Code's allow/ask/deny model:
//   allowed        — project.call_tool forwards the call to the remote server.
//   needs_approval — the call is held, NOT auto-run; the result carries requiresApproval so a human
//                    must approve it out of band before it can proceed.
//   blocked        — the call is refused before any transport.
export const toolPermissions = ["allowed", "needs_approval", "blocked"] as const;
export type ToolPermission = typeof toolPermissions[number];

export type ProjectContentContract = {
  // Structured envelope the project hands work off with, e.g. "content_source.v1".
  contentContract: string;
  // The canonical body artifact (client_object.v1 — one client object plus its provenance) is NOT
  // configured here: every project declared the identical value, so the field could only ever
  // misconfigure. The article_body node's own `produces` const is the single source (see
  // projectRegistry.ts validate_handoff).
};

// Per-SITE parameters of the object-native publish dialect. These are the values that differ from
// tenant to tenant on the same object substrate (Dr. Lurie and platform/client 0 both live there),
// and they belong in the project's configuration — never as string literals inside a publish hook,
// which is how one client's identifiers end up fired at another client's server.
//
// Sourced from the client's own object_contract(content_item): `auxiliary_inputs` names `site`
// ("the owning site object id") as a create-time input and the taxonomy registry as the authority
// `taxonomy.category`/`taxonomy.tags` resolve against; the `id_object` constraint states that a
// content_item keeps the article request-id shape.
export type ProjectObjectDialect = {
  // Owning site object id, passed as `site` on object_create (e.g. "site_platform").
  siteObjectId: string;
  // The site's taxonomy registry object id (e.g. "tax_platform"); unresolved terms block the write.
  taxonomyRegistryObjectId: string;
  // Who mints the object id: "server_minted" means NEVER send requested_id and read the id back off
  // the create result; "request_id" means the caller-supplied request id IS the object id.
  objectIdSource: "server_minted" | "request_id";
  // The client's request-id shape, as an anchored regular-expression source. Optional: the publisher
  // falls back to the shared contract default when a project declares none.
  requestIdPattern?: string;
  // F1 (T-2, run_1785352838155_l544ye): the object_type argument object_contract needs (e.g.
  // "content_item"). Lets the conductor prefetch and reduce a client's contract deterministically,
  // in code, before dispatching contract_intelligence — instead of the node discovering it itself via
  // a tool call inside its own (expensive, per-turn-compounding) agent loop. Absent for a project that
  // has not declared one; contractPrefetch.ts falls back to a run-supplied clientObjectType, then to
  // the pipeline's current single-client-family default ("content_item") — see that file for why.
  defaultObjectType?: string;
};

export type ProjectPublishingPolicy = {
  // Go-live 2026-07-31 (operator decision, Wolf): publishing is enabled by default. The per-project
  // env kill-switch <CLIENT>_PUBLISH_ENABLED=false remains available to force a project off.
  publishEnabled: boolean;
  requiresExplicitPublish: boolean;
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
  // Legacy allow-list. Still honored (a tool listed here resolves to "allowed"), but the three-state
  // policy below is the richer control; toolPolicies overrides an allowedTools entry.
  allowedTools: string[];
  // Fallback permission for any remote tool not named in allowedTools or toolPolicies. Absent means
  // "blocked" (deny-all), preserving the original posture. Set to "allowed" for full-access clients.
  defaultToolPolicy?: ToolPermission;
  // Explicit per-tool overrides. Highest precedence — wins over allowedTools and defaultToolPolicy.
  toolPolicies?: Record<string, ToolPermission>;
  contentContract: ProjectContentContract;
  // Per-site parameters of the object-native publish dialect. Absent for clients that do not publish
  // through the object substrate — a publish hook that needs one and finds none must refuse rather
  // than substitute a default.
  objectDialect?: ProjectObjectDialect;
  publishingPolicy: ProjectPublishingPolicy;
  status: ProjectStatus;
};

// Resolve the effective permission for a tool. Precedence, highest first:
//   1. toolPolicies[tool]  (explicit override)
//   2. allowedTools includes tool  -> "allowed"  (legacy allow-list)
//   3. defaultToolPolicy   (client-wide fallback)
//   4. "blocked"           (deny-all default)
export function effectiveToolPermission(
  config: Pick<ProjectConnectionConfig, "allowedTools" | "defaultToolPolicy" | "toolPolicies">,
  toolName: string
): ToolPermission {
  const explicit = config.toolPolicies?.[toolName];
  if (explicit) return explicit;
  if (config.allowedTools.includes(toolName)) return "allowed";
  return config.defaultToolPolicy ?? "blocked";
}

// Flatten a config's policy into a complete per-tool map (allowedTools folded in as "allowed", then
// toolPolicies overriding). Used by the safe summary so callers can render effective state without
// re-deriving precedence. Does not include the client-wide default — that travels as defaultToolPolicy.
export function toToolPolicyMap(
  config: Pick<ProjectConnectionConfig, "allowedTools" | "toolPolicies">
): Record<string, ToolPermission> {
  const map: Record<string, ToolPermission> = {};
  for (const tool of config.allowedTools) map[tool] = "allowed";
  for (const [tool, permission] of Object.entries(config.toolPolicies ?? {})) map[tool] = permission;
  return map;
}

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
  // Client-wide fallback permission and the flattened per-tool policy map. Together with the remote
  // tool list (project.list_tools) these let the UI render every tool's effective permission.
  defaultToolPolicy: ToolPermission;
  toolPolicies: Record<string, ToolPermission>;
  contentContract: ProjectContentContract;
  publishingPolicy: ProjectPublishingPolicy;
  status: ProjectStatus;
  connection: ProjectConnectionState;
};
