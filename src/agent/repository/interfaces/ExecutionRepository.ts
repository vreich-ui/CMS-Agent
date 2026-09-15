import { runStallFacts, type ExecutionStatus, type RunStallFacts, type WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
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
  // Only runs with exactly this status — or, given several, any of them. The array form
  // exists because "how many runs need a human right now" is one question, not three: the
  // Workbench's workflow cards would otherwise have to make one limit:1 counting call per
  // attention status per workflow just to read `matchedCount` off each.
  status?: ExecutionStatus | ExecutionStatus[];
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
  // The sort key of the last row the WINDOW covered, which is not always the last row returned:
  // a ghost entry is dropped after windowing. Paging is anchored on this so a page that returns
  // fewer rows than it matched still hands back a usable cursor.
  lastKey?: RunSortKey;
  // Count of ALL rows matching the filters (ignoring `after`/`limit`), so pagination metadata does
  // not need a second query.
  matchedCount: number;
  // Whether matched rows exist after the returned window.
  hasMore: boolean;
};

const statusMatches = (status: ExecutionStatus, filter: ListRunsFilters["status"]): boolean =>
  filter === undefined || (Array.isArray(filter) ? filter.includes(status) : status === filter);

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
    .filter((row) => statusMatches(row.status, filters.status))
    .filter((row) => !filters.from || row.startedAt >= filters.from)
    .filter((row) => !filters.to || row.startedAt <= filters.to)
    .sort(compareRunsNewestFirst);
  const afterIndex = filters.after ? matched.findIndex((row) => compareRunsNewestFirst(filters.after!, row) < 0) : 0;
  const windowStart = afterIndex === -1 ? matched.length : afterIndex;
  const window = filters.limit === undefined ? matched.slice(windowStart) : matched.slice(windowStart, windowStart + Math.max(0, Math.floor(filters.limit)));
  return { window, matchedCount: matched.length, hasMore: windowStart + window.length < matched.length };
};

// W4 — A RUN LIST ROW, without the run.
//
// A list row used to be built by opening the run record and stripping it down
// (summarizeRunForList): every row cost a blob GET, and still carried `nodes[]` — one entry
// per node, with statuses, timings, errors, warnings and bounded attempt history. Measured
// live on 2026-09-14 that was ~28KB per row and ~8s for twenty of them scoped to one project,
// 16s unscoped; the Runs page's first paint was dominated by data no row in a list ever
// displays.
//
// Everything an operator actually reads off a row — what it is, where it stopped, how far it
// got, whether it is stuck — is a handful of scalars. Persisted alongside the run index
// (which a listing already reads to decide WHICH runs to return), a page of rows costs no
// blob reads at all.
//
// Deliberately NOT here: cost. A WorkflowExecutionRecord carries no spend figure — only
// workflow.get_run_cost's ledger does — so there is nothing truthful to index, and a list
// row's cost stays unknown until the run is opened, exactly as it was before.
export type RunSummaryRecord = {
  runId: string;
  projectId: string;
  workflowId: string;
  status: ExecutionStatus;
  startedAt: string;
  updatedAt: string;
  requestId?: string;
  completedAt?: string;
  currentNodeId?: string;
  nodeCount: number;
  completedCount: number;
  failedCount: number;
  /** Run-level errors, counted. The strings themselves are a detail read. */
  errorCount: number;
  artifactCount: number;
  approvalsRequiredCount: number;
  // REVIEW FIX (round 2) — the ARRAY, not only its count. The old default row carried it, and
  // for a publishing platform it is the highest-value field on a listing: "which node is this run
  // waiting on" is the question an operator opens the list to answer. A consumer doing
  // `runs.flatMap(r => r.approvalsRequired.map(a => a.nodeId))` would have thrown on undefined,
  // and one doing `r.approvalsRequired?.length` would have reported zero pending approvals for
  // the whole fleet. It is bounded to one entry per pending gate — the same size class as the
  // scalars beside it, and nothing like the nodes[] array this projection exists to drop.
  approvalsRequired: WorkflowExecutionRecord["approvalsRequired"];
  dryRun: boolean;
  executionMode?: "mock" | "openai";
  rev?: number;
  budgetUsd?: number;
  // Review fix — these three were on the old default row (summarizeRunForList) and dropping them
  // from the new default would silently break every external reader of a LISTING: a consumer
  // testing `operatorPublishDecision === "approved"` would see undefined on every run and
  // conclude nothing was ever approved, without an error anywhere. They are single scalars, so
  // carrying them costs the index nothing.
  budgetBlock?: WorkflowExecutionRecord["budgetBlock"];
  operatorPublishDecision?: WorkflowExecutionRecord["operatorPublishDecision"];
  operatorDecisionSource?: string;
  // W5 — THE PER-NODE FAILURE CHIPS, ON THE INDEX ROW.
  //
  // The Workbench rail draws a chip per node from the last few runs. To get them it was asking
  // workflow_list_runs for `detail: "full"` — five whole run records, up to 1.2 MB each, twice per
  // paint (a second identical call fired from Dock/Drive at the same instant), for what is a single
  // letter per node. Under that load `workspace_get_node` measured 19-25 s and `project_list` 11.7 s.
  //
  // One letter per node, in the run index the listing already reads, so the chips cost ZERO blob
  // reads: c=completed, f=failed, b=blocked, s=skipped, q=queued, r=running, x=cancelled. Single
  // characters rather than the full status words because this rides on EVERY row of every listing and
  // a 25-node run is then ~200 bytes, not ~700 — the same reasoning that made the rest of this
  // projection counts instead of arrays. `failedNodeIds` is the one list worth spelling out in full:
  // it is what the rail actually links to, it is empty on a healthy run, and deriving it client-side
  // from nodeStatuses would make every consumer re-implement the letter mapping.
  nodeStatuses?: Record<string, RunIndexNodeStatus>;
  failedNodeIds?: string[];
  /** Only on a "running" row — the projection assessRunStallFrom needs. */
  stallFacts?: RunStallFacts;
};

// The single-letter status codes carried on an index row (see RunSummaryRecord.nodeStatuses). Exported
// so the Workbench decodes them from the server's own definition rather than a hand-copied map that
// can silently drift when a status is added.
export const RUN_INDEX_NODE_STATUS_CODES = { completed: "c", failed: "f", blocked: "b", skipped: "s", queued: "q", running: "r", cancelled: "x" } as const;
export type RunIndexNodeStatus = typeof RUN_INDEX_NODE_STATUS_CODES[keyof typeof RUN_INDEX_NODE_STATUS_CODES];
const nodeStatusCode = (status: ExecutionStatus): RunIndexNodeStatus | undefined =>
  (RUN_INDEX_NODE_STATUS_CODES as Record<string, RunIndexNodeStatus | undefined>)[status];

// Bound by CODE POINT, not UTF-16 unit — same discipline as executor.ts's boundText: slicing
// between the halves of a surrogate pair emits a lone surrogate, which is not valid UTF-8 and is
// the prime suspect behind the live "Anthropic Proxy: Invalid content from server" failures.
const APPROVAL_REASON_MAX = 500;

/** The one reading of a full record into a row, shared by every backend. */
export const runSummaryOf = (run: WorkflowExecutionRecord): RunSummaryRecord => {
  const nodes = run.nodes ?? [];
  return {
  runId: run.runId,
  projectId: run.projectId,
  workflowId: run.workflowId,
  status: run.status,
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.requestId !== undefined ? { requestId: run.requestId } : {}),
  ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  ...(run.currentNodeId ? { currentNodeId: run.currentNodeId } : {}),
  // Defensive on every array, as buildAttentionItems already is and for the same reason: the
  // record type declares these present, but that is a compile-time guarantee about records
  // written by THIS code. A blob persisted before a field existed, or partially written, must
  // degrade to a zero count rather than throw and take the whole listing down with it.
  nodeCount: nodes.length,
  completedCount: nodes.filter((node) => node.status === "completed").length,
  failedCount: nodes.filter((node) => node.status === "failed").length,
  errorCount: (run.errors ?? []).length,
  artifactCount: (run.artifacts ?? []).length,
  approvalsRequiredCount: (run.approvalsRequired ?? []).length,
  // Bounded for the same reason summarizeRunForList bounds `errors`: `reason` is free text, and
  // an unscoped listing reads every project's index blob in full, so an unbounded string per
  // pending gate is the one field in this projection that could grow without a ceiling.
  approvalsRequired: (run.approvalsRequired ?? []).map((approval) =>
    approval.reason !== undefined && approval.reason.length > APPROVAL_REASON_MAX
      ? { ...approval, reason: `${[...approval.reason].slice(0, APPROVAL_REASON_MAX).join("")}…` }
      : approval
  ),
  dryRun: run.dryRun,
  ...(run.executionMode !== undefined ? { executionMode: run.executionMode } : {}),
  ...(run.rev !== undefined ? { rev: run.rev } : {}),
  ...(run.budgetUsd !== undefined ? { budgetUsd: run.budgetUsd } : {}),
  ...(run.budgetBlock ? { budgetBlock: run.budgetBlock } : {}),
  ...(run.operatorPublishDecision
    ? { operatorPublishDecision: run.operatorPublishDecision, operatorDecisionSource: run.operatorDecisionSource ?? "explicit" }
    : {}),
  // W5 — omitted entirely on a run with no nodes rather than written as `{}`, so an empty-node record
  // (and every row written before this field existed) reads identically either way. An unrecognised
  // status is left out rather than mapped to a wrong letter: a missing chip is honest, a wrong one is
  // not.
  ...(nodes.length ? { nodeStatuses: Object.fromEntries(nodes.flatMap((node) => { const code = nodeStatusCode(node.status); return code ? [[node.nodeId, code] as const] : []; })) } : {}),
  ...(nodes.some((node) => node.status === "failed") ? { failedNodeIds: nodes.filter((node) => node.status === "failed").map((node) => node.nodeId) } : {}),
  // Stall is only ever assessed on a running run, so only a running row has to carry the
  // facts for it. Everything else would be dead weight on every row in the fleet.
  ...(run.status === "running" ? { stallFacts: runStallFacts(run) } : {})
  };
};

export type ListRunSummariesPageResult = {
  rows: RunSummaryRecord[];
  matchedCount: number;
  hasMore: boolean;
  /** See ListRunsPageResult.lastKey. */
  lastKey?: RunSortKey;
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
  // W4 — the same window as listRunsPage, answered in ROWS instead of records. A backend that
  // keeps a row projection alongside its index (BlobExecutionRepository) answers this without
  // opening a single run blob; one that holds records in memory simply projects them.
  listRunSummariesPage(filters?: ListRunsFilters): Promise<ListRunSummariesPageResult>;
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
