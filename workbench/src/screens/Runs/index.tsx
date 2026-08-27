// The Runs surface (WP-13 Live/History + WP-14 Grid) — the operator's
// triage screen. spec/mockup.html: markup `#s-runs` (~line 340), behaviour
// `renderRuns()` (~line 821). Data comes only through api/hooks.ts; UI
// (tab) state lives in the shared store (`runtab`/`setRunTab`), filter
// state is local to this screen per the WP-13/14 brief.

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useProjects, useRuns, useWorkflows } from '../../api/hooks';
import { Card, TabBar } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { useStore } from '../../store';
import type { Run, RunTab, Workflow } from '../../types';
import { LiveTab } from './LiveTab';
import { HistoryTab } from './HistoryTab';
import { GridTab } from './GridTab';
import { stoppedNode } from './helpers';

export interface RunFilters {
  wf: string;
  proj: string;
  status: string;
}

const TABS: Array<{ id: RunTab; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'history', label: 'History' },
  { id: 'grid', label: 'Grid' },
];

export function Runs() {
  const runtab = useStore((s) => s.runtab);
  const setRunTab = useStore((s) => s.setRunTab);
  const bindRun = useStore((s) => s.bindRun);

  const runsQ = useRuns();
  const workflowsQ = useWorkflows();
  const projectsQ = useProjects();

  const [filters, setFilters] = useState<RunFilters>({ wf: '', proj: '', status: '' });

  const runs: Run[] = runsQ.data ?? [];
  const workflows: Workflow[] = workflowsQ.data ?? [];

  const workflowById = useMemo(() => {
    const map: Record<string, Workflow> = {};
    for (const w of workflows) map[w.id] = w;
    return map;
  }, [workflows]);

  const projectNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projectsQ.data ?? []) map[p.id] = p.name;
    return map;
  }, [projectsQ.data]);

  const projectOptions = useMemo(() => {
    if (projectsQ.data && projectsQ.data.length > 0) {
      return projectsQ.data.map((p) => ({ id: p.id, name: p.name }));
    }
    // projectsQ hasn't resolved (or errored) — fall back to whatever
    // project ids the runs themselves carry, so the filter still works.
    const ids = Array.from(new Set(runs.map((r) => r.proj)));
    return ids.map((id) => ({ id, name: id }));
  }, [projectsQ.data, runs]);

  const statusOptions = useMemo(() => Array.from(new Set(runs.map((r) => r.status))).sort(), [runs]);

  function onOpen(run: Run) {
    bindRun(run.id, run.wf, stoppedNode(run, workflowById[run.wf]));
  }

  // U7 polish — error checked before loading (mirrors Rail.tsx's P2-02
  // fix). Two independent queries: with the naive `loading` OR checked
  // first, a runsQ that has already failed for good stays hidden behind
  // "Loading runs…" for as long as workflowsQ (or vice versa) is still
  // in flight or retrying, instead of surfacing the real failure.
  const criticalError = runsQ.error ?? workflowsQ.error;
  const loading = !criticalError && (runsQ.isLoading || workflowsQ.isLoading);

  let body: ReactNode;
  if (criticalError) {
    body = (
      <Card label="runs">
        <p style={{ margin: 0, color: 'var(--bad)' }}>
          {criticalError instanceof Error ? criticalError.message : 'Failed to load runs.'}
        </p>
      </Card>
    );
  } else if (loading) {
    body = (
      <Card label="runs">
        <Skeleton lines={4} />
      </Card>
    );
  } else if (runtab === 'live') {
    body = <LiveTab runs={runs} workflowById={workflowById} onOpen={onOpen} onGoHistory={() => setRunTab('history')} />;
  } else if (runtab === 'history') {
    body = (
      <HistoryTab
        runs={runs}
        workflows={workflows}
        workflowById={workflowById}
        projectOptions={projectOptions}
        projectNameById={projectNameById}
        statusOptions={statusOptions}
        filters={filters}
        setFilters={setFilters}
        onOpen={onOpen}
      />
    );
  } else {
    body = (
      <GridTab
        runs={runs}
        workflows={workflows}
        workflowById={workflowById}
        filters={filters}
        setFilters={setFilters}
        onOpen={onOpen}
      />
    );
  }

  return (
    <main className="pagewrap">
      <div className="pagehead">
        <h1>Runs</h1>
        <span className="sub">monitor · history · cross-run analysis</span>
      </div>
      <TabBar className="subtabs" idPrefix="run-tab" active={runtab} onSelect={setRunTab} tabs={TABS} />
      <div id="runbody">{body}</div>
    </main>
  );
}
