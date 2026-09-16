export const workspaceRiskLevels = ["read", "write", "publish", "admin"] as const;
export type WorkspaceRiskLevel = typeof workspaceRiskLevels[number];

export const workspaceNodeStatuses = ["draft", "active", "deprecated"] as const;
export type WorkspaceNodeStatus = typeof workspaceNodeStatuses[number];

export type WorkspaceNodePosition = { x: number; y: number };

// K-A9 — re-exported from nodeExecution.ts, which owns the derivation and the fail-open rules. The
// types live there rather than here because the store has to derive them at parse time and this
// module is the one every layer already imports.
export type { NodeExecutionKind, NodeRoute } from "./nodeExecution.js";
import type { NodeExecutionKind, NodeRoute } from "./nodeExecution.js";

export type WorkspaceNode = {
  id: string;
  name: string;
  kind: string;
  description: string;
  prompt: string;
  /** @deprecated outputSchema is canonical. schema remains as a legacy import/export alias and is migrated to outputSchema on load/mutation. */
  schema?: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  allowedTools: string[];
  assignedSkills?: string[];
  requiredInputs: string[];
  produces: string[];
  riskLevel: WorkspaceRiskLevel;
  dependsOn: string[];
  status: WorkspaceNodeStatus;
  position: WorkspaceNodePosition;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  executionConfig?: Record<string, unknown>;
  // node-default-output (2026-09-15) — THE NODE'S STANDING OUTPUT, used in place of running it.
  //
  // STORE-OWNED, deliberately. It is not in executor.ts's CANONICAL_OWNED_FIELDS and must never join
  // it: a default is an operator's fixture for one workspace, not a property of the composition, so it
  // is authored through workspace.update_node_default_output, survives a re-seed, and is invisible to
  // `npm run nodes:update` / the #348 drift gate for exactly the same reason prompt and outputSchema
  // are. overlayStoreNode (executor.ts) carries it onto the dispatched node so a run can read it.
  //
  // `value` is the output itself, in the shape the node's own outputSchema declares. `schemaValidAt`
  // is the timestamp the value last validated against that schema, or NULL when it was saved over a
  // schema failure with `force: true` — the operator is the authority and a schema can be wrong, but
  // the record says which of the two happened. Absent (undefined) never means "valid": it means the
  // field predates this stamp.
  defaultOutput?: NodeDefaultOutput;
  // K-A9 (2026-09-16) — HOW THIS NODE RUNS, as a stored field instead of a metadata flag.
  //
  // STORE-OWNED, like prompt/outputSchema/modelConfig, and NOT in CANONICAL_OWNED_FIELDS: a node's
  // route is authored, promoted and re-seeded exactly as those are. What changed is that it is no
  // longer carried inside `metadata`, which `workspace.update_node_metadata` replaces wholesale — so
  // a metadata write can no longer flip a tail node off its deterministic route by omission (K-A9)
  // or by setting the old flag `false` (K-A1). `workspace.update_node_execution` is the one verb
  // that changes it.
  //
  // ABSENT IS NOT "model". Both fields are optional and undefined means "this row predates the
  // field", which resolves through the legacy metadata scan exactly as before — see
  // nodeExecution.ts's resolveNodeExecution. An explicit `executionKind: "model"` is a different and
  // much stronger statement: it SUPPRESSES any route metadata the row also carries.
  executionKind?: NodeExecutionKind;
  route?: NodeRoute;
};

export type NodeDefaultOutputAuthor = "human" | "agent" | "system";

export type NodeDefaultOutput = {
  value: unknown;
  note?: string;
  updatedAt: string;
  updatedBy: NodeDefaultOutputAuthor;
  /** ISO timestamp of the last successful validation against the node's outputSchema; null when saved with `force`. */
  schemaValidAt?: string | null;
};

export type WorkspaceEvent = { id: string; type: string; nodeId?: string; actor?: string; summary?: string; workspaceVersion: number; beforeHash?: string; afterHash?: string; createdAt: string };
export type WorkspaceVersionSnapshot = { workspaceVersion: number; createdAt: string; summary?: string; nodes: WorkspaceNode[] };

export type WorkspaceGraphValidation = { valid: true; issues: [] } | { valid: false; issues: string[] };
