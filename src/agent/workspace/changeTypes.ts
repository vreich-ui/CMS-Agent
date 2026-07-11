// Immutable workspace change-history types.
//
// Every supported workspace mutation produces a WorkspaceChangeEvent; a full WorkspaceRevision
// snapshot is minted only when the structural state (nodes/relationships) actually changed.
// History is append-only: restore applies an old snapshot as a NEW forward mutation and never
// deletes or rewrites existing records. Before/after values and revision snapshots are passed
// through key-based redaction before persistence so credential-shaped values never land in
// history records.

import type { WorkspaceNode, WorkspaceRiskLevel } from "./nodeTypes.js";
import type { WorkspaceRelationship } from "./relationshipTypes.js";

export const workspaceActorKinds = ["human", "agent", "system"] as const;
export type WorkspaceActorKind = typeof workspaceActorKinds[number];

// Attribution, not authorization: the server stamps defaults per entry path (secure proxy →
// human with identity email; direct MCP → agent; internal store writes → system), but a direct
// bearer-token caller can self-describe. Change records must never be treated as an access log.
export type WorkspaceActor = { kind: WorkspaceActorKind; id?: string; label?: string };

export const workspaceChangeSources = ["mcp", "ui", "system"] as const;
export type WorkspaceChangeSource = typeof workspaceChangeSources[number];

// Extensible: "edge" | "policy" | "memory" | "schema" | "theme" join later without a storage
// migration — the field is a plain string union in records already persisted.
export const workspaceChangeTargetTypes = ["node", "graph", "relationship", "workspace"] as const;
export type WorkspaceChangeTargetType = typeof workspaceChangeTargetTypes[number];
export type WorkspaceChangeTarget = { type: WorkspaceChangeTargetType; id?: string };

export const workspaceChangeOperations = ["create", "update", "delete", "clone", "reorder", "restore", "import", "record"] as const;
export type WorkspaceChangeOperation = typeof workspaceChangeOperations[number];

export type WorkspaceChangeCorrelation = { runId?: string; requestId?: string };

export type WorkspaceChangeEvent = {
  eventId: string;
  // The fine-grained event type, e.g. "node.prompt_updated"; operation is its coarse category.
  type: string;
  operation: WorkspaceChangeOperation;
  target: WorkspaceChangeTarget;
  actor: WorkspaceActor;
  source: WorkspaceChangeSource;
  reason?: string;
  baseRevisionId?: string;
  parentRevisionId?: string;
  // Equals parentRevisionId when the mutation changed no structural state (e.g. stage outputs).
  resultingRevisionId?: string;
  workspaceVersion: number;
  riskLevel?: WorkspaceRiskLevel;
  before?: unknown;
  after?: unknown;
  correlation?: WorkspaceChangeCorrelation;
  createdAt: string;
};

export type WorkspaceRevision = {
  revisionId: string;
  parentRevisionId?: string;
  workspaceVersion: number;
  createdAt: string;
  actor: WorkspaceActor;
  source: WorkspaceChangeSource;
  reason?: string;
  nodes: WorkspaceNode[];
  relationships: WorkspaceRelationship[];
};

export type WorkspaceChangeFilters = {
  nodeId?: string;
  operation?: WorkspaceChangeOperation;
  actorKind?: WorkspaceActorKind;
  source?: WorkspaceChangeSource;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

export type WorkspaceChangePage = { events: WorkspaceChangeEvent[]; nextCursor?: string };

export type WorkspaceChangeRecordInput = { revision?: WorkspaceRevision; event: WorkspaceChangeEvent };

// Store-facing sink implemented by the ChangeRepository. Keeps WorkspaceStateStore
// storage-agnostic: the store records history through this interface and never imports a
// concrete repository.
export interface WorkspaceChangeSink {
  record(input: WorkspaceChangeRecordInput): Promise<void>;
  listRevisions(): Promise<WorkspaceRevision[]>;
}
