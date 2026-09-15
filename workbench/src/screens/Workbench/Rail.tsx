// WP-11 — node rail + Build/Run mode bar. Markup/behaviour mirror
// spec/mockup.html's `<aside class="rail">` block and renderRail()/orderedNodes()
// /nodeRunStatus() (lines ~42-62, 582-591). Class vocabulary only — no new CSS
// beyond the labeled U5 block in base.css.
//
// U5 — the rail is now a triage instrument: each row carries compact health
// chips (latest eval score, recent error frequency, a "learned" badge for
// nodes changed by learning since the operator's last visit, an override
// marker) that degrade silently to nothing when their source is
// unavailable — a failed metrics call must never blank the rail or fake an
// all-clear (per the brief). A hover (or long-press) on a row opens the
// node quick-look popover.

import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNodes, useRubrics, useRun, useRuns, useWorkflows } from '../../api/hooks';
import { changesListEvents } from '../../api/verbs';
import { Dot } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { QueryError } from '../../components/QueryError';
import { QuickLookPopover } from '../../components/quicklook/QuickLookPopover';
import { useNodeQuickLook } from '../../components/quicklook/useNodeQuickLook';
import { useStore } from '../../store';
import type { Run, RunNode, WorkflowNode } from '../../types';
import { nodeErrorFrequency, nodeRunStatus, orderedNodes, type NodeRunStatus } from './helpers';

interface VisibleRow {
  nid: string;
  n: WorkflowNode | undefined;
  st: NodeRunStatus | null;
  dim: boolean;
}

const LAST_VISIT_KEY = 'cw-rail-lastvisit';

/** Wrapped in try/catch per the app's established localStorage pattern
 * (store.ts's theme persistence) — a private window or blocked storage
 * degrades to "never visited before" rather than throwing. */
function readLastVisit(): number {
  try {
    const v = localStorage.getItem(LAST_VISIT_KEY);
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastVisit(ts: number) {
  try {
    localStorage.setItem(LAST_VISIT_KEY, String(ts));
  } catch {
    // ignore — storage unavailable
  }
}

function evalScoreColor(score: number): string {
  if (score >= 0.7) return 'var(--ok)';
  if (score >= 0.4) return 'var(--acc)';
  return 'var(--bad)';
}

function RailRow({
  nid,
  n,
  st,
  dim,
  selected,
  current,
  wf,
  evalScore,
  errorFreq,
  learned,
  runNodeState,
  onSelect,
  rowRef,
}: {
  nid: string;
  n: WorkflowNode | undefined;
  st: NodeRunStatus | null;
  dim: boolean;
  selected: boolean;
  current: boolean;
  wf: string;
  evalScore: number | null | undefined;
  errorFreq: number;
  learned: boolean;
  /** This node's slice of the BOUND run, when one is bound — the source of the output-provenance
   *  markers below. Null when no run is bound or the run has no state for this node. */
  runNodeState: RunNode | null;
  onSelect: (id: string) => void;
  rowRef: (el: HTMLButtonElement | null) => void;
}) {
  const ql = useNodeQuickLook(nid, wf);

  // W4 — THE MARKER NOW COMES FROM THE RUN, not from a per-node verb call.
  //
  // This used to fire `node_list_outputs` once PER NODE (25 queries on a publishing run) purely to ask
  // whether that node carried an operator override — the same "the rail is asking the server a
  // question per row" shape W5 removed from the failure chips. The run record already answers it: each
  // node state carries `outputProvenance` (executor.applyNonDispatchOutput), which the compact run view
  // and the adapter now carry through as `outputSource`. Zero extra requests, and it works for a node
  // in any state rather than only a completed one.
  //
  // TWO MARKERS, NOT ONE, and deliberately distinct: an OVERRIDE is a value an operator supplied for
  // this run only; a DEFAULT is the node's own stored value, reused across runs. They have identical
  // consequences (never published live, never learned from) and entirely different causes, and an
  // operator looking at a run needs to know which one they are looking at.
  const outputSource = runNodeState?.outputSource;
  const hasOverride = outputSource === 'operator_override';
  const hasDefault = outputSource === 'default_output';

  return (
    <div style={{ position: 'relative' }}>
      <button
        key={nid}
        type="button"
        ref={rowRef}
        className={['nrow', selected ? 'sel' : '', current ? 'cur' : '', dim ? 'dim' : ''].filter(Boolean).join(' ')}
        onClick={() => onSelect(nid)}
        {...ql.triggerProps}
      >
        <Dot status={st ?? undefined} />
        <span className="nm">{nid}</span>
        {typeof evalScore === 'number' && (
          <span
            className="chip-eval"
            style={{ color: evalScoreColor(evalScore) }}
            title={`latest eval score: ${evalScore.toFixed(2)}`}
          >
            {Math.round(evalScore * 100)}
          </span>
        )}
        {errorFreq > 0 && (
          <span className="chip-err" title={`failed in ${errorFreq} of the recent runs of this node`}>
            ⚠{errorFreq}
          </span>
        )}
        {learned && (
          <span className="chip-learned" title="changed by learning since your last visit to this rail">
            learned
          </span>
        )}
        {hasOverride && (
          <span className="chip-override" title="carries an operator output override in this run — a value you supplied for this run, not something the node produced">
            ⎘
          </span>
        )}
        {hasDefault && (
          <span className="chip-override" title="completed from this node's STORED DEFAULT output — it did not run, no model was called. This run can never publish live, and this node is excluded from its learning record.">
            ⏭
          </span>
        )}
        {n && n.fan > 1 && (
          <span className="fan" title={`${n.fan} upstream inputs`}>
            ⇐{n.fan}
          </span>
        )}
        {n && n.risk === 'publish' && (
          <span className="risk publish" title="publish risk">
            P
          </span>
        )}
      </button>
      <QuickLookPopover nodeId={nid} workflowId={wf} anchor={ql.anchor} onClose={ql.close} />
    </div>
  );
}

export function Rail() {
  const wf = useStore((s) => s.wf);
  const mode = useStore((s) => s.mode);
  const runId = useStore((s) => s.runId);
  const node = useStore((s) => s.node);
  const showUneng = useStore((s) => s.showUneng);
  const setMode = useStore((s) => s.setMode);
  const setNode = useStore((s) => s.setNode);
  const setTab = useStore((s) => s.setTab);
  const setShowUneng = useStore((s) => s.setShowUneng);
  const bindRun = useStore((s) => s.bindRun);
  const adoptNode = useStore((s) => s.adoptNode);
  const openGraphOverlay = useStore((s) => s.openGraphOverlay);

  const workflowsQ = useWorkflows();
  const nodesQ = useNodes(wf);
  // W1 — this panel renders a handful of "recent runs · this workflow" rows; ask the
  // server for exactly that rather than taking the default 20-row page and slicing.
  // W5 — `detail: 'full'` REMOVED. It was fetching five whole run records (up to 1.2 MB each) for
  // what the failure chips actually need: one status per node. A summary row now carries
  // `nodeStatuses` straight off the run index, which the adapter expands into the same nodes[] array
  // nodeErrorFrequency already reads, so the chips are unchanged and the listing opens no run blobs
  // at all. Measured cause of the 19-25s `workspace_get_node` under rail load — with Dock/Drive
  // firing an identical call at the same instant, both aborting at 25s, and the server still working
  // on the aborted requests.
  //
  // The filter object is now BYTE-IDENTICAL to DriveCenter's and Dock's, so react-query's
  // ['runs', filters] key dedupes those three to ONE in-flight request instead of two. QuickLookFacts
  // is deliberately NOT one of them — it keeps `limit: 8, detail: 'full'` for the duration figure on
  // its "last run" line, and it opens on demand rather than at first paint.
  const wfRunsQ = useRuns({ workflowId: wf, limit: 5 });
  const boundRunQ = useRun(runId);
  const rubricsQ = useRubrics();

  // U5 — one call for the whole rail (not per row): every learning-sourced
  // change made by an agent, grouped by node below. `changes_list` is
  // documented working live (contracts/README.md) — a failure here degrades
  // to "no learned badges", never a rail-wide error.
  const learningChangesQ = useQuery({
    queryKey: ['changes', 'learning-agent'],
    queryFn: () => changesListEvents({ actorKind: 'agent', source: 'learning' }),
    retry: false,
  });

  // Captured once per mount: the visit BEFORE this one. Writing the new
  // "now" happens after paint (the effect below), so this session's own
  // badges are computed against the prior visit, not against themselves.
  const lastVisitRef = useRef<number>(readLastVisit());
  useEffect(() => {
    writeLastVisit(Date.now());
  }, []);

  const learnedByNode = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of learningChangesQ.data?.events ?? []) {
      const id = e.target?.id;
      if (!id) continue;
      const ts = Date.parse(e.createdAt);
      if (!Number.isFinite(ts)) continue;
      if (!map.has(id) || ts > (map.get(id) as number)) map.set(id, ts);
    }
    return map;
  }, [learningChangesQ.data]);

  const workflow = workflowsQ.data?.find((w) => w.id === wf);
  const nodesById = useMemo(() => {
    const map = new Map<string, WorkflowNode>();
    for (const n of nodesQ.data ?? []) map.set(n.id, n);
    return map;
  }, [nodesQ.data]);

  const scoreByNode = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const r of rubricsQ.data ?? []) map.set(r.node, r.score);
    return map;
  }, [rubricsQ.data]);

  const run: Run | null = mode === 'run' && runId ? (boundRunQ.data ?? null) : null;
  const order = useMemo(() => (workflow ? orderedNodes(workflow) : []), [workflow]);

  /**
   * Rail truth (P2-01/P2-03).
   *
   * WORKFLOW_CATALOG supplies phase NAMES and ordering — editorial
   * grouping, and nothing more. The set of nodes comes from the live graph
   * (`workspace_get_graph({workflowId})`, see verbs.workspaceGetNodes).
   * Those two disagreed badly: the catalog listed 9 nodes for
   * clone_conductor where the live conductor runs 18, and 11 for
   * capture_conductor where live runs 16.
   *
   * So: a catalog phase only lists nodes that actually exist live, and any
   * live node no phase claims is still shown — under an explicit
   * "ungrouped (live)" heading, in graph order. A node the workspace runs
   * is never invisible here again; if the grouping is stale, the rail says
   * so instead of silently dropping the node.
   */
  const rowsByPhase: Array<[string, VisibleRow[]]> = useMemo(() => {
    if (!workflow) return [];
    const liveIds = new Set(nodesById.keys());
    const claimed = new Set<string>();

    const build = (ids: string[]): VisibleRow[] => {
      const rows: VisibleRow[] = [];
      for (const nid of ids) {
        const st = run ? nodeRunStatus(run, nid, order) : null;
        const dim = Boolean(run) && st === 'queued';
        if (dim && !showUneng) continue;
        rows.push({ nid, n: nodesById.get(nid), st, dim });
      }
      return rows;
    };

    const phases: Array<[string, VisibleRow[]]> = workflow.phases.map(([label, ids]) => {
      // Only nodes the workspace actually has. If the node list has not
      // loaded yet, show the catalog's ids rather than an empty rail.
      const present = liveIds.size === 0 ? ids : ids.filter((id) => liveIds.has(id));
      for (const id of present) claimed.add(id);
      return [label, build(present)] as [string, VisibleRow[]];
    });

    const unclaimed = [...liveIds].filter((id) => !claimed.has(id));
    if (unclaimed.length > 0) phases.push(['ungrouped (live)', build(unclaimed)]);
    return phases;
  }, [workflow, run, order, showUneng, nodesById]);

  const visibleIds = useMemo(() => rowsByPhase.flatMap(([, rows]) => rows.map((r) => r.nid)), [rowsByPhase]);

  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /**
   * P2-01 — first-node adoption. The store now boots with no node selected
   * (it used to boot naming a fixture node inside a fixture run that does
   * not exist upstream, which is what made every cold load fire a failing
   * `workflow_get_run`). The first real node id the workspace hands back is
   * adopted here; `adoptNode` only fills an empty selection, so this can
   * never override the operator's own choice or a run binding.
   */
  useEffect(() => {
    if (node) return;
    const first = visibleIds[0];
    if (first) adoptNode(first);
  }, [node, visibleIds, adoptNode]);

  function handleModeBuild() {
    setMode('build');
    setTab('prompt');
  }

  function handleModeRun() {
    if (runId) {
      setMode('run');
      setTab('thisrun');
      return;
    }
    const candidate = wfRunsQ.data?.[0];
    if (candidate) {
      bindRun(candidate.id, wf, candidate.cur ?? node);
    }
    // No run exists yet for this workflow — mirrors the mockup: stays in build.
  }

  function handleRailKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (visibleIds.length === 0) return;
    e.preventDefault();
    const idx = visibleIds.indexOf(node);
    const base = idx === -1 ? 0 : idx;
    const nextIdx = e.key === 'ArrowDown' ? (base + 1) % visibleIds.length : (base - 1 + visibleIds.length) % visibleIds.length;
    const nextId = visibleIds[nextIdx];
    setNode(nextId);
    requestAnimationFrame(() => rowRefs.current[nextId]?.focus());
  }

  // P2-02 — error is checked BEFORE loading. Branching on `isLoading`
  // first is what kept a failed query showing a spinner for the whole
  // retry sequence instead of saying what went wrong.
  const isError = workflowsQ.isError || nodesQ.isError;
  const isLoading = !isError && (workflowsQ.isLoading || nodesQ.isLoading);

  return (
    <aside className="rail">
      {/* a11y S5 — this is a click-only two-state toggle, not a tab panel
          switch (no arrow-key roving, no linked tabpanel), so it doesn't
          fit the tablist/tab pattern role="tablist" implied. aria-pressed
          accurately describes what's actually built. */}
      <div className="modebar">
        <button type="button" id="mode-build" aria-pressed={mode === 'build'} className={mode === 'build' ? 'on' : ''} onClick={handleModeBuild}>
          Build
        </button>
        <button type="button" id="mode-run" aria-pressed={mode === 'run'} className={mode === 'run' ? 'on' : ''} onClick={handleModeRun}>
          Run
        </button>
        {/* U3 built drive mode but couldn't add it here (Rail.tsx was owned
            by another work package) — the only entry points were Dock.tsx's
            "⛭ Drive" button and DriveCenter's own empty state. Wiring it in
            here, same pattern as Build/Run: entering with no run bound is
            already handled honestly by DriveCenter's DriveEmptyState (offers
            to start a dry run or bind an existing one), so this is just
            `setMode('drive')` — no run-binding logic needed here. */}
        <button type="button" id="mode-drive" aria-pressed={mode === 'drive'} className={mode === 'drive' ? 'on' : ''} onClick={() => setMode('drive')}>
          Drive
        </button>
      </div>

      {isError ? (
        // W2 — the rail named the failure but offered no way out of it, so a transient
        // 502 meant reloading the page. Retry refetches BOTH queries: either one can be
        // the failed half, and the operator should not have to know which.
        <QueryError
          message={workflowsQ.error?.message ?? nodesQ.error?.message ?? 'Failed to load the node rail.'}
          onRetry={() => {
            void workflowsQ.refetch();
            void nodesQ.refetch();
          }}
          inline
        />
      ) : isLoading ? (
        <div style={{ padding: '0 6px' }}>
          <Skeleton lines={6} />
        </div>
      ) : (
        <div id="rail" onKeyDown={handleRailKeyDown}>
          {rowsByPhase.map(([label, rows]) =>
            rows.length === 0 ? null : (
              <div key={label}>
                <div className="phase">
                  <span className="lbl">{label}</span>
                </div>
                {rows.map(({ nid, n, st, dim }) => {
                  const learnedTs = learnedByNode.get(nid);
                  const learned = typeof learnedTs === 'number' && learnedTs > lastVisitRef.current;
                  return (
                    <RailRow
                      key={nid}
                      nid={nid}
                      n={n}
                      st={st}
                      dim={dim}
                      selected={node === nid}
                      current={run?.cur === nid}
                      wf={wf}
                      evalScore={scoreByNode.get(nid)}
                      errorFreq={wfRunsQ.data ? nodeErrorFrequency(wfRunsQ.data, nid) : 0}
                      learned={learned}
                      // From the BOUND run, not from `run` above — that variable is deliberately null
                      // outside 'run' mode because it gates the status dots and the dimming, and an
                      // operator hand-driving a run in 'drive' mode still needs to see that a node was
                      // completed from a fixture. Provenance is a fact about the run, not about which
                      // view of it is open.
                      runNodeState={boundRunQ.data?.nodes.find((rn) => rn.nodeId === nid) ?? null}
                      onSelect={setNode}
                      rowRef={(el) => {
                        rowRefs.current[nid] = el;
                      }}
                    />
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}

      <div className="railfoot">
        {run && (
          <label>
            <input
              type="checkbox"
              checked={showUneng}
              onChange={(e) => setShowUneng(e.target.checked)}
            />
            show unengaged nodes
          </label>
        )}
        <button type="button" className="ghost" onClick={openGraphOverlay}>
          ⌗ graph overlay
        </button>
      </div>
    </aside>
  );
}
