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
  // GUI rework Session B: the object id of this project's governed `editorial_voice` singleton (e.g.
  // "voice_drlurie"), fetched via object_get {object_type:"editorial_voice", object_id}. Lets the
  // conductor prefetch the client's live voice deterministically, once per run, before dispatching a
  // voice-consuming node — mirroring defaultObjectType's F1 pattern so this never repeats
  // contract_intelligence's per-turn-refetch cost mistake. Absent for a project that has not declared
  // one; voicePrefetch.ts then falls back to that project's own seeded voice (if any hook module
  // declares one) rather than guessing an id.
  voiceObjectId?: string;
};

// Durable, non-secret identity of a client site provisioned by site genesis. This is deliberately
// separate from project status: disabling a client pauses normal work but must not hide its site
// from credential rotation/reconciliation. Internal projects do not carry this marker.
export type ClientSiteBinding = {
  netlifySiteName: string;
  netlifySiteId?: string;
};

export type ProjectPublishingPolicy = {
  // Go-live 2026-07-31 (operator decision, Wolf): publishing is enabled by default. The per-project
  // env kill-switch <CLIENT>_PUBLISH_ENABLED=false remains available to force a project off.
  publishEnabled: boolean;
  requiresExplicitPublish: boolean;
  description: string;
  // T2 (2026-08-13, run_1786557897658_elj34j): whether a NEW run for this project starts with the
  // operator's durable publish decision (run.operatorPublishDecision, publishDecision.ts) already
  // "approved". ABSENT is "require_explicit" — today's exact behavior, unchanged: a run starts with
  // no operator decision and every publish-risk node/publishRun stays refused until
  // workflow.set_operator_publish_decision is called. "approved" is a PER-PROJECT convenience for a
  // client that has pre-authorized standing publishes; it never sets the decision to "withheld" (an
  // operator veto is only ever explicit, see executor.ts applyOperatorPublishPolicyDefault), and an
  // explicit "withheld" set at any time always overrides it. The decision this produces is recorded
  // with operatorDecisionSource "project_policy_default" so a receipt can never be misread as
  // explicit operator sign-off (see publishDecision.ts describeOperatorDecisionSource).
  operatorDefault?: "approved" | "require_explicit";
};

// Capture is intentionally governed per project. A missing policy resolves to the deny-all value
// below, so a newly introduced capture workflow cannot widen a legacy project's authority.
export type ProjectCapturePolicy = {
  maxPages: number;
  allowedCrawlOrigins: string[];
  allowedPathPrefixes: string[];
  sameOriginOnly: boolean;
  respectRobots: boolean;
  concurrency: number;
  delayMs: number;
  authenticatedAccess: "prohibited";
  rights: {
    content: "prohibited" | "retain_allowed_origin_content";
    media: "prohibited" | "retain_referenced_allowed_origin_media";
  };
  designReferences: Array<{
    origin: string;
    purpose: "design_inspiration_only";
    crawlAllowed: false;
    contentReuse: "prohibited";
    mediaReuse: "prohibited";
  }>;
  fidelity: {
    mode: "source_faithful" | "design_inspired";
    sourceDesignTreatment: "source_content_and_design" | "source_content_with_design_inspiration_only";
    // Omitted means the pipeline's global coverage rubric applies.
    coverageRubricOverride?: {
      minimumMappedBlockCoverage: number;
      requireCompleteTokens: boolean;
      requireEnumeratedGaps: boolean;
    };
  };
};

// Deliberate fail-closed fallback for legacy persisted records and new registrations. No capture is
// permitted until a project explicitly declares its source scope.
export const DEFAULT_PROJECT_CAPTURE_POLICY: ProjectCapturePolicy = {
  maxPages: 0,
  allowedCrawlOrigins: [],
  allowedPathPrefixes: [],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 1500,
  authenticatedAccess: "prohibited",
  rights: { content: "prohibited", media: "prohibited" },
  designReferences: [],
  fidelity: { mode: "source_faithful", sourceDesignTreatment: "source_content_and_design" }
};

export function resolveProjectCapturePolicy(config: Pick<ProjectConnectionConfig, "capturePolicy">): ProjectCapturePolicy {
  return structuredClone(config.capturePolicy ?? DEFAULT_PROJECT_CAPTURE_POLICY);
}

export type ProjectConnectionConfig = {
  projectId: string;
  clientSiteBinding?: ClientSiteBinding;
  // Monotonic code-definition version used to safely migrate persisted default project records.
  definitionVersion?: number;
  name: string;
  // The bearer TOKEN is resolved from an environment variable at connection time and is NEVER
  // persisted or returned, so no project secret is stored in workspace JSON / blobs.
  //
  // The ENDPOINT has two sources, in this precedence (resolveProjectConnection):
  //   1. env[mcpEndpointEnvVar]  — the original channel; still wins whenever it is populated, so
  //      every project registered before mcpEndpoint existed resolves EXACTLY as it did, and an
  //      operator keeps a no-registry-write break-glass override (e.g. repointing a tenant at a new
  //      custom domain) on a deployment they can already edit.
  //   2. mcpEndpoint             — the endpoint stored ON the record (below).
  mcpEndpointEnvVar: string;
  // The tenant's MCP endpoint URL stored directly on the registry record, so minting a tenant does
  // not require hand-adding a <CLIENT>_MCP_ENDPOINT env var to this deployment (Wolf, 2026-08-18).
  //
  // Why this is NOT a hole in "secrets: env var NAMES over MCP, never values": an endpoint URL is
  // not a secret — the TOKEN is, and it stays an env var NAME reference (tokenEnvVar) exactly as
  // before. The fleet already treats these URLs as public configuration: cloudbuild.deploy.yaml
  // carries every tenant's endpoint in plaintext --update-env-vars while every token travels
  // through --update-secrets from Secret Manager.
  //
  // The original rule (commit ab700cf) rejected endpoint VALUES because a URL string can smuggle a
  // credential — https://user:pass@host/mcp, or ?token=… — not because the endpoint itself is
  // sensitive. That vector is closed structurally instead of by blanket refusal: projectAdmin's
  // registryEndpointSchema accepts only https, no userinfo, no query, no fragment, so a stored
  // endpoint is provably credential-free and therefore safe to persist AND to return to callers.
  mcpEndpoint?: string;
  authMode: ProjectAuthMode;
  tokenEnvVar?: string;
  // The tenant's bearer TOKEN, resolved ENV FIRST, RECORD SECOND — the same precedence mcpEndpoint
  // above uses, and for the same reason (T12.20). This field holds a Secret Manager VERSION
  // RESOURCE NAME, never a value:
  //   projects/<project>/secrets/<name>/versions/<latest|N>
  //
  // Why a reference is not a secret: it grants nothing. Reading it requires
  // roles/secretmanager.secretAccessor on the READING PLANE'S OWN identity — an IAM decision made
  // once, outside this system, revocable without a registry write. That is exactly what an env var
  // NAME has always been: a pointer whose dereference is authorized elsewhere.
  //
  // What it buys: a new tenant needs ONE secret created at genesis and no deployment edit anywhere,
  // and a NEW PLANE inherits every tenant automatically. The alternative cost us a day — the
  // continuation-tick Cloud Run job silently carried no tenant tokens and failed roughly half of all
  // node executions while the service beside it succeeded.
  tokenSecretRef?: string;
  // Legacy allow-list. Still honored (a tool listed here resolves to "allowed"), but the three-state
  // policy below is the richer control; toolPolicies overrides an allowedTools entry.
  allowedTools: string[];
  // Fallback permission for any remote tool not named in allowedTools or toolPolicies. Absent means
  // "blocked" (deny-all), preserving the original posture. Set to "allowed" for full-access clients.
  defaultToolPolicy?: ToolPermission;
  // Explicit per-tool overrides. Highest precedence — wins over allowedTools and defaultToolPolicy.
  toolPolicies?: Record<string, ToolPermission>;
  contentContract: ProjectContentContract;
  // Optional only to represent legacy persisted records. Callers must use
  // resolveProjectCapturePolicy(), which denies all capture when it is absent.
  capturePolicy?: ProjectCapturePolicy;
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
// the endpoint/token are resolvable — never the token or headers.
export type ProjectConnectionState = {
  // True when an endpoint resolves from EITHER source (env var or the registry record) — the
  // question every caller actually asks ("can this project be reached?"). For a project with no
  // stored mcpEndpoint this is bit-for-bit the old env-only answer.
  endpointConfigured: boolean;
  tokenConfigured: boolean;
  mcpEndpointEnvVar: string;
  tokenEnvVar?: string;
  // Which source answered, so an operator can see WHY an endpoint is (or is not) configured:
  //   "env"      — the env var is populated and wins.
  //   "registry" — no env value; the record's own mcpEndpoint is in use.
  //   "unset"    — neither; the project is unreachable.
  endpointSource: "env" | "registry" | "unset";
  // Which source will answer for the TOKEN, mirroring endpointSource:
  //   "env"    — the token env var is populated on this plane and wins.
  //   "secret" — no env value; the record's tokenSecretRef will be read from Secret Manager.
  //   "unset"  — neither; the project is called without a bearer token.
  // NOTE this is a STATIC view: it reports which source is configured, not whether the read will
  // succeed. Secret Manager is only contacted on an actual call, so a safe metadata view never
  // performs a privileged read as a side effect. project.test_connection exercises the real path.
  tokenSource: "env" | "secret" | "unset";
  // The endpoint stored on the record, when there is one. Safe to return: it is validated
  // credential-free at write time (https, no userinfo, no query, no fragment). The env-var VALUE is
  // still never returned — an operator may have put anything in it.
  mcpEndpoint?: string;
  // The stored Secret Manager reference, when there is one. Safe to return for the same reason the
  // env var NAME is: it is a pointer, not a credential.
  tokenSecretRef?: string;
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
  capturePolicy: ProjectCapturePolicy;
  publishingPolicy: ProjectPublishingPolicy;
  status: ProjectStatus;
  connection: ProjectConnectionState;
};
