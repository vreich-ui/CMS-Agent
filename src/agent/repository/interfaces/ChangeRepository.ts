import type { RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceChangeEvent, WorkspaceChangeFilters, WorkspaceChangePage, WorkspaceChangeSink, WorkspaceRevision } from "../../workspace/changeTypes.js";

// Immutable workspace change history: append-only change events plus revision snapshots.
// Records are never updated or deleted; restore writes new records through the workspace store.
export interface ChangeRepository extends WorkspaceChangeSink {
  health(): Promise<RepositoryHealth>;
  listEvents(filters?: WorkspaceChangeFilters): Promise<WorkspaceChangePage>;
  getEvent(eventId: string): Promise<WorkspaceChangeEvent | undefined>;
  getRevision(revisionId: string): Promise<WorkspaceRevision | undefined>;
  listRevisions(): Promise<WorkspaceRevision[]>;
}
