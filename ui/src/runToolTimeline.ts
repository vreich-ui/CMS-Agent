// W5 T4 (2026-09-16) — A RUN'S TOOL CALLS, IN ORDER, INCLUDING THE ONES NOBODY COULD SEE.
//
// WHAT THIS IS FOR. Until W3.2.1 the only tool activity any surface could show was what a MODEL turn
// did: a publish, a release, a crawl, a mint, a theme apply and every contract prefetch went straight
// from engine code to the tenant through ProjectMcpAdapter and left no record anywhere. The durable
// ledger changed that, and `tool.list_executions` already serves the rows — but no screen rendered
// them, so the answer to "what did this run actually DO to the tenant" still lived in a JSON dump.
//
// Pure logic, framework-free, tested by the root vitest suite — the same discipline nodeInspector.ts
// and toolAdministration.ts follow, and the reason a `.tsx` file the root tests do not cover still has
// its decisions covered. workbench/src/screens/Runs/toolTimeline.ts is a deliberate mirror of this
// module for the other SPA; tests/ui/runToolTimeline.test.ts drives BOTH over the same fixture so the
// two can never quietly disagree.
//
// ORDERING, AND THE ONE DECISION IN IT. Rows sort by `startedAt` ascending — the order the calls were
// MADE, which is the order an operator reconstructing an incident reads in. Ties (the ledger stamps
// ISO seconds-or-better, and a deterministic route can fire two verbs inside the same millisecond)
// break by the row key, so the order is total and a re-render never shuffles two rows that
// happened "at the same time". Sorting by completion instead would interleave a slow publish with the
// fast polls that followed it, which is exactly the shape that makes a timeline unreadable.

export type TimelineCaller = "model" | "engine" | "operator";

/** The subset of a `tool.list_executions` record this model reads. Everything is optional except the
 *  four fields the ledger has always carried, because rows written before W3.2.1 have no caller, no
 *  route and no project — and a row that predates the ledger's own columns is still a row. */
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
  status?: "success" | "denied" | "error" | "timeout";
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
  /** What to show in the "who" column. An absent caller is NOT silently called "model": rows written
   *  before W3.2.1 genuinely did not record one, and labelling them would invent evidence. */
  callerLabel: string;
  /** The tenant held this verb for a human (`needs_approval`), before any transport. Nothing failed
   *  and nothing is half-done — a route has no approval step to enter, so it stops here. */
  heldByTenant: boolean;
  /** Reached the tenant from engine code, past every grant and risk check — the row an operator
   *  reading an incident is looking for, and the reason this screen exists. */
  engineReached: boolean;
  /** The call was DENIED. ADVERSARIAL REVIEW FIX — not "refused by the tenant": `status: "denied"`
   *  also covers a refusal this system made itself (the runner's tool-call limiter writes a denied
   *  stub with errorCode `tool_call_limit_exceeded`, and the wire denylist writes one with
   *  `publish_verb_not_permitted`), and a screen that attributed those to the client would send an
   *  operator to read a tenant policy that had nothing to do with it. `heldByTenant` below is the
   *  one that IS a tenant statement. */
  refused: boolean;
};

const UNRECORDED_CALLER = "unrecorded";

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
    .filter(({ record }) => (!filters.caller || (record.caller ?? UNRECORDED_CALLER) === filters.caller))
    .filter(({ record }) => (!filters.routeId || record.routeId === filters.routeId))
    .map(({ record, rowKey }) => ({
      ...record,
      rowKey,
      callerLabel: record.caller ?? UNRECORDED_CALLER,
      engineReached: record.caller === "engine",
      heldByTenant: record.errorCode === "tenant_verb_needs_approval",
      refused: record.status === "denied"
    }))
    .sort(compare);
}

/** The filter options a run's OWN rows support. Derived from the unfiltered set, never from a fixed
 *  list: a control offering "engine" on a run that made no engine calls is a control that returns an
 *  empty table, and one that omits a caller the run did use hides the rows that matter. */
export const timelineFilterOptions = (records: ToolExecutionRow[] | null | undefined) => ({
  callers: [...new Set((records ?? []).map((record) => record.caller ?? UNRECORDED_CALLER))].sort(),
  routeIds: [...new Set((records ?? []).map((record) => record.routeId).filter((routeId): routeId is string => !!routeId))].sort()
});

export const summarizeTimeline = (rows: TimelineRow[]) => ({
  total: rows.length,
  engineCalls: rows.filter((row) => row.engineReached).length,
  denied: rows.filter((row) => row.refused).length,
  heldByTenant: rows.filter((row) => row.heldByTenant).length,
  failed: rows.filter((row) => row.status === "error" || row.status === "timeout").length,
  // A verb the route's own manifest does not list. Recorded and never enforced (tenantInvoke.ts), so
  // it belongs on screen as a note rather than as an alarm — but an operator who has just widened a
  // route wants to see it.
  unlistedVerbs: rows.filter((row) => row.engineVerbUnlisted).length,
  projects: [...new Set(rows.map((row) => row.projectId).filter((projectId): projectId is string => !!projectId))].sort()
});

/** What to say when a run has no rows — a real and common state (every run made before the ledger
 *  began recording, and every run that touched no tenant), and one that must not render as "this run
 *  called nothing". */
export const timelineEmptyReason = (records: ToolExecutionRow[] | null | undefined): string | null => {
  if (records === null || records === undefined) return "This run's tool executions could not be read.";
  if (records.length === 0) return "No tool executions are recorded for this run. Runs that finished before the durable tool ledger began recording have none — that is not the same as a run that called nothing.";
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
