// Tab 4 — Tools (W5 T4, 2026-09-16). What one run actually DID to the tenant, in the order it did it.
//
// The three tabs beside this one answer "which runs need me" and "how did this run progress". None of
// them could answer "what did it call", because until W3.2.1 an engine-invoked tenant verb — a
// publish, a release, a crawl, a mint, a theme apply, every contract prefetch — went straight from
// engine code to the tenant and was recorded nowhere. The durable tool ledger records them now; this
// renders them, filterable by caller and route.
//
// Every decision (ordering, filter options, what an empty result means, what an unrecorded caller is
// called) lives in ./toolTimeline.ts, which tests/ui/runToolTimeline.test.ts drives alongside the
// other SPA's copy over the same fixture — the Playwright suite here does not cover this logic.

import { useEffect, useState } from 'react';
import { Card, Note } from '../../components/primitives';
import { QueryError } from '../../components/QueryError';
import { Skeleton } from '../../components/Skeleton';
import { useRunToolExecutions } from '../../api/hooks';
import type { Run } from '../../types';
import { shortId } from './helpers';
import { buildTimelineRows, summarizeTimeline, timelineEmptyReason, timelineFilterOptions, timelineNoMatchReason } from './toolTimeline';

export function ToolsTab({
  runs,
  runsLoading,
  boundRunId,
  selectedRunId,
  onSelectRun,
}: {
  /** The screen's loaded run window, for the picker. Scoped by the History/Grid filters, which this
   *  tab does not render — so the picker says so rather than pretending to be the fleet. */
  runs: Run[];
  /** Distinguishes "no runs matched" from "the run list has not arrived yet": this tab is deliberately
   *  outside the screen-level skeleton, so it has to say which of the two it is looking at. */
  runsLoading: boolean;
  /** The run bound in the workbench, if any — the sensible default to look at. */
  boundRunId: string | null;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
}) {
  const [caller, setCaller] = useState('');
  const [routeId, setRouteId] = useState('');
  const runId = selectedRunId ?? boundRunId;
  const q = useRunToolExecutions(runId);

  // ADVERSARIAL REVIEW FIX — a caller or route that exists on one run need not exist on the next.
  // Left in place, the <select> shows a value with no matching <option> (blank in every browser) and
  // the table filters silently to nothing.
  useEffect(() => {
    setCaller('');
    setRouteId('');
  }, [runId]);

  // `undefined` while the query has no data is NOT the same as an empty ledger; timelineEmptyReason
  // draws that line and the copy it returns says which of the two happened.
  const records = q.data ?? null;
  const options = timelineFilterOptions(records);
  const filters = { caller, routeId };
  const rows = buildTimelineRows(records, filters);
  const totals = summarizeTimeline(rows);

  // THE PICKER IS ALWAYS RENDERED, and every other state hangs below it. This tab is exempted from
  // the screen-level skeleton (Runs/index.tsx) precisely so its controls survive a round trip it does
  // not depend on; replacing the whole card with a skeleton or a QueryError would put that back —
  // and in the error case it would leave an operator with no way to choose a different run, which is
  // the one action that could get them out of it.
  const body = (() => {
    if (!runId) {
      return (
        <p className="note" style={{ margin: 0 }}>
          Pick a run to see every tenant call it made — including the ones made from engine code, which pass no node
          grant, no risk check and no approval gate.
        </p>
      );
    }
    if (q.error) {
      return (
        <QueryError
          label="tool executions"
          message={q.error instanceof Error ? q.error.message : 'Failed to load tool executions.'}
          onRetry={() => void q.refetch()}
        />
      );
    }
    if (q.isLoading) return <Skeleton lines={4} />;

    const empty = timelineEmptyReason(records);
    if (empty) return <Note>{empty}</Note>;
    const noMatch = timelineNoMatchReason(records, rows, filters);
    if (noMatch) return <Note>{noMatch}</Note>;

    return (
      <>
        <p className="note" style={{ margin: '0 0 8px' }}>
          {/* Every count is over the FILTERED rows, so the sentence says so before it says any of
              them. And "denied" is not "refused by the tenant": a tool-call-limit stub and a wire
              denylist refusal are denied too, and the errorCode column is what names who did it. */}
          {caller || routeId
            ? `Showing ${rows.length} of ${records?.length ?? rows.length} recorded call(s): `
            : `${rows.length} recorded call(s): `}
          {totals.engineCalls} from engine code · {totals.denied} denied
          {totals.heldByTenant > 0 ? ` (${totals.heldByTenant} held by the tenant for approval)` : ''} · {totals.failed} failed
          {totals.unlistedVerbs > 0 ? ` · ${totals.unlistedVerbs} verb(s) the route manifest does not list` : ''}
          {totals.projects.length > 0 ? ` · tenants ${totals.projects.join(', ')}` : ''}
        </p>
        <table className="tbl">
          <thead>
            <tr>
              <th>started</th>
              <th>tool</th>
              <th>caller</th>
              <th>node · route</th>
              <th>tenant</th>
              <th>outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowKey}>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {/* A run-record stub carries no startedAt; a row with no time is still evidence the
                      call happened, so it is labelled rather than left blank. */}
                  {row.startedAt ?? 'time not recorded'}
                </td>
                <td className="mono">
                  {row.toolId}
                  {row.engineVerbUnlisted ? ' *' : ''}
                </td>
                {/* Bold, not a status Chip: the workbench's chip colours are the RUN-status vocabulary
                    and Dot sets title={status}, so a chip here would tint a caller with a run colour
                    and give it a tooltip reading "running". */}
                <td>{row.engineReached ? <b>engine</b> : row.callerLabel}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {row.nodeId ?? '—'}
                  {row.routeId ? ` · ${row.routeId}` : ''}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {row.projectId ?? '—'}
                </td>
                <td>
                  {row.refused || row.status === 'error' || row.status === 'timeout' ? <b>{row.status}</b> : (row.status ?? '—')}
                  {row.errorCode ? (
                    <span className="mono" style={{ fontSize: 11 }}> {row.errorCode}</span>
                  ) : null}
                  {typeof row.durationMs === 'number' ? <span className="num"> {row.durationMs}ms</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {totals.unlistedVerbs > 0 ? (
          <Note>
            * a verb its route's own manifest does not list. Recorded and never enforced — a manifest that is merely
            incomplete must not be able to stop a publish — but worth looking at after a route changes.
          </Note>
        ) : null}
      </>
    );
  })();

  return (
    <Card label={runId ? `tool timeline · ${shortId(runId)}` : 'tool timeline'}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', margin: '0 0 10px' }}>
        <RunPicker runs={runs} runsLoading={runsLoading} boundRunId={boundRunId} value={selectedRunId ?? ''} onChange={onSelectRun} />
        <label>
          caller{' '}
          <select value={caller} onChange={(e) => setCaller(e.target.value)} disabled={options.callers.length === 0}>
            <option value="">all</option>
            {options.callers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          route{' '}
          <select value={routeId} onChange={(e) => setRouteId(e.target.value)} disabled={options.routeIds.length === 0}>
            <option value="">all</option>
            {options.routeIds.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      {body}
      {/* The picker offers the History/Grid window, which those tabs' filters scope. Said out loud
          rather than left to be discovered by a run going missing from the list mid-session. */}
      {runs.length > 0 ? <Note>The list offers the runs the History/Grid filters currently match — bind a run in the workbench to look at one outside it.</Note> : null}
    </Card>
  );
}

function RunPicker({
  runs,
  runsLoading,
  boundRunId,
  value,
  onChange,
}: {
  runs: Run[];
  runsLoading: boolean;
  boundRunId: string | null;
  value: string;
  onChange: (runId: string | null) => void;
}) {
  // The empty option is only "bound run" when a run is ACTUALLY bound; otherwise it would name a
  // subject that does not exist while the card asks the operator to pick one.
  const placeholder = boundRunId ? `bound run · ${shortId(boundRunId)}` : runsLoading ? 'loading runs…' : runs.length ? 'pick a run…' : 'no runs loaded';
  return (
    <label>
      run{' '}
      <select value={runs.some((run) => run.id === value) ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{placeholder}</option>
        {runs.map((run) => (
          <option key={run.id} value={run.id}>
            {shortId(run.id)} · {run.wf} · {run.status}
          </option>
        ))}
      </select>
    </label>
  );
}
