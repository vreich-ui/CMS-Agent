// Per-project hook registry: the ONLY sanctioned place client-specific behavior attaches to the
// generic workspace. A project may contribute
//   - validateHandoffPolicy: extra policy findings layered onto the structural handoff validation
//     (project.validate_handoff), e.g. Dr. Lurie's artifact/rendering rules;
//   - knowledge: safe, non-secret structured guidance surfaced on project.get so agents can learn
//     a client's rules without reading its codebase.
// Hooks are code (functions can't live in the persisted ProjectConnectionConfig), registered here
// by projectId. The workspace core consumes hooks only through getProjectHooks — it never imports
// from a client folder directly.

import type { ArtifactPolicyWarning } from "./drLurie/artifactPolicy.js";
import type { PublishReadinessInput, PublishReadinessResult } from "./drLurie/publishReadiness.js";
import { drLurieProjectHooks } from "./drLurie/hooks.js";
import { platformProjectHooks } from "./platform/hooks.js";

export type ProjectPolicyFinding = ArtifactPolicyWarning;

export type ProjectHandoffPayload = { contentSource?: unknown; articleBody?: unknown };

export type ProjectCallToolRequest = { tool: string; arguments?: Record<string, unknown> };

// Re-exported so the generic publisher can consume readiness types without importing a client folder.
export type { PublishReadinessInput, PublishReadinessResult } from "./drLurie/publishReadiness.js";

// Everything a project's publish executor may rely on: the generic publisher resolves and validates
// the run, evaluates gates/readiness, and then hands EXECUTION to the project hook — each client
// publishes in its own tool dialect, and the publisher never guesses one client's dialect for another.
export type PublishExecutionContext = {
  requestId: string;                      // run correlation ONLY — never used as an object id
  envelope: Record<string, unknown>;      // the full article_body envelope
  body: Record<string, unknown>;          // the client object (envelope.body)
  clientObjectType: string;               // envelope.clientObjectType, passed through VERBATIM
  publishedTime: string | null;
  owner: { owner_id: string; owner_label: string };
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>; // records a step; throws on tool failure
};
export type PublishExecutionOutcome = {
  result: unknown;
  objectId?: string;                      // server-minted id when the dialect mints one
  clientValidation?: { tool: string; candidate_patch_summary: string; valid: boolean; issues: unknown[] };
};

export type ProjectHooks = {
  // Returns findings; severity "error" marks the handoff invalid, "warning" is advisory.
  validateHandoffPolicy?: (payload: ProjectHandoffPayload) => ProjectPolicyFinding[];
  // Executable call-tool policy layered on top of the config permission model: given the tool name
  // and arguments about to be forwarded, returns findings. Any "error" finding blocks the call
  // before any remote transport, even when the config marks the tool "allowed".
  enforceCallToolPolicy?: (call: ProjectCallToolRequest) => ProjectPolicyFinding[];
  // Project GO/NO-GO readiness gate over a publish request, evaluated by the generic publisher. A
  // NO-GO (blocked_for_publish_execution) is an expected safety state, not a failure. Projects
  // without this hook are not subject to any extra publish-readiness constraints.
  evaluatePublishReadiness?: (input: PublishReadinessInput) => PublishReadinessResult;
  // The tool names of the project's publish dialect, in order, for plan display (dry runs and the
  // live plan). Purely descriptive — execution is executePublish below.
  publishToolSequence?: string[];
  // Execute a live publish in the CLIENT's own tool dialect. The generic publisher calls this only
  // after every gate and the readiness policy pass; a project without this hook cannot publish
  // (no_publish_executor) — the publisher never falls back to another client's dialect.
  executePublish?: (ctx: PublishExecutionContext) => Promise<PublishExecutionOutcome>;
  // Safe, non-secret structured guidance for agents (rules, conventions, pitfalls).
  knowledge?: unknown;
};

const hooksByProjectId: Record<string, ProjectHooks> = {
  "dr-lurie": drLurieProjectHooks,
  "platform": platformProjectHooks
};

export const getProjectHooks = (projectId: string): ProjectHooks | undefined => hooksByProjectId[projectId];
