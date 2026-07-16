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
import { drLurieProjectHooks } from "./drLurie/hooks.js";

export type ProjectPolicyFinding = ArtifactPolicyWarning;

export type ProjectHandoffPayload = { contentSource?: unknown; articleBody?: unknown };

export type ProjectCallToolRequest = { tool: string; arguments?: Record<string, unknown> };

export type ProjectHooks = {
  // Returns findings; severity "error" marks the handoff invalid, "warning" is advisory.
  validateHandoffPolicy?: (payload: ProjectHandoffPayload) => ProjectPolicyFinding[];
  // Executable call-tool policy layered on top of the config permission model: given the tool name
  // and arguments about to be forwarded, returns findings. Any "error" finding blocks the call
  // before any remote transport, even when the config marks the tool "allowed".
  enforceCallToolPolicy?: (call: ProjectCallToolRequest) => ProjectPolicyFinding[];
  // Safe, non-secret structured guidance for agents (rules, conventions, pitfalls).
  knowledge?: unknown;
};

const hooksByProjectId: Record<string, ProjectHooks> = {
  "dr-lurie": drLurieProjectHooks
};

export const getProjectHooks = (projectId: string): ProjectHooks | undefined => hooksByProjectId[projectId];
