// Operation catalog kernel (A2; ADR pending — see coordinator contract "operation-catalog").
//
// THIS MODULE IS A CONTRACT, NOT AN ENGINE. It defines the shape of an "operation" — a named,
// versioned, human-describable unit of work a later task (A6-A9) will actually implement — and the
// shapes preflight discovery reports about one. Nothing here executes anything, calls a tenant,
// mutates the workspace, or grants authority. See AGENTS.md invariant 4/5: publish authority is
// `resolvePublishAuthority(run)`, node grants, and tool policy — exactly where it already lives.
// An operation DECLARING an effect in its `effects` array is a description of what running it would
// eventually do, once an executor exists to run it; declaring an effect grants nothing by itself,
// checks nothing, and authorizes nothing. Do not read any type or value in this module as an
// authorization, and do not wire a `riskLevel` here into a gate — the only risk levels that gate
// anything are the ones already on a WorkspaceNode.
import type { WorkspaceRiskLevel } from "../workspace/nodeTypes.js";

export { validateReference, objectRefSchema, assetRefSchema, templateRefSchema, assetRefKinds } from "./operationReferences.js";
export type { AssetRef, ObjectRef, OperationReference, TemplateRef, ReferenceValidation } from "./operationReferences.js";

// snake_case, stable across versions — the identity a caller pins ("run operation X"), independent
// of `version`. Enforced at registration time (operationCatalog.ts), not by the type system.
export type OperationId = string;
export const OPERATION_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

// One declared effect an operation would have if run. `riskLevel` reuses the SAME enum a
// WorkspaceNode carries (`../workspace/nodeTypes.js`) rather than a parallel one, so a reader never
// has to reconcile two risk vocabularies — but reuse is only of the vocabulary: a node's own
// riskLevel is what an executor's dispatch actually gates on, not anything declared here.
export type OperationEffect = {
  kind: string;
  targetType: string;
  riskLevel: WorkspaceRiskLevel;
  description: string;
};

// A structured, non-fatal-by-default finding. `blocking: true` means preflight would refuse to let
// this operation proceed as specified; `blocking: false` is an advisory a caller may act on or
// ignore. `remedy` is REQUIRED and must name a concrete next action — never "contact support" or
// "check configuration" — matching the discipline skillResolver.ts's SkillConflict messages already
// hold (name what's wrong AND what would fix it, in the same structured record, not a bare code).
export type OperationBlocker = {
  code: string;
  message: string;
  remedy: string;
  blocking: boolean;
  evidence?: Record<string, unknown>;
};

// A capability an operation needs that this tenant/deployment has not made available. `reason` says
// WHY: not_configured (nobody has set it up yet — the common case), not_supported (this tenant's
// dialect/hooks never offer it), unavailable (configured but currently down/unreachable — reported
// only where a caller supplies that fact; THIS MODULE NEVER PROBES TO FIND OUT — see
// operationPreflight.ts's header). A gap is discovered by reading what is already declared
// (configuredCapabilities, a project's hooks, an env flag) — never by attempting the write and
// seeing whether it fails.
export type OperationCapabilityGap = {
  capability: string;
  requiredBy: OperationId;
  reason: "not_configured" | "not_supported" | "unavailable";
  evidence: Record<string, unknown>;
  remedy: string;
};

// One thing that would have to be true, evidenced by a real receipt, for a run of this operation to
// count as complete. `evidenceKind` names the receipt kind a later executor (A6-A9) is expected to
// produce and an evaluator would read back — completion is PROJECTED FROM RECEIPTS an executor
// actually wrote, never accepted on a model's own say-so that it finished.
export type OperationCompletionCheck = {
  id: string;
  description: string;
  evidenceKind: string;
};

// The full descriptor an operation registers under (operationCatalog.ts). `defaults` are EXPLICIT
// on purpose: preflight echoes back every default it applied (operationPreflight.ts's
// `appliedDefaults`), so nothing this operation would have silently chosen is ever invisible to the
// caller deciding whether to proceed.
export type OperationDescriptor = {
  operationId: OperationId;
  version: number;
  title: string;
  summary: string;
  surface?: "web" | "pdf" | null;
  inputSchema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  requiredCapabilities: string[];
  effects: OperationEffect[];
  completion: OperationCompletionCheck[];
  intentKeywords: string[];
};
