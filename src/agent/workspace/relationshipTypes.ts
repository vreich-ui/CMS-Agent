// Typed relationships between agents (workspace nodes) for the Constellation.
//
// Relationships of every kind except "execution" are stored in the workspace document and
// therefore participate in revisions and change history automatically. Execution edges remain
// derived from node.dependsOn — the executor's single source of truth — and are returned to
// callers as DerivedExecutionEdge, never persisted as relationship records.

export const relationshipKinds = ["execution", "data", "memory", "policy", "evaluation", "approval"] as const;
export type RelationshipKind = typeof relationshipKinds[number];

export const relationshipDirections = ["forward", "bidirectional"] as const;
export type RelationshipDirection = typeof relationshipDirections[number];

export type WorkspaceRelationship = {
  id: string;
  kind: RelationshipKind;
  sourceId: string;
  targetId: string;
  direction: RelationshipDirection;
  label?: string;
  enabled: boolean;
  // Structural metadata only — interaction metrics live in the aggregation layer and are joined
  // onto relationships at read time, never stored here.
  metadata?: Record<string, unknown>;
  schemaRefs?: string[];
  artifactRefs?: string[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRelationshipCreate = Omit<WorkspaceRelationship, "createdAt" | "updatedAt" | "enabled" | "direction" | "id"> & {
  id?: string;
  direction?: RelationshipDirection;
  enabled?: boolean;
};

export type WorkspaceRelationshipsUpdate = {
  create?: WorkspaceRelationshipCreate[];
  update?: Array<Partial<Omit<WorkspaceRelationship, "id" | "createdAt" | "updatedAt">> & { id: string }>;
  delete?: string[];
};

export type DerivedExecutionEdge = { kind: "execution"; sourceId: string; targetId: string; derivedFrom: "dependsOn" };
