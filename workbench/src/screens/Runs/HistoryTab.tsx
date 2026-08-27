// Tab 2 — History. `.filters` (workflow / project / status, composing) over
// `.tblwrap > table.runs` (spec/mockup.html renderRuns(), S.runtab==='history').
// Row click (and Enter/Space when focused) binds the run into the workbench
// with its stopped node selected — WP-13's stated done-criterion.

import type { FocusEvent, KeyboardEvent } from 'react';
import { Note, StatusChip } from '../../components/primitives';
import { useStore } from '../../store';
import type { Run, Workflow } from '../../types';
import type { RunFilters } from './index';
import { blockedSummary, shortId } from './helpers';

function focusRing(e: FocusEvent<HTMLTableRowElement>) {
  e.currentTarget.style.outline = '2px solid var(--acc)';
  e.currentTarget.style.outlineOffset = '-2px';
}
function clearFocusRing(e: FocusEvent<HTMLTableRowElement>) {
  e.currentTarget.style.outline = 'none';
}

function HistoryRow({
  run,
  workflowName,
  projectName,
  onOpen,
}: {
  run: Run;
  workflowName: string;
  projectName: string;
  onOpen: () => void;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLTableRowElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }
  return (
    <tr
      tabIndex={0}
      role="button"
      aria-label={`Open run ${shortId(run.id)} in the workbench`}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onFocus={focusRing}
      onBlur={clearFocusRing}
    >
      <td className="mono">{shortId(run.id)}</td>
      <td>{workflowName}</td>
      <td>{projectName}</td>
      <td className="mono" style={{ fontSize: 10.5 }}>
        {run.dry ? 'dry' : 'live'} · {run.exec}
      </td>
      <td>
        <StatusChip status={run.status} />
      </td>
      <td className="mono" style={{ fontSize: 11 }}>
        {run.cur ?? '—'}
        {run.status === 'blocked' && (
          <div style={{ fontSize: 10, color: 'var(--faint)', fontWeight: 400 }}>{blockedSummary(run.cur)}</div>
        )}
        {run.status === 'failed' && (
          <div style={{ fontSize: 10, color: 'var(--bad)', fontWeight: 400 }}>
            {run.err} node error{run.err === 1 ? '' : 's'}
          </div>
        )}
      </td>
      <td className="num">{run.started}</td>
      <td className="num">{run.dur}</td>
      <td className="num">${run.cost.toFixed(2)}</td>
      <td>
        {/* U5 — row action: the trace waterfall for this run. Its own
            button so it can stop the row's click (which opens the run in
            the workbench) from also firing. */}
        <button
          type="button"
          className="btn"
          style={{ padding: '3px 9px', fontSize: 11 }}
          title={`Open the trace waterfall for ${shortId(run.id)}`}
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().openModal('waterfall', { run: run.id });
          }}
        >
          ⏱ waterfall
        </button>
      </td>
    </tr>
  );
}

export function HistoryTab({
  runs,
  workflows,
  workflowById,
  projectOptions,
  projectNameById,
  statusOptions,
  filters,
  setFilters,
  onOpen,
}: {
  runs: Run[];
  workflows: Workflow[];
  workflowById: Record<string, Workflow>;
  projectOptions: Array<{ id: string; name: string }>;
  projectNameById: Record<string, string>;
  statusOptions: string[];
  filters: RunFilters;
  setFilters: (updater: (f: RunFilters) => RunFilters) => void;
  onOpen: (run: Run) => void;
}) {
  const filtered = runs.filter(
    (r) =>
      (!filters.wf || r.wf === filters.wf) &&
      (!filters.proj || r.proj === filters.proj) &&
      (!filters.status || r.status === filters.status),
  );
  const blocked = filtered.filter((r) => r.status === 'blocked').length;
  const failed = filtered.filter((r) => r.status === 'failed').length;

  return (
    <>
      <div className="filters">
        <select
          value={filters.wf}
          onChange={(e) => setFilters((f) => ({ ...f, wf: e.target.value }))}
          aria-label="filter by workflow"
        >
          <option value="">workflow: all</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select
          value={filters.proj}
          onChange={(e) => setFilters((f) => ({ ...f, proj: e.target.value }))}
          aria-label="filter by project"
        >
          <option value="">project: all</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          aria-label="filter by status"
        >
          <option value="">status: all</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="tblwrap">
        <table className="runs">
          <thead>
            <tr>
              <th>run</th>
              <th>workflow</th>
              <th>project</th>
              <th>mode</th>
              <th>status</th>
              <th>stopped at</th>
              <th>started</th>
              <th>duration</th>
              <th>cost</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((run) => (
              <HistoryRow
                key={run.id}
                run={run}
                workflowName={workflowById[run.wf]?.name ?? run.wf}
                projectName={projectNameById[run.proj] ?? run.proj}
                onOpen={() => onOpen(run)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        {runs.length} runs · {filtered.length} shown
        {filtered.length > 0
          ? ` — ${blocked} blocked at a gate, ${failed} failed; any row opens that run in the workbench with its stopped node selected`
          : ' — no runs match these filters'}
      </Note>
    </>
  );
}
