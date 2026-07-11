import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ChangeRepository } from "../interfaces/ChangeRepository.js";
import type { WorkspaceChangeEvent, WorkspaceChangeFilters, WorkspaceChangePage, WorkspaceChangeRecordInput, WorkspaceRevision } from "../../workspace/changeTypes.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Cursor = { createdAt: string; eventId: string };
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
const decodeCursor = (cursor: string): Cursor | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed?.createdAt === "string" && typeof parsed?.eventId === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// Newest-first ordering with a stable eventId tiebreaker so pagination never skips or repeats.
const compareEventsDesc = (a: WorkspaceChangeEvent, b: WorkspaceChangeEvent) =>
  b.createdAt.localeCompare(a.createdAt) || b.eventId.localeCompare(a.eventId);

export const filterAndPageEvents = (all: WorkspaceChangeEvent[], filters: WorkspaceChangeFilters = {}): WorkspaceChangePage => {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : undefined;
  const sorted = [...all].sort(compareEventsDesc);
  const filtered = sorted.filter((event) =>
    (!filters.nodeId || (event.target.type === "node" && event.target.id === filters.nodeId)) &&
    (!filters.operation || event.operation === filters.operation) &&
    (!filters.actorKind || event.actor.kind === filters.actorKind) &&
    (!filters.source || event.source === filters.source) &&
    (!filters.from || event.createdAt >= filters.from) &&
    (!filters.to || event.createdAt <= filters.to) &&
    // Cursor marks the last event of the previous page; resume strictly after it.
    (!cursor || compareEventsDesc(event, { createdAt: cursor.createdAt, eventId: cursor.eventId } as WorkspaceChangeEvent) > 0)
  );
  const page = filtered.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: structuredClone(page),
    nextCursor: filtered.length > limit && last ? encodeCursor({ createdAt: last.createdAt, eventId: last.eventId }) : undefined
  };
};

// Per-instance storage: the change history lives and dies with the RepositoryManager that owns
// it, matching MemoryWorkspaceRepository isolation (a fresh manager gets a fresh workspace AND a
// fresh history). Serves both the memory and json backends, like the other memory repositories.
export class MemoryChangeRepository implements ChangeRepository {
  private readonly events: WorkspaceChangeEvent[] = [];
  private readonly revisions = new Map<string, WorkspaceRevision>();

  constructor(private readonly backend: "memory" | "json" = "memory") {}

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }

  async record(input: WorkspaceChangeRecordInput) {
    if (input.revision) this.revisions.set(input.revision.revisionId, structuredClone(input.revision));
    this.events.push(structuredClone(input.event));
  }

  async listEvents(filters: WorkspaceChangeFilters = {}) {
    return filterAndPageEvents(this.events, filters);
  }

  async getEvent(eventId: string) {
    const event = this.events.find((candidate) => candidate.eventId === eventId);
    return event ? structuredClone(event) : undefined;
  }

  async getRevision(revisionId: string) {
    const revision = this.revisions.get(revisionId);
    return revision ? structuredClone(revision) : undefined;
  }

  async listRevisions() {
    return [...this.revisions.values()].sort((a, b) => a.workspaceVersion - b.workspaceVersion).map((revision) => structuredClone(revision));
  }
}
