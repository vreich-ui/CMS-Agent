// Framework-free model for the change ledger (History surface). Pure data → data, root-testable.
//
// Vision commitments this encodes: every event answers who/why/when/what; actors are never
// assumed human; progressive disclosure (rows stay minimal, detail is derived on demand); restore
// is append-only and gated to targets the backend can actually restore.

import type {
  RevisionDiff,
  WorkspaceActorKind,
  WorkspaceChangeEvent,
  WorkspaceChangeOperation
} from "./types/workspace.js";

// Friendly titles for known fine-grained event types; anything unknown humanizes honestly
// instead of being hidden.
const typeTitles: Record<string, string> = {
  "node.created": "Created node",
  "node.updated": "Updated node",
  "node.deleted": "Deleted node",
  "node.cloned": "Cloned node",
  "node.restored": "Restored node",
  "node.prompt_updated": "Updated prompt",
  "node.schema_updated": "Updated schema",
  "node.input_schema_updated": "Updated input schema",
  "node.output_schema_updated": "Updated output schema",
  "node.dependencies_updated": "Updated dependencies",
  "node.tools_updated": "Updated tools",
  "node.skills_updated": "Updated skills",
  "node.model_config_updated": "Updated model config",
  "graph.updated": "Updated graph",
  "graph.reordered": "Reordered graph",
  "workspace.relationships_updated": "Updated relationships",
  "workspace.imported": "Imported workspace",
  "skill.assigned": "Assigned skill",
  "skill.unassigned": "Unassigned skill"
};

const humanizeType = (type: string) => {
  const tail = type.split(".").pop() ?? type;
  const text = tail.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const asNamed = (value: unknown): { name?: string } | null =>
  value && typeof value === "object" ? value as { name?: string } : null;

export type ChangeEventView = {
  eventId: string;
  title: string;
  entityLabel: string;
  actorKind: WorkspaceActorKind;
  actorLabel: string;
  sourceLabel: string;
  when: string;
  reason?: string;
  workspaceVersion: number;
  runId?: string;
  structural: boolean;
};

// Deterministic UTC timestamp label. History is the one surface where times are always relevant
// (vision ▸ History), so the ledger shows them plainly instead of hiding them.
export function formatChangeTime(iso: string): string {
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

export function describeChangeEvent(event: WorkspaceChangeEvent): ChangeEventView {
  const named = asNamed(event.after) ?? asNamed(event.before);
  // Non-node targets without an id get no entity label — the title already names them
  // ("Updated graph · graph" would be redundant noise).
  const entityLabel = event.target.type === "node"
    ? (named?.name ?? event.target.id ?? "node")
    : event.target.id ?? "";
  return {
    eventId: event.eventId,
    title: typeTitles[event.type] ?? humanizeType(event.type),
    entityLabel,
    actorKind: event.actor.kind,
    actorLabel: event.actor.label ?? event.actor.id ?? event.actor.kind,
    sourceLabel: event.source,
    when: formatChangeTime(event.createdAt),
    reason: event.reason,
    workspaceVersion: event.workspaceVersion,
    runId: event.correlation?.runId,
    // A mutation changed structural state only when it minted a new revision.
    structural: Boolean(event.resultingRevisionId) && event.resultingRevisionId !== event.parentRevisionId
  };
}

export type ChangeLedgerFilters = {
  actorKind?: WorkspaceActorKind;
  operation?: WorkspaceChangeOperation;
};

export const actorKindOptions: ReadonlyArray<{ value: WorkspaceActorKind | ""; label: string }> = [
  { value: "", label: "All actors" },
  { value: "human", label: "Human" },
  { value: "agent", label: "Agent" },
  { value: "system", label: "System" }
];

export const operationOptions: ReadonlyArray<{ value: WorkspaceChangeOperation | ""; label: string }> = [
  { value: "", label: "All operations" },
  { value: "create", label: "Create" },
  { value: "update", label: "Update" },
  { value: "delete", label: "Delete" },
  { value: "clone", label: "Clone" },
  { value: "reorder", label: "Reorder" },
  { value: "restore", label: "Restore" },
  { value: "import", label: "Import" },
  { value: "record", label: "Record" }
];

// Arguments for changes.list: only set filters actually chosen, so the server default view stays
// the complete ledger.
export function listChangesArgs(filters: ChangeLedgerFilters, limit: number, cursor?: string): Record<string, unknown> {
  return {
    limit,
    ...(cursor ? { cursor } : {}),
    ...(filters.actorKind ? { actorKind: filters.actorKind } : {}),
    ...(filters.operation ? { operation: filters.operation } : {})
  };
}

// An event's diff is derivable when it minted a revision and has a parent to compare against.
export function diffRange(event: WorkspaceChangeEvent): { fromRevisionId: string; toRevisionId: string } | null {
  if (!event.resultingRevisionId || !event.parentRevisionId) return null;
  if (event.resultingRevisionId === event.parentRevisionId) return null;
  return { fromRevisionId: event.parentRevisionId, toRevisionId: event.resultingRevisionId };
}

export type ChangedFieldSummary = {
  targetFields: string[];
  otherChangedNodes: number;
  addedNodes: string[];
  removedNodes: string[];
  relationshipChanges: number;
};

// Field chips for the expanded event. updatedAt is excluded: the store stamps it on every
// mutation, so it is noise, not signal (stated in the UI as "plus timestamps").
export function summarizeDiff(diff: RevisionDiff, targetNodeId?: string): ChangedFieldSummary {
  const changedForTarget = targetNodeId ? diff.nodes.changed.find((entry) => entry.nodeId === targetNodeId) : undefined;
  const targetFields = (changedForTarget?.changedFields ?? []).filter((field) => field !== "updatedAt");
  const otherChangedNodes = diff.nodes.changed.filter((entry) => {
    if (targetNodeId && entry.nodeId === targetNodeId) return false;
    return entry.changedFields.some((field) => field !== "updatedAt");
  }).length;
  return {
    targetFields,
    otherChangedNodes,
    addedNodes: diff.nodes.added.map((node) => node.id),
    removedNodes: diff.nodes.removed.map((node) => node.id),
    relationshipChanges: diff.relationships.added.length + diff.relationships.removed.length + diff.relationships.changedIds.length
  };
}

// changes.restore restores ONE NODE from a revision snapshot. Gate: node-targeted structural
// events whose resulting revision contains the node's state at that point.
export function restoreTarget(event: WorkspaceChangeEvent): { revisionId: string; nodeId: string } | null {
  if (event.target.type !== "node" || !event.target.id) return null;
  if (!event.resultingRevisionId || event.resultingRevisionId === event.parentRevisionId) return null;
  // A deletion's resulting revision no longer contains the node; restoring the pre-delete state
  // means restoring from the parent revision instead.
  if (event.operation === "delete") {
    return event.parentRevisionId ? { revisionId: event.parentRevisionId, nodeId: event.target.id } : null;
  }
  return { revisionId: event.resultingRevisionId, nodeId: event.target.id };
}

export type RecentChangesSummary = {
  total: number;
  byActor: Record<WorkspaceActorKind, number>;
  latest?: ChangeEventView;
};

// Overview Layer-2 awareness: recent change activity with attribution, citing the latest event.
export function summarizeRecentChanges(events: WorkspaceChangeEvent[]): RecentChangesSummary {
  const byActor: Record<WorkspaceActorKind, number> = { human: 0, agent: 0, system: 0 };
  for (const event of events) byActor[event.actor.kind] += 1;
  return {
    total: events.length,
    byActor,
    latest: events.length > 0 ? describeChangeEvent(events[0]) : undefined
  };
}
