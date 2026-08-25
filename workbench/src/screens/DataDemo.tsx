// WP-03 verification screen: lists workflows (with node counts) and the runs
// table, driven entirely through api/hooks.ts. Temporary — a later WP
// replaces it with the real Library/Runs screens. Uses only the existing
// mockup class vocabulary (.pagewrap .pagehead .card .tblwrap table.runs
// .chip .dot) already defined in styles/base.css; no new CSS.
//
// Not wired into App.tsx: every ScreenId already belongs to a real (future)
// screen — ActiveScreen renders Placeholder for all five today, but none is
// "spare" to claim for a temporary demo, and the WP-03 brief says not to
// restructure App.tsx to make room. So this is exported standalone, and
// `mountDataDemo` lets tests/data.spec.ts render it without touching
// App.tsx, main.tsx, or any other forbidden file.

import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { useNodes, useRuns, useWorkflows } from '../api/hooks';
import type { Run, Workflow } from '../types';

function nodeCount(wf: Workflow): number {
  return wf.phases.reduce((sum, [, ids]) => sum + ids.length, 0);
}

function WorkflowCard({ wf }: { wf: Workflow }) {
  return (
    <div className="card">
      <span className="lbl">{wf.id}</span>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <strong>{wf.name}</strong>
        <span className="chip">{nodeCount(wf)} nodes</span>
      </div>
      <p style={{ margin: '6px 0 0', color: 'var(--muted)' }}>{wf.short}</p>
    </div>
  );
}

function RunRow({ run, workflowName }: { run: Run; workflowName: string }) {
  return (
    <tr>
      <td className="mono">…{run.id.slice(-10)}</td>
      <td>{workflowName}</td>
      <td>{run.proj}</td>
      <td className="mono" style={{ fontSize: '10.5px' }}>
        {run.dry ? 'dry' : 'live'} · {run.exec}
      </td>
      <td>
        <span className={`chip ${run.status}`}>
          <span className={`dot ${run.status}`} />
          {run.status}
        </span>
      </td>
      <td className="mono" style={{ fontSize: '11px' }}>
        {run.cur ?? '—'}
      </td>
      <td className="num">{run.started}</td>
      <td className="num">{run.dur}</td>
      <td className="num">${run.cost.toFixed(2)}</td>
    </tr>
  );
}

export function DataDemo() {
  const workflowsQ = useWorkflows();
  const nodesQ = useNodes();
  const runsQ = useRuns({ limit: 50 });

  const workflowNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const wf of workflowsQ.data ?? []) map[wf.id] = wf.name;
    return map;
  }, [workflowsQ.data]);

  return (
    <div className="pagewrap">
      <div className="pagehead">
        <h1>Data layer demo</h1>
        <span className="sub">WP-03 verification screen — driven entirely through api/hooks.ts</span>
      </div>

      {workflowsQ.isLoading && (
        <div className="card">
          <span className="lbl">workflows</span>
          <p style={{ margin: 0, color: 'var(--muted)' }}>Loading workflows…</p>
        </div>
      )}
      {workflowsQ.isError && (
        <div className="card">
          <span className="lbl">workflows</span>
          <p style={{ margin: 0, color: 'var(--bad)' }}>{workflowsQ.error?.message ?? 'Failed to load workflows.'}</p>
        </div>
      )}
      {workflowsQ.data?.map((wf) => <WorkflowCard key={wf.id} wf={wf} />)}

      <div className="card">
        <span className="lbl">nodes</span>
        <p style={{ margin: 0 }}>
          {nodesQ.isLoading ? 'Loading…' : `${nodesQ.data?.length ?? 0} nodes across all workflows.`}
        </p>
      </div>

      <div className="card">
        <span className="lbl">runs</span>
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
              </tr>
            </thead>
            <tbody>
              {runsQ.isLoading && (
                <tr>
                  <td colSpan={9}>Loading runs…</td>
                </tr>
              )}
              {runsQ.isError && (
                <tr>
                  <td colSpan={9}>{runsQ.error?.message ?? 'Failed to load runs.'}</td>
                </tr>
              )}
              {runsQ.data?.map((run) => (
                <RunRow key={run.id} run={run} workflowName={workflowNameById[run.wf] ?? run.wf} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DataDemoStandalone() {
  const client = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }),
    [],
  );
  return (
    <QueryClientProvider client={client}>
      <DataDemo />
    </QueryClientProvider>
  );
}

/**
 * Mounts a self-contained (own QueryClientProvider) copy of DataDemo into
 * `el`. Used by tests/data.spec.ts; also usable ad hoc from the console
 * (`import('/src/screens/DataDemo.tsx').then(m => m.mountDataDemo(...))`)
 * without wiring anything into App.tsx.
 */
export function mountDataDemo(el: HTMLElement): void {
  createRoot(el).render(<DataDemoStandalone />);
}
