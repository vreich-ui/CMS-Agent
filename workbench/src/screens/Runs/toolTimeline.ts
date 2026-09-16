// W5 T4 (2026-09-16) — a run's tool calls, in order, for the Workbench's Runs screen.
//
// A DELIBERATE MIRROR of ui/src/runToolTimeline.ts. The two SPAs are separately bundled with no
// shared module path between them (neither imports across the boundary anywhere — Runs/helpers.ts
// mirrors the mockup's own script for the same reason), so the choice is a copy or a build-system
// change, and a copy is what this codebase already does. What stops the two drifting is not
// discipline: tests/ui/runToolTimeline.test.ts imports BOTH modules and drives them over the same
// fixture, asserting identical output. Change one without the other and that test fails.
//
// Every decision here is explained in the ui module's header — ordering by startedAt with a
// toolExecutionId tiebreak, options derived from the unfiltered set, an absent caller reported as
// "unrecorded" rather than assumed to be a model turn.

export type TimelineCaller = 'model' | 'engine' | 'operator';

export type ToolExecutionRow = {
  /** ADVERSARIAL REVIEW FIX — optional, because the server's own merge produces rows without it.
   *  tool.list_executions folds in the per-call stubs a run record carries (NodeToolCallRecord), and
   *  a stub written by the runner's tool-call limiter has neither an id nor a startedAt. Declaring
   *  them required did not make them present — the transport casts — it only made `key={undefined}`
   *  and a blank row header look like impossibilities. */
  toolExecutionId?: string;
  runId?: string;
  nodeId?: string;
  toolId: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status?: 'success' | 'denied' | 'error' | 'timeout';
  errorCode?: string;
  riskLevel?: string;
  caller?: TimelineCaller;
  routeId?: string;
  projectId?: string;
  engineVerbUnlisted?: true;
};

export type TimelineFilters = { caller?: string; routeId?: string };

export type TimelineRow = ToolExecutionRow & {
  /** A key that is unique within one run and stable under filtering and re-sorting. Derived from the
   *  row's position in the UNFILTERED input when the ledger gave no id, so two identical
   *  limiter stubs are still two rows rather than one React reuses for both. */
  rowKey: string;
  callerLabel: string;
  /** The tenant held this verb for a human (`needs_approval`), before any transport. Nothing failed
   *  and nothing is half-done — a route has no approval step to enter, so it stops here. */
  heldByTenant: boolean;
  engineReached: boolean;
  refused: boolean;
};

const UNRECORDED_CALLER = 'unrecorded';

// A row with no startedAt sorts LAST rather than first: an absent timestamp is "we do not know when",
// and putting it at the head of the timeline would assert it happened before everything else.
const compare = (a: TimelineRow, b: TimelineRow): number => {
  if (a.startedAt !== b.startedAt) {
    if (a.startedAt === undefined) return 1;
    if (b.startedAt === undefined) return -1;
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  return a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0;
};

export function buildTimelineRows(records: ToolExecutionRow[] | null | undefined, filters: TimelineFilters = {}): TimelineRow[] {
  return (records ?? [])
    .map((record, index) => ({ record, rowKey: record.toolExecutionId ?? `${index}:${record.toolId}:${record.startedAt ?? ""}` }))
    .filter(({ record }) => !filters.caller || (record.caller ?? UNRECORDED_CALLER) === filters.caller)
    .filter(({ record }) => !filters.routeId || record.routeId === filters.routeId)
    .map(({ record, rowKey }) => ({
      ...record,
      rowKey,
      callerLabel: record.caller ?? UNRECORDED_CALLER,
      engineReached: record.caller === 'engine',
      heldByTenant: record.errorCode === 'tenant_verb_needs_approval',
      refused: record.status === 'denied',
    }))
    .sort(compare);
}

export const timelineFilterOptions = (records: ToolExecutionRow[] | null | undefined) => ({
  callers: [...new Set((records ?? []).map((record) => record.caller ?? UNRECORDED_CALLER))].sort(),
  routeIds: [...new Set((records ?? []).map((record) => record.routeId).filter((routeId): routeId is string => !!routeId))].sort(),
});

export const summarizeTimeline = (rows: TimelineRow[]) => ({
  total: rows.length,
  engineCalls: rows.filter((row) => row.engineReached).length,
  denied: rows.filter((row) => row.refused).length,
  heldByTenant: rows.filter((row) => row.heldByTenant).length,
  failed: rows.filter((row) => row.status === 'error' || row.status === 'timeout').length,
  unlistedVerbs: rows.filter((row) => row.engineVerbUnlisted).length,
  projects: [...new Set(rows.map((row) => row.projectId).filter((projectId): projectId is string => !!projectId))].sort(),
});

export const timelineEmptyReason = (records: ToolExecutionRow[] | null | undefined): string | null => {
  if (records === null || records === undefined) return "This run's tool executions could not be read.";
  if (records.length === 0) return 'No tool executions are recorded for this run. Runs that finished before the durable tool ledger began recording have none — that is not the same as a run that called nothing.';
  return null;
};

/** ADVERSARIAL REVIEW FIX — why the table is empty when the RUN has rows but the filters match none.
 *  Without this the screen rendered an empty <tbody> under live headers and a summary of four zeros,
 *  which reads as "this run did nothing" rather than "your filter excludes everything". Distinct from
 *  timelineEmptyReason, which is about the run rather than the controls. */
export const timelineNoMatchReason = (records: ToolExecutionRow[] | null | undefined, rows: TimelineRow[], filters: TimelineFilters = {}): string | null => {
  if (!records || records.length === 0 || rows.length > 0) return null;
  const active = [filters.caller ? `caller "${filters.caller}"` : null, filters.routeId ? `route "${filters.routeId}"` : null].filter(Boolean);
  return `None of this run's ${records.length} recorded call(s) match ${active.join(" and ") || "the current filters"}. The run made calls — these controls exclude them.`;
};
