// The Runs surface (WP-13 Live/History + WP-14 Grid) — the operator's
// triage screen. spec/mockup.html: markup `#s-runs` (~line 340), behaviour
// `renderRuns()` (~line 821). Data comes only through api/hooks.ts; UI
// (tab) state lives in the shared store (`runtab`/`setRunTab`), filter
// state is local to this screen per the WP-13/14 brief.

import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useProjects, useRunsPage, useRunsPages, useWorkflows } from '../../api/hooks';
import { Card, TabBar } from '../../components/primitives';
import { QueryError } from '../../components/QueryError';
import { Skeleton } from '../../components/Skeleton';
import { useStore } from '../../store';
import type { Run, RunStatus, RunTab, Workflow } from '../../types';
import { LiveTab } from './LiveTab';
import { HistoryTab } from './HistoryTab';
import { GridTab } from './GridTab';
import { ToolsTab } from './ToolsTab';
import { stoppedNode } from './helpers';

export interface RunFilters {
  wf: string;
  proj: string;
  status: string;
}

// The statuses the Live tab is about — sent to the server as a multi-status filter (W1).
const LIVE_STATUSES: RunStatus[] = ['running', 'paused', 'blocked'];

// The Grid tab's default scope — it has no "all workflows" option, so this is what its query is
// scoped to until the operator picks another. Mirrors GridTab's own DEFAULT_WORKFLOW.
const DEFAULT_GRID_WORKFLOW = 'publishing_conductor';

// How many live runs the Live tab will show at once. It reports the true matched count alongside,
// so a fleet with more than this says so rather than quietly truncating.
const LIVE_CAP = 100;

// Every status a run can be in, so the History filter can select one the window has not loaded.
const ALL_RUN_STATUSES: RunStatus[] = ['queued', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled', 'skipped'];

const TABS: Array<{ id: RunTab; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'history', label: 'History' },
  { id: 'grid', label: 'Grid' },
  { id: 'tools', label: 'Tools' },
];

export function Runs() {
  const runtab = useStore((s) => s.runtab);
  const setRunTab = useStore((s) => s.setRunTab);
  const bindRun = useStore((s) => s.bindRun);
  // W5 T4 — the run bound in the workbench is the Tools tab's default subject; `toolsRunId` is the
  // operator's own override, local to this screen exactly as the filter state is.
  const boundRunId = useStore((s) => s.runId);
  const [toolsRunId, setToolsRunId] = useState<string | null>(null);

  const [filters, setFilters] = useState<RunFilters>({ wf: '', proj: '', status: '' });

  // REVIEW FIX — the filters go to the SERVER, not only to the rendered rows. Filtering a
  // 20-row window client-side meant the status dropdown could only offer statuses that happened
  // to be in the window, "showing 20 of 115" kept counting the unfiltered fleet while a filter
  // was active, and "Load more (95 left)" was counting rows the filter would discard. That is
  // the "card says 48, Runs says 0" disagreement W1 set out to kill, in filtered form.
  // REVIEW FIX (round 2) — the Grid tab is ALWAYS scoped to one workflow: its select has no
  // "all" option and defaults to publishing_conductor. Leaving that scope client-side meant the
  // query returned the newest 20 runs across every workflow and the Grid filtered them down,
  // so a fleet whose newest 20 belonged to other conductors rendered "No runs yet for Publishing
  // Conductor" — the same windowed-read-as-total claim the Live tab was just fixed for, one tab
  // over, while its own dropdown displayed the workflow it was supposedly showing.
  const workflowsQ = useWorkflows();
  const projectsQ = useProjects();
  const workflows: Workflow[] = workflowsQ.data ?? [];

  // Falls back to a workflow this workspace actually has: a hardcoded id now drives the QUERY,
  // so on a workspace without publishing_conductor the Grid would have asked about a workflow
  // that does not exist, rendered "No runs yet for publishing_conductor", and displayed a
  // different workflow's name in its select — the same control/query disagreement, one cause over.
  const gridWorkflowId = filters.wf || workflows.find((w) => w.id === DEFAULT_GRID_WORKFLOW)?.id || workflows[0]?.id || DEFAULT_GRID_WORKFLOW;
  const serverFilters = useMemo(
    () => ({
      ...(runtab === 'grid' ? { workflowId: gridWorkflowId } : filters.wf ? { workflowId: filters.wf } : {}),
      ...(filters.proj ? { projectId: filters.proj } : {}),
      ...(filters.status ? { status: filters.status as RunStatus } : {}),
    }),
    [runtab, gridWorkflowId, filters.wf, filters.proj, filters.status],
  );

  // W1 — one windowed call (20 rows) instead of the old merge of every project's entire run
  // list, with the rest of the fleet behind an explicit "load more". `matchedCount` still names
  // the true fleet size on the first page, so the count in the header never disagrees with the
  // Workflows card again.
  const runsQ = useRunsPages(serverFilters);

  // REVIEW FIX — the Live tab asks its OWN question, scoped by status, rather than filtering
  // whatever the newest-20 window happened to contain. A run that is blocked on an operator has
  // stopped advancing while newer runs keep being created, so it is the FIRST row to fall out of
  // a startedAt-ordered window — exactly the run whose absence made the tab announce "the
  // pipeline is caught up" while the Workflows deck, one screen earlier, said three runs needed
  // attention. `matchedCount` over this set is also the honest count for the tab's own header.
  // `enabled` so opening Runs on History or Grid does not also pay for the live read.
  const liveQ = useRunsPage({ status: LIVE_STATUSES, limit: LIVE_CAP }, { enabled: runtab === 'live' });

  const pages = runsQ.data?.pages;
  const runs: Run[] = useMemo(() => (pages ?? []).flatMap((page) => page.runs), [pages]);
  const matchedCount = pages?.[0]?.matchedCount ?? runs.length;

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

  // REVIEW FIX (round 2) — the fallback accumulates. `runs` is now scoped by the selected
  // project, so deriving the option list from it alone collapsed the dropdown to the one project
  // already chosen: the operator could clear back to "all" but never switch straight to another
  // — and this fallback only runs when project_list has failed, which is exactly when it has to
  // work. Ids are remembered across renders instead.
  const seenProjectIds = useRef<Set<string>>(new Set());
  for (const run of runs) seenProjectIds.current.add(run.proj);
  const projectOptions = useMemo(() => {
    if (projectsQ.data && projectsQ.data.length > 0) {
      return projectsQ.data.map((p) => ({ id: p.id, name: p.name }));
    }
    return [...seenProjectIds.current].sort().map((id) => ({ id, name: id }));
  }, [projectsQ.data, runs]);

  // Fixed, not derived from the loaded rows: an operator must be able to filter TO a status the
  // current window does not happen to contain — which is the whole reason to filter.
  const statusOptions = ALL_RUN_STATUSES;

  function onOpen(run: Run) {
    bindRun(run.id, run.wf, stoppedNode(run, workflowById[run.wf]));
  }

  // U7 polish — error checked before loading (mirrors Rail.tsx's P2-02
  // fix). Two independent queries: with the naive `loading` OR checked
  // first, a runsQ that has already failed for good stays hidden behind
  // "Loading runs…" for as long as workflowsQ (or vice versa) is still
  // in flight or retrying, instead of surfacing the real failure.
  // ADVERSARIAL REVIEW FIX — the Tools tab is NOT covered by the screen-level critical error either,
  // for the same reason it is not covered by the skeleton: it fetches its own data for a run it
  // already has (the bound run), so a failed workflow_list_runs must not replace it with a retry
  // button for a query it does not read. It renders its own error, below its own run picker.
  const criticalError = runtab === 'tools' ? undefined : ((runtab === 'live' ? liveQ.error : runsQ.error) ?? workflowsQ.error);
  // REVIEW FIX (round 2) — only skeleton when there is genuinely nothing to show. The filter
  // selects live INSIDE the tab bodies, so treating a filter change as "loading" unmounted the
  // controls the operator was using, for a whole round trip.
  const hasRows = (runtab === 'live' ? (liveQ.data?.runs.length ?? 0) : runs.length) > 0;
  // W5 T4 — the Tools tab owns its own query and its own loading/empty states, and its run picker is
  // usable with no runs loaded at all (an operator pastes nothing; the bound run is already there).
  // Letting the screen-level skeleton cover it would blank that picker for a round trip it does not
  // depend on — the same defect the filter-change fix above was for, one tab over.
  const loading =
    runtab !== 'tools' &&
    !criticalError &&
    !hasRows &&
    ((runtab === 'live' ? liveQ.isLoading : runsQ.isLoading) || workflowsQ.isLoading);
  const refetching = runtab === 'live' ? liveQ.isPlaceholderData : runsQ.isPlaceholderData;

  let body: ReactNode;
  if (criticalError) {
    // W2 — was a dead end: the message with no way to act on it. Retry refetches both
    // queries, since either can be the failed half.
    body = (
      <QueryError
        label="runs"
        message={criticalError instanceof Error ? criticalError.message : 'Failed to load runs.'}
        onRetry={() => {
          void runsQ.refetch();
          void liveQ.refetch();
          void workflowsQ.refetch();
        }}
      />
    );
  } else if (loading) {
    body = (
      <Card label="runs">
        <Skeleton lines={4} />
      </Card>
    );
  } else if (runtab === 'live') {
    body = (
      <LiveTab
        runs={liveQ.data?.runs ?? []}
        matchedCount={liveQ.data?.matchedCount ?? 0}
        workflowById={workflowById}
        onOpen={onOpen}
        onGoHistory={() => setRunTab('history')}
      />
    );
  } else if (runtab === 'history') {
    body = (
      <HistoryTab
        runs={runs}
        matchedCount={matchedCount}
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
  } else if (runtab === 'tools') {
    body = <ToolsTab runs={runs} runsLoading={runsQ.isLoading} boundRunId={boundRunId} selectedRunId={toolsRunId} onSelectRun={setToolsRunId} />;
  } else {
    body = (
      <GridTab
        runs={runs}
        matchedCount={matchedCount}
        workflowId={gridWorkflowId}
        workflows={workflows}
        workflowById={workflowById}
        setFilters={setFilters}
        onOpen={onOpen}
      />
    );
  }

  return (
    <main className="pagewrap">
      <div className="pagehead">
        <h1>Runs</h1>
        <span className="sub">
          monitor · history · cross-run analysis
          {runtab !== 'live' && runtab !== 'tools' && runs.length > 0 ? ` · showing ${runs.length} of ${matchedCount}` : ''}
        </span>
      </div>
      <TabBar className="subtabs" idPrefix="run-tab" active={runtab} onSelect={setRunTab} tabs={TABS} />
      {/* Dimmed, not replaced, while a newly filtered page is in flight — the controls stay usable. */}
      <div id="runbody" style={refetching ? { opacity: 0.55 } : undefined} aria-busy={refetching || undefined}>
        {body}
      </div>
      {/* History only: the Grid caps at its newest GRID_CAP columns, so every later page adds
          only older runs that sort behind them — the button would move the header's counter and
          change nothing an operator can see. */}
      {!criticalError && runtab === 'history' && runsQ.hasNextPage ? (
        <div className="loadmore">
          <button
            id="runs-loadmore"
            type="button"
            className="btn"
            disabled={runsQ.isFetchingNextPage}
            onClick={() => void runsQ.fetchNextPage()}
          >
            {runsQ.isFetchingNextPage ? 'Loading…' : `Load more (${matchedCount - runs.length} left)`}
          </button>
        </div>
      ) : null}
    </main>
  );
}
