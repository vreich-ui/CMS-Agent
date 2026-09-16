// W5 T4 (2026-09-16) — THE RUN'S TOOL-EXECUTION TIMELINE.
//
// This page was an honest placeholder saying the run ledger arrives in S5. It still is for the run
// LIST — pagination and status filters are server-side work nobody has done — but the one thing this
// screen could not show at any price is now available and is the thing an operator most needs: what a
// run actually DID to the tenant, including the calls no grant and no risk check ever saw.
//
// Before W3.2.1 an engine-invoked tenant verb — a publish, a release, a crawl, a mint, a theme apply,
// every contract prefetch — went straight from engine code to the tenant and was recorded nowhere, so
// `tool.list_executions` structurally could not show it. The durable ledger changed that; this renders
// it, filterable by caller and by route.
//
// Every decision below (ordering, the filter options, what an empty result means, what an unrecorded
// caller is called) lives in ../../runToolTimeline.ts and is covered by tests/ui/runToolTimeline.test.ts
// — this file is markup over that model, because the root suite does not cover `.tsx`.
import { useEffect, useState } from "react";
import type { AppRoute } from "../../route";
import type { McpClient } from "../../mcp/client";
import {
  buildTimelineRows,
  summarizeTimeline,
  timelineEmptyReason,
  timelineFilterOptions,
  timelineNoMatchReason,
  type ToolExecutionRow
} from "../../runToolTimeline";

type Props = {
  client: McpClient;
  selectedProjectId: string | null;
  onNavigate: (route: AppRoute) => void;
};

type RunOption = { runId: string; workflowId?: string; projectId?: string; status?: string; startedAt?: string };

// The run picker is a window, not the fleet. Stated here and reported in the UI rather than left for
// an operator to discover by not finding the run they came for — the free-text box beside it is the
// answer, and it only helps if they know they need it.
const RUN_WINDOW = 25;

// One MCP round trip per keystroke in the run-id box is 23 failed reads for a 24-character id, each
// of which flashes "could not be read" about a run the operator is still typing. Short enough not to
// feel laggy on a paste, long enough to collapse typing into one call.
const RUN_ID_DEBOUNCE_MS = 350;

export function RunsPage({ client, selectedProjectId, onNavigate }: Props) {
  // `null` is "could not read", `[]` is "read, and there are none" — the empty-state copy depends on
  // the distinction and so does the operator. Applies to both reads below.
  const [runs, setRuns] = useState<RunOption[] | null>(null);
  const [runsMatched, setRunsMatched] = useState<number | null>(null);
  const [runIdInput, setRunIdInput] = useState("");
  const [runId, setRunId] = useState("");
  const [records, setRecords] = useState<ToolExecutionRow[] | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingTimeline, setLoadingTimeline] = useState(false);
  // ONE error, replaced per attempt, never an accumulating list: a banner that is only ever appended
  // to still says "the run list could not be read" over a populated dropdown after the next attempt
  // succeeds, and pushes a duplicate key on the attempt after that. Same shape ChangesPage uses.
  const [runsError, setRunsError] = useState<string | null>(null);
  const [callerFilter, setCallerFilter] = useState("");
  const [routeFilter, setRouteFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoadingRuns(true);
    client
      .call<{ runs: RunOption[]; page?: { matchedCount?: number } }>("workflow.list_runs", { ...(selectedProjectId ? { projectId: selectedProjectId } : {}), limit: RUN_WINDOW })
      .then((result) => {
        if (cancelled) return;
        setRuns(result.runs ?? []);
        setRunsMatched(result.page?.matchedCount ?? null);
        setRunsError(null);
        setLoadingRuns(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRuns(null);
        setRunsMatched(null);
        setRunsError("The run list could not be read. Enter a run id directly to see its timeline.");
        setLoadingRuns(false);
      });
    return () => { cancelled = true; };
  }, [client, selectedProjectId]);

  // Typing in the run-id box moves `runIdInput`; only this settles it into `runId`, which is what the
  // fetch depends on.
  useEffect(() => {
    const timer = setTimeout(() => setRunId(runIdInput.trim()), RUN_ID_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [runIdInput]);

  // The FILTERS ARE NOT SENT TO THE SERVER, deliberately, and this is the one place that choice shows.
  // tool.list_executions accepts caller/routeId, but a run's ledger is tens of rows, not thousands —
  // re-fetching per filter would cost a round trip to remove rows already in the browser, and, worse,
  // the filter options are derived from the UNFILTERED set (see timelineFilterOptions): a server-side
  // filter would narrow the very list the controls are built from, so selecting "engine" would delete
  // every other option from the dropdown. One fetch per run, filtering in memory.
  useEffect(() => {
    // The subject changed, so last run's rows are no longer an answer to anything on screen. Cleared
    // BEFORE the fetch rather than on its resolution: otherwise "Loading timeline…" renders above the
    // previous run's table, counts and tenant list for the whole round trip, with nothing naming the
    // run those rows belong to.
    setRecords(null);
    // The same applies to the filters: a caller that exists on run A need not exist on run B, and a
    // leftover selection leaves a <select> showing a value with no matching <option> and a table
    // silently filtered to nothing.
    setCallerFilter("");
    setRouteFilter("");
    if (!runId) { setLoadingTimeline(false); return; }
    let cancelled = false;
    setLoadingTimeline(true);
    client
      .call<{ executions: ToolExecutionRow[] }>("tool.list_executions", { runId })
      .then((result) => {
        if (cancelled) return;
        setRecords(result.executions ?? []);
        setLoadingTimeline(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRecords(null);
        setLoadingTimeline(false);
      });
    return () => { cancelled = true; };
  }, [client, runId]);

  const options = timelineFilterOptions(records);
  const filters = { caller: callerFilter, routeId: routeFilter };
  const rows = buildTimelineRows(records, filters);
  const totals = summarizeTimeline(rows);
  const emptyReason = runId && !loadingTimeline ? timelineEmptyReason(records) : null;
  const noMatchReason = timelineNoMatchReason(records, rows, filters);
  const listedRunId = runs?.some((run) => run.runId === runId) ? runId : "";

  return <section className="tab-panel" aria-label="Runs">
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Run tool timeline</h2>
          <p className="muted">
            Every controlled tool execution one run recorded, in the order it made them — including the
            engine-invoked tenant calls (publish, release, crawl, mint, theme apply, prefetches) that pass no
            node grant, no risk check and no approval gate. Read-only.
          </p>
        </div>
      </div>

      {runsError && <div className="status error" role="status">{runsError}</div>}

      <div className="change-filters">
        <label>
          Run
          <select value={listedRunId} onChange={(event) => setRunIdInput(event.target.value)} disabled={loadingRuns || !runs?.length}>
            {/* "No runs available" is only said when the list was READ and was empty. A failed read
                is a different fact and gets a different word — the same null/[] distinction the
                timeline below draws. */}
            <option value="">{loadingRuns ? "Loading runs…" : runs === null ? "Run list unavailable" : runs.length ? "Select a run…" : "No runs recorded"}</option>
            {(runs ?? []).map((run) => <option key={run.runId} value={run.runId}>
              {run.runId}{run.workflowId ? ` · ${run.workflowId}` : ""}{run.status ? ` · ${run.status}` : ""}
            </option>)}
          </select>
        </label>
        {/* A free-text box beside the dropdown, not instead of it: the list is a window of the newest
            runs, and the run an operator is investigating after an incident is exactly the one that
            has scrolled off it. */}
        <label>
          …or a run id
          <input type="text" value={runIdInput} onChange={(event) => setRunIdInput(event.target.value)} placeholder="run_…" />
        </label>
        <label>
          Caller
          <select value={callerFilter} onChange={(event) => setCallerFilter(event.target.value)} disabled={options.callers.length === 0}>
            <option value="">All callers</option>
            {options.callers.map((caller) => <option key={caller} value={caller}>{caller}</option>)}
          </select>
        </label>
        <label>
          Route
          <select value={routeFilter} onChange={(event) => setRouteFilter(event.target.value)} disabled={options.routeIds.length === 0}>
            <option value="">All routes</option>
            {options.routeIds.map((routeId) => <option key={routeId} value={routeId}>{routeId}</option>)}
          </select>
        </label>
      </div>

      {runs !== null && runsMatched !== null && runsMatched > runs.length && <p className="muted">
        The list shows the newest {runs.length} of {runsMatched} runs — paste a run id for an older one.
      </p>}

      {loadingTimeline && <p className="muted" aria-live="polite">Loading timeline…</p>}
      {!runId && !loadingTimeline && <p className="empty-state">Pick a run to see what it called.</p>}
      {emptyReason && <p className="empty-state">{emptyReason}</p>}
      {noMatchReason && <p className="empty-state">{noMatchReason}</p>}

      {rows.length > 0 && <>
        <p className="muted">
          {/* Every count below is over the FILTERED rows, so the sentence says so before it says any
              of them — "0 from engine code" under an active route filter is a fact about the filter,
              not about the run. */}
          {callerFilter || routeFilter ? `Showing ${rows.length} of ${records?.length ?? rows.length} recorded call(s)` : `${rows.length} recorded call(s)`}:{" "}
          {totals.engineCalls} from engine code · {totals.denied} denied
          {totals.heldByTenant > 0 ? ` (${totals.heldByTenant} held by the tenant for approval)` : ""} · {totals.failed} failed
          {totals.unlistedVerbs > 0 ? <> · <strong>{totals.unlistedVerbs} verb(s) the route manifest does not list</strong></> : null}
          {totals.projects.length > 0 ? ` · tenants: ${totals.projects.join(", ")}` : ""}.
        </p>
        <table className="node-inspector-tools" aria-label="Tool execution timeline">
          <thead><tr>
            <th scope="col">Started</th>
            <th scope="col">Tool</th>
            <th scope="col">Caller</th>
            <th scope="col">Node / route</th>
            <th scope="col">Tenant</th>
            <th scope="col">Outcome</th>
          </tr></thead>
          <tbody>
            {rows.map((row) => <tr key={row.rowKey} className={row.refused || row.status === "error" || row.status === "timeout" ? "node-inspector-tool-row--denied" : undefined}>
              {/* A run-record stub carries no startedAt. The row header says so rather than rendering
                  blank — a row with no time is still evidence that the call happened. */}
              <th scope="row">{row.startedAt ?? <span className="muted">time not recorded</span>}</th>
              <td><code>{row.toolId}</code>{row.engineVerbUnlisted ? <> <span className="risk-badge risk-badge--write">unlisted</span></> : null}</td>
              {/* "engine" is emphasised because it is the whole point of the screen: that row reached
                  the tenant without passing anything an operator configured. */}
              <td>{row.engineReached ? <strong>{row.callerLabel}</strong> : row.callerLabel}</td>
              <td>
                {row.nodeId ? <code>{row.nodeId}</code> : <span className="muted">—</span>}
                {row.routeId ? <> · <code>{row.routeId}</code></> : null}
              </td>
              <td>{row.projectId ? <code>{row.projectId}</code> : <span className="muted">—</span>}</td>
              <td>
                {row.status ?? "—"}
                {/* The errorCode is what says WHO denied it — the tenant, the wire denylist, or this
                    system's own tool-call limiter. The status word alone cannot. */}
                {row.errorCode ? <> · <code>{row.errorCode}</code></> : null}
                {typeof row.durationMs === "number" ? <> · {row.durationMs}ms</> : null}
              </td>
            </tr>)}
          </tbody>
        </table>
      </>}
    </section>

    <section className="panel page-placeholder">
      <h3>Run history</h3>
      <p className="muted">The paginated run ledger — history, run detail with per-node timings, artifacts and usage — still arrives in session S5; <code>workflow.list_runs</code> needs server-side pagination and status/time filters first.</p>
      <p>Until then, run controls and run state live in the legacy Builder workspace{selectedProjectId ? <> (scoped to <code>{selectedProjectId}</code> when starting runs)</> : null}.</p>
      <button type="button" onClick={() => onNavigate({ page: "constellation", legacy: "builder" })}>Open legacy builder</button>
    </section>
  </section>;
}
