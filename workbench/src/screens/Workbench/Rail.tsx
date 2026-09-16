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

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkflowNodes, useWorkflowRecentRuns, useRubrics, useRun, useRunNode, useWorkflows } from '../../api/hooks';
import { changesListEvents } from '../../api/verbs';
import { ActionCancelledError } from '../../api/confirmAction';
import { IS_READ_ONLY } from '../../api/client';
import { toast } from '../../components/Toasts';
import { isLiveRun, isPublishTailNode, suppliedOutputMarker } from '../../components/drive/overrideStatus';
import { Dot } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { QueryError } from '../../components/QueryError';
import { QuickLookPopover } from '../../components/quicklook/QuickLookPopover';
import { useNodeQuickLook } from '../../components/quicklook/useNodeQuickLook';
import { useStore } from '../../store';
import type { Run, WorkflowNode } from '../../types';
import { formatDurationMs, nodeErrorFrequency, nodeRunStatus, orderedNodes, type NodeRunStatus } from './helpers';

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
  provenance,
  durationMs,
  onPushThrough,
  pushThroughBusy,
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
  /** This node's supplied-output provenance in the bound run, straight from the
   * run record (overrideStatus.ts's suppliedOutputMarker): 'default_output'
   * (pushed through from its standing default), 'operator_override' (a pasted
   * operator value), or null — which means this node produced its own output,
   * the normal case, and is NOT a reason to go asking the server anything. */
  provenance: 'default_output' | 'operator_override' | null;
  /** W4 — this node's duration in the BOUND run, off the run record. */
  durationMs?: number;
  /** W4 — offered when this node is queued in a bound run and carries a standing default. */
  onPushThrough?: () => void;
  pushThroughBusy?: boolean;
  onSelect: (id: string) => void;
  rowRef: (el: HTMLButtonElement | null) => void;
}) {
  const ql = useNodeQuickLook(nid, wf);

  // THE PER-NODE QUERY IS GONE, and it is gone rather than narrowed.
  //
  // It asked node_list_outputs, once per row, whether this node carried an entry typed
  // 'operator_override'. Two things were wrong with that, and the first one alone is fatal:
  //
  //   1. THE LIVE SERVER NEVER PRODUCES THAT TYPE. `node_list_outputs` returns the run's artifacts
  //      typed by the node's own `produces[0]` (verified live 2026-09-15 against
  //      run_1789486803011_iz521v: type "document_render.execute.v1"). Only the fixture mock
  //      synthesized an 'operator_override' row — which is exactly why this survived review twice.
  //      The query could only ever answer "no", for every run, old or new.
  //   2. ITS GUARD NEVER CLOSED. `needsLegacyCheck = provenance === null` reads "the record says
  //      nothing about this node" as "the record is too old to know" — but absence is the NORMAL
  //      case: a node that produced its own output carries no outputProvenance at all. So even after
  //      the field reached the compact run view, the guard stayed true for essentially every node and
  //      the query fired for every completed one, on every paint. 25 requests on a publishing run,
  //      each one guaranteed to return nothing useful.
  //
  // The run record is now the only source, which is what it was always meant to be: a node whose
  // output was supplied carries `outputProvenance`, and a node without one supplied nothing.
  const hasOverride = provenance === 'operator_override';
  const defaulted = provenance === 'default_output';

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
        {/* W4 — HOW this node runs, at a glance. A deterministic node has no prompt and no grants:
            its behaviour is engine code, and the operator needs to know that before opening a Prompt
            tab that is empty by construction. Computed server-side (the summary projection drops the
            route metadata a client would need to derive it). */}
        {n?.executionKind && (
          <span
            className="kindglyph lbl"
            title={n.executionKind === 'deterministic' ? 'deterministic — engine code, no model turn. See the I/O tab for its algorithm.' : 'model — dispatched to a model with this node’s prompt'}
            style={{ marginRight: 4 }}
          >
            {n.executionKind === 'deterministic' ? '⚙' : '◇'}
          </span>
        )}
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
          <span className="chip-override" title="carries an operator output override in this run">
            ⎘
          </span>
        )}
        {defaulted && (
          <span className="chip-default" title="this node's output was pushed through from its standing default — no model turn, and this run can never publish live while it stands">
            ⚙
          </span>
        )}
        {n && n.fan > 1 && (
          <span className="fan" title={`${n.fan} upstream inputs`}>
            ⇐{n.fan}
          </span>
        )}
        {typeof durationMs === 'number' && durationMs > 0 && (
          <span className="lbl" title="how long this node took in the bound run">
            {formatDurationMs(durationMs)}
          </span>
        )}
        {n && n.risk === 'publish' && (
          <span className="risk publish" title="publish risk">
            P
          </span>
        )}
      </button>
      {/* W4 — push-through, on ANY queued node rather than only the run's "up next" one. A node
          deep in the pipeline is exactly the one an operator wants to jump to, and the server has
          always addressed a push-through by node id. Only offered when the node actually carries a
          standing default (`hasDefaultOutput`, one bit on the summary row) — a control that can only
          refuse is worse than no control. */}
      {onPushThrough && (
        <button
          type="button"
          className="btn pushthrough"
          disabled={pushThroughBusy}
          title={`Push ${nid} through on its standing default — no model turn, no cost. This run can never publish live afterwards.`}
          onClick={(e) => {
            e.stopPropagation();
            onPushThrough();
          }}
          style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', padding: '1px 5px', fontSize: 11 }}
        >
          ⚙▸
        </button>
      )}
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
  const nodesQ = useWorkflowNodes(wf);
  // W1 — this panel renders a handful of "recent runs · this workflow" rows; ask the
  // server for exactly that rather than taking the default 20-row page and slicing.
  // W5 — `detail: 'full'` REMOVED. It was pulling five whole run records (up to 1.2 MB each) on
  // every paint for what the failure chips actually need: one status per node. A summary row now
  // carries `nodeStatuses` straight off the run index, and the adapter expands it into the same
  // nodes[] array nodeErrorFrequency already reads — so the chips are unchanged and this listing
  // opens no run blobs at all.
  //
  // The filter object is now BYTE-IDENTICAL to DriveCenter's, so react-query's ['runs', filters] key
  // dedupes those two into ONE in-flight request instead of firing both at first paint. That
  // coincidence is load-bearing: keep the shapes identical, or the dedupe silently stops happening.
  const wfRunsQ = useWorkflowRecentRuns(wf);
  const boundRunQ = useRun(runId);
  // W3 — score glyphs and "learned since your last visit" badges are decoration on a rail that
  // has to be usable before either arrives. Both wait until the rail has actually painted (the
  // node set is in hand), so neither is on the critical path; both already degrade to "no badge"
  // on failure, which is what makes deferring them safe rather than merely cheaper.
  const railPainted = Boolean(nodesQ.data?.length);
  const rubricsQ = useRubrics({ enabled: railPainted });

  // U5 — one call for the whole rail (not per row): every learning-sourced
  // change made by an agent, grouped by node below. `changes_list` is
  // documented working live (contracts/README.md) — a failure here degrades
  // to "no learned badges", never a rail-wide error.
  const learningChangesQ = useQuery({
    queryKey: ['changes', 'learning-agent'],
    queryFn: () => changesListEvents({ actorKind: 'agent', source: 'learning' }),
    retry: false,
    enabled: railPainted,
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

  // W3 — the load-budget seam. DEV-only, like App.tsx's `__queryClient` handle: stamps the moment
  // the rail became INTERACTIVE (it has rows and one of them is selected), so
  // tests/firstPaintBudget.spec.ts can separate the verbs the first paint blocks on from the ones
  // that legitimately start the instant it is usable — the inspector's read of the adopted node,
  // the score glyphs, the learned badges. Sampling "when the row appears" cannot tell those apart;
  // a timestamp can. Never in a production bundle.
  // W4 — the push-through itself. `workflow.run_node { useDefaultOutput }` addresses ONE node by
  // name and always has; what changes here is that the rail offers it on any queued node rather
  // than only on the run's own cursor. Failures surface as a toast with the server's own words —
  // `default_output_missing`, `upstream_incomplete` naming the first blocking node, or the
  // defaulted-publish refusal — because every one of those is something the operator can act on.
  const [pushingNodeId, setPushingNodeId] = useState<string | null>(null);
  const runNodeM = useRunNode();

  /**
   * W7 — the upstream nodes this run has NOT completed for a target node.
   *
   * The comment above lists `upstream_incomplete` among the refusals this control can surface. It
   * cannot: that check is scoped to `defaultUpstream`, which this call does not send. Without it
   * the server writes the named node's output "whatever state its upstream is in" (its own schema's
   * words) — so pushing a node near the tail of a run that is still near the head SUCCEEDS, and
   * writes an output built from inputs that were never produced. Offering the control on any queued
   * node was W4's deliberate change and stays; reporting that as an unqualified success was not.
   */
  function incompleteUpstream(targetNodeId: string): string[] {
    const deps = nodesById.get(targetNodeId)?.dependsOn ?? [];
    if (!deps.length || !run) return [];
    return deps.filter((depId) => run.nodes.find((entry) => entry.nodeId === depId)?.status !== 'completed');
  }

  async function pushThrough(targetNodeId: string, targetRunId: string) {
    setPushingNodeId(targetNodeId);
    const pending = incompleteUpstream(targetNodeId);
    try {
      await runNodeM.mutateAsync({ runId: targetRunId, nodeId: targetNodeId, useDefaultOutput: true });
      toast(
        'Pushed through',
        pending.length
          ? `${targetNodeId} completed on its standing default — no model turn, no cost. Its upstream (${pending.join(', ')}) has not run on this run, so that default was written over inputs this run never produced.`
          : `${targetNodeId} completed on its standing default — no model turn, no cost.`,
      );
    } catch (error) {
      if (error instanceof ActionCancelledError) return;
      toast('Push-through failed', error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setPushingNodeId(null);
    }
  }

  const railInteractive = Boolean(node) && visibleIds.length > 0;
  useEffect(() => {
    if (!import.meta.env.DEV || !railInteractive || typeof window === 'undefined') return;
    const w = window as unknown as { __railInteractiveAt?: number };
    w.__railInteractiveAt ??= Date.now();
  }, [railInteractive]);

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
                      provenance={suppliedOutputMarker(run, nid)}
                      durationMs={run?.nodes.find((entry) => entry.nodeId === nid)?.durationMs ?? undefined}
                      onPushThrough={
                        // Offered only where it can actually succeed. The server refuses a supplied
                        // output on a node that writes to a live client, on a live run
                        // (defaulted_publish_node_refused) — the same rule drive mode already
                        // applies to its own button. A control whose only outcome is a refusal is
                        // worse than no control.
                        run && st === 'queued' && n?.hasDefaultOutput && !IS_READ_ONLY && !(isLiveRun(run) && isPublishTailNode(n))
                          ? () => void pushThrough(nid, run.id)
                          : undefined
                      }
                      pushThroughBusy={pushingNodeId === nid}
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
