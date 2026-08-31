import type { ExecutionStatus, WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

// Thrown by saveRun when the stored run has advanced past the revision the caller loaded, i.e. a
// concurrent writer committed in between. Callers reload the latest run and retry, so a completed
// node is never re-run and currentNodeId never regresses under overlapping calls.
export class RunConcurrencyError extends Error {
  constructor(public readonly runId: string, public readonly expectedRev: number, public readonly actualRev: number) {
    super(`Concurrent modification of run ${runId} (expected rev ${expectedRev}, found ${actualRev})`);
    this.name = "RunConcurrencyError";
  }
}

// W1.5 — the page window (status/time filters, cursor anchor, limit) is part of the REPOSITORY
// contract, not something layered on top of a full listing. That is the whole point: a backend that
// stores one blob per run (BlobExecutionRepository) can then decide WHICH run blobs to fetch before
// fetching any, instead of fetching the entire fleet and filtering in memory. Callers that genuinely
// need every run (constellation tools, node-scoped fallbacks) simply pass no limit/after.
export type RunSortKey = { startedAt: string; runId: string };

// Newest-first, runId as deterministic tiebreak so paging is stable across same-millisecond starts.
export const compareRunsNewestFirst = (a: RunSortKey, b: RunSortKey): number =>
  b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId);

export type ListRunsFilters = {
  projectId?: string;
  workflowId?: string;
  // Only runs with exactly this status.
  status?: ExecutionStatus;
  // Time-range filter on startedAt (ISO 8601, inclusive both ends).
  from?: string;
  to?: string;
  // Page anchor: only rows strictly after this sort key (newest-first) are returned. This is the
  // decoded form of workflow.list_runs' opaque cursor — encoding stays a caller concern.
  after?: RunSortKey;
  // Maximum rows to return. Undefined means "all matches" (the full-listing contract).
  limit?: number;
};

export type ListRunsPageResult = {
  runs: WorkflowExecutionRecord[];
  // Count of ALL rows matching the filters (ignoring `after`/`limit`), so pagination metadata does
  // not need a second query.
  matchedCount: number;
  // Whether matched rows exist after the returned window.
  hasMore: boolean;
};

// Shared windowing used by every repository (and the blob repository's index path): filter, sort
// newest-first, then apply the `after` anchor and `limit`. Working over any row shape that carries
// the filterable fields lets the blob backend window over cheap index ENTRIES before it has fetched
// a single run blob.
export const windowRunRows = <T extends RunSortKey & { projectId: string; workflowId: string; status: ExecutionStatus }>(
  rows: T[],
  filters: ListRunsFilters
): { window: T[]; matchedCount: number; hasMore: boolean } => {
  const matched = rows
    .filter((row) => !filters.projectId || row.projectId === filters.projectId)
    .filter((row) => !filters.workflowId || row.workflowId === filters.workflowId)
    .filter((row) => !filters.status || row.status === filters.status)
    .filter((row) => !filters.from || row.startedAt >= filters.from)
    .filter((row) => !filters.to || row.startedAt <= filters.to)
    .sort(compareRunsNewestFirst);
  const afterIndex = filters.after ? matched.findIndex((row) => compareRunsNewestFirst(filters.after!, row) < 0) : 0;
  const windowStart = afterIndex === -1 ? matched.length : afterIndex;
  const window = filters.limit === undefined ? matched.slice(windowStart) : matched.slice(windowStart, windowStart + Math.max(0, Math.floor(filters.limit)));
  return { window, matchedCount: matched.length, hasMore: windowStart + window.length < matched.length };
};

export interface ExecutionRepository {
  createRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  getRun(runId: string): Promise<WorkflowExecutionRecord | undefined>;
  // Full-record listing, newest first. All filters are optional; with no limit/after this returns
  // every match (constellation tools and internal callers depend on that).
  listRuns(filters?: ListRunsFilters): Promise<WorkflowExecutionRecord[]>;
  // Same filters, plus pagination metadata. workflow.list_runs delegates here so backends can apply
  // the window BEFORE fetching run payloads.
  listRunsPage(filters?: ListRunsFilters): Promise<ListRunsPageResult>;
  // Compare-and-swap persist. The run carries the `rev` it was loaded with; the write is committed
  // only if the stored record still has that `rev` (incrementing it on success) and otherwise
  // rejects with RunConcurrencyError. Node statuses, artifacts, stageOutputs and currentNodeId are
  // therefore persisted together, atomically, as one revision step.
  saveRun(run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  // Unconditionally replace the run with a fresh state, bumping `rev` so any in-flight saveRun that
  // still holds a pre-reset revision fails its CAS instead of restoring stale node state.
  resetRun(runId: string, nextRun: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  health(): Promise<RepositoryHealth>;
}
