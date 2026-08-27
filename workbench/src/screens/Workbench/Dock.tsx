// WP-21/WP-23 — the run dock: bound-run card, controls, gate panel, and
// timeline. Markup/behaviour mirror spec/mockup.html's `<aside class="dock">`
// and renderDock()/rc()/gateGo() (~line 758-802). Class vocabulary only — no
// new CSS. Phase 1 (WP-11) shipped every control disabled with a "Phase 2"
// tooltip; this WP wires them for real, through confirmAction (HANDOFF §5.1
// — every mutating verb, no exceptions) with optimistic updates + rollback
// (helpers.ts's optimisticRunControl).

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNodes, usePauseRun, useResumeRun, useCancelRun, useResetRun, useRetryNode, useRunNextNode, useRunUntil, useRun, useRunCost, useRuns, useWorkflows } from '../../api/hooks';
import { ActionCancelledError, confirmAction } from '../../api/confirmAction';
import { IS_READ_ONLY, callVerb } from '../../api/client';
import { workflowPublishReadiness } from '../../api/verbs';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { Btn, Dot, Prog, StatusChip } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { toast } from '../../components/Toasts';
import { useStore } from '../../store';
import type { Run, RunStatus } from '../../types';
import {
  DEFAULT_GATE_COPY_DOCK,
  GATE_COPY,
  timelineBars,
  gateApproveEffect,
  gateDeclineEffect,
  isRealPublishGate,
  optimisticRunControl,
  orderedNodes,
} from './helpers';
// U3 — drive mode reuses this same dock (Pause/Step/Run until/Retry/Cancel/
// Reset are still exactly the right controls for a hand-driven run); the one
// thing that changes is "Run until…" clamping its target list at the first
// breakpointed node, so the operator can never pick a target that would run
// straight through a flagged node unattended.
import { getBreakpoint } from '../../components/drive/breakpoints';

// U7 polish — operator copy, not developer copy (see tabs/Shared.tsx's
// own READONLY_REASON, kept as a separate local copy per this file's
// existing pattern rather than importing across that boundary).
const READONLY_REASON =
  'This workbench is connected read-only right now, so nothing here can be saved or run. Ask whoever administers this deployment to switch it to read-write.';

function unavailableBecause(status: RunStatus, blocked: RunStatus[], label: string): string | undefined {
  return blocked.includes(status) ? `${label} is unavailable — the run is already ${status}.` : undefined;
}

/** Extracts the backend's own message from any thrown error (HANDOFF §7.10 — errors show the backend's own message, never a locally-invented one). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function Dock() {
  const wf = useStore((s) => s.wf);
  const mode = useStore((s) => s.mode);
  const runId = useStore((s) => s.runId);
  const node = useStore((s) => s.node);
  const bindRun = useStore((s) => s.bindRun);
  const unbindRun = useStore((s) => s.unbindRun);
  const openStartModal = useStore((s) => s.openStartModal);

  const workflowsQ = useWorkflows();
  const wfRunsQ = useRuns({ workflowId: wf });
  const boundRunQ = useRun(runId);
  // P2-03 split the cost ledger out of workflowGetRun into its own lazy
  // query (see verbs.workflowGetRun's doc comment) — `boundRunQ.data.cost`/
  // `.budget` are only ever the "nothing spent yet" placeholder toRun()
  // fills in before a real ledger lands. The dock is exactly the surface
  // that needs the real numbers (cost-vs-budget display, the near/over-
  // budget alerts below), so it has to actually fetch and merge the
  // ledger — not just read the placeholder off the run object.
  const boundRunActive = (mode === 'run' || mode === 'drive') && Boolean(runId);
  const runCostQ = useRunCost(boundRunActive ? runId : null);

  const setMode = useStore((s) => s.setMode);
  const workflow = workflowsQ.data?.find((w) => w.id === wf);
  // U3 — drive mode is a run-bound mode too; only build mode forces `run`
  // to null regardless of what's bound (see store.ts's unbindRun/bindRun —
  // build mode is the one state that means "no run engaged").
  const run: Run | null =
    boundRunActive && boundRunQ.data
      ? {
          ...boundRunQ.data,
          cost: runCostQ.data?.ledger.totalCostUsdEstimate ?? boundRunQ.data.cost,
          budget: runCostQ.data?.ledger.budget?.budgetUsd ?? boundRunQ.data.budget,
        }
      : null;
  const order = workflow ? orderedNodes(workflow) : [];

  if (mode === 'build' || !run) {
    const recent = (wfRunsQ.data ?? []).slice(0, 4);
    const inDrive = mode === 'drive';
    return (
      <aside className="dock">
        <div className="card">
          <span className="lbl">{inDrive ? 'drive mode' : 'build mode'}</span>
          <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 12px' }}>
            {inDrive
              ? 'No run bound yet — start a dry run or bind one below to hand-drive it.'
              : <>No run bound. Edits save to the store and apply to the next run of{' '}
                  {(workflow?.name ?? wf).toLowerCase()}.</>}
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn
              variant="pri"
              style={{ flex: 1 }}
              disabled={IS_READ_ONLY}
              title={IS_READ_ONLY ? READONLY_REASON : undefined}
              onClick={openStartModal}
            >
              ▸ Start run…
            </Btn>
            {!inDrive && (
              <Btn title="Hand-drive a run one node at a time" onClick={() => setMode('drive')}>
                ⛭ Drive
              </Btn>
            )}
          </div>
        </div>
        <div className="card">
          <span className="lbl">recent runs · this workflow</span>
          {wfRunsQ.isLoading ? (
            <Skeleton lines={3} />
          ) : wfRunsQ.isError ? (
            <p style={{ color: 'var(--bad)', fontSize: 12.5, margin: 0 }}>{wfRunsQ.error?.message}</p>
          ) : recent.length === 0 ? (
            <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: 0 }}>No runs yet for this workflow.</p>
          ) : (
            recent.map((r) => (
              <button
                key={r.id}
                type="button"
                className="nrow"
                onClick={() => bindRun(r.id, wf, r.cur ?? node)}
              >
                <Dot status={r.status} />
                <span className="nm mono" style={{ fontSize: 11 }}>
                  …{r.id.slice(-6)} · {r.proj}
                </span>
                <span className="fan">{r.started.split(' ').slice(0, 2).join(' ')}</span>
              </button>
            ))
          )}
        </div>
      </aside>
    );
  }

  return <BoundDock run={run} order={order} onUnbind={unbindRun} wf={wf} driveMode={mode === 'drive'} />;
}

function BoundDock({
  run,
  order,
  onUnbind,
  wf,
  driveMode,
}: {
  run: Run;
  order: string[];
  onUnbind: () => void;
  wf: string;
  driveMode: boolean;
}) {
  const qc = useQueryClient();
  const setMode = useStore((s) => s.setMode);
  const [showUntilPicker, setShowUntilPicker] = useState(false);
  const [untilTarget, setUntilTarget] = useState('');
  const [showReadiness, setShowReadiness] = useState(false);

  // U3 — only fetched for the breakpoint-risk lookup below; harmless in
  // 'run' mode (cached under the same ['nodes', wf] key Rail/Center already
  // populate, so this is very rarely a fresh network round trip).
  const nodesQ = useNodes(wf);
  const riskById = new Map((nodesQ.data ?? []).map((n) => [n.id, n.risk]));

  const pauseM = usePauseRun();
  const resumeM = useResumeRun();
  const cancelM = useCancelRun();
  const resetM = useResetRun();
  const retryM = useRetryNode();
  const runNextM = useRunNextNode();
  const runUntilM = useRunUntil();

  const total = order.length || 1;
  // P2-05 — measured durations off the run record, not a deterministic
  // placeholder. See helpers.timelineBars().
  const bars = timelineBars(run.nodes, order);
  const timedCount = bars.filter((b) => b.durationMs !== null).length;
  const durBars = bars.map((b) => (
    <i
      key={b.nodeId}
      style={{ height: b.height }}
      className={[run.cur === b.nodeId ? 'hot' : '', b.durationMs === null ? 'dim' : ''].filter(Boolean).join(' ')}
      title={b.title}
    />
  ));

  const curIdx = run.cur ? order.indexOf(run.cur) : -1;
  const remainingAll = curIdx >= 0 ? order.slice(curIdx + 1) : order;
  // U3 — in drive mode, "Run until…" can't be asked to run straight through
  // a breakpointed node: the option list stops AT the first one (reachable
  // — picking it is a deliberate "stop here" choice) and omits everything
  // past it, so nothing beyond a flag is even selectable.
  let clampedAtBreakpoint: string | null = null;
  const remaining = driveMode
    ? (() => {
        const out: string[] = [];
        for (const nid of remainingAll) {
          out.push(nid);
          if (getBreakpoint(run.id, nid, riskById.get(nid))) {
            clampedAtBreakpoint = nid;
            break;
          }
        }
        return out;
      })()
    : remainingAll;

  const readinessQ = useQuery({
    queryKey: ['publish-readiness', run.id],
    queryFn: () => workflowPublishReadiness({ runId: run.id }),
    enabled: showReadiness,
  });

  /**
   * Runs one dock control end to end: optimistic patch → confirmAction-gated
   * mutation → toast → rollback+error on failure. Silent on operator cancel
   * (the confirm dialog already communicated that). `triggerEl` is captured
   * by the caller as `e.currentTarget` — NOT read later off
   * document.activeElement, because a disabled element auto-blurs in every
   * browser and this dialog needs a reliable trigger to refocus once it
   * closes (see ConfirmDialog.tsx's setNextConfirmTrigger doc comment).
   * That's also why these controls are never `disabled` while a mutation is
   * in flight — the confirm dialog's own `.scrim` already blocks all other
   * interaction, so disabling the trigger too would only break focus-return
   * for no safety benefit.
   */
  async function run_(
    triggerEl: HTMLElement | null,
    verb: string,
    patch: Partial<Run>,
    mutate: () => Promise<Run | null>,
    successTitle: string,
  ) {
    setNextConfirmTrigger(triggerEl);
    try {
      await optimisticRunControl(qc, run.id, patch, mutate);
      toast(successTitle, `${verb} → ${run.id.slice(-10)}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast(`${successTitle} failed`, errorMessage(err));
    }
  }

  async function gateDecision(triggerEl: HTMLElement | null, decision: 'approve' | 'decline') {
    const verb = 'workflow_set_operator_publish_decision';
    const patch: Partial<Run> = decision === 'approve' ? { status: 'running' } : { status: 'cancelled' };
    setNextConfirmTrigger(triggerEl);
    try {
      await optimisticRunControl(qc, run.id, patch, () =>
        confirmAction<Run | null>(
          {
            verb,
            effect: decision === 'approve' ? gateApproveEffect(run) : gateDeclineEffect(run),
            danger: decision === 'approve',
          },
          () => callVerb<Run | null>(verb, { runId: run.id, decision }),
        ),
      );
      toast(decision === 'approve' ? 'Approved' : 'Declined', `${verb} → ${run.id.slice(-10)}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast(decision === 'approve' ? 'Approve failed' : 'Decline failed', errorMessage(err));
    }
  }

  const disabledTitle = (reason: string | undefined) => (IS_READ_ONLY ? READONLY_REASON : reason);
  const gateBtnDisabled = IS_READ_ONLY;

  const pctUsed = run.budget ? run.cost / run.budget : null;
  const overBudget = pctUsed !== null && pctUsed >= 1;
  const nearBudget = pctUsed !== null && pctUsed >= 0.8 && !overBudget;

  return (
    <aside className="dock">
      <div className="card">
        <span className="lbl">bound run</span>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 11.5 }}>
            …{run.id.slice(-10)}
          </span>
          <StatusChip status={run.status} />
        </div>
        <div className="kv" style={{ marginTop: 8, gridTemplateColumns: '90px 1fr', fontSize: 12 }}>
          <span className="k">project</span>
          <span>{run.proj}</span>
          <span className="k">mode</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {run.dry ? 'dry' : 'live'} · {run.exec}
          </span>
          <span className="k">progress</span>
          <span className="num">
            {run.done}/{order.length} nodes
          </span>
          <span className="k">cost</span>
          <span className="num" style={{ color: overBudget ? 'var(--bad)' : nearBudget ? 'var(--acc)' : undefined }}>
            ${run.cost.toFixed(2)}
            {run.budget ? ` / $${run.budget}` : ''}
          </span>
        </div>
        {(overBudget || nearBudget) && (
          <p className="note" style={{ color: overBudget ? 'var(--bad)' : 'var(--acc)' }}>
            {overBudget
              ? `over budget by $${(run.cost - (run.budget ?? 0)).toFixed(2)} — an operator should not discover this by reading the number twice.`
              : `approaching budget cap — ${Math.round((pctUsed ?? 0) * 100)}% spent.`}
          </p>
        )}
        <Prog pct={(100 * run.done) / total} />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <Btn style={{ flex: 1 }} onClick={onUnbind}>
            unbind · back to build
          </Btn>
          {driveMode ? (
            <Btn title="Back to the read-only run-following view" onClick={() => setMode('run')}>
              ← run mode
            </Btn>
          ) : (
            <Btn title="Hand-drive this run one node at a time" onClick={() => setMode('drive')}>
              ⛭ Drive
            </Btn>
          )}
        </div>
      </div>

      <div className="card">
        <span className="lbl">controls</span>
        {IS_READ_ONLY && <p className="note" style={{ color: 'var(--acc)', marginTop: 0 }}>{READONLY_REASON}</p>}
        <div className="ctl">
          {run.status === 'paused' ? (
            <Btn
              variant="pri"
              disabled={gateBtnDisabled}
              title={disabledTitle(undefined)}
              onClick={(e) => run_(e.currentTarget, 'workflow_resume_run', { status: 'running' }, () => resumeM.mutateAsync({ runId: run.id }), 'Resumed')}
            >
              Resume
            </Btn>
          ) : (
            <Btn
              disabled={gateBtnDisabled || Boolean(unavailableBecause(run.status, ['completed', 'failed', 'cancelled'], 'Pause'))}
              title={disabledTitle(unavailableBecause(run.status, ['completed', 'failed', 'cancelled'], 'Pause'))}
              onClick={(e) => run_(e.currentTarget, 'workflow_pause_run', { status: 'paused' }, () => pauseM.mutateAsync({ runId: run.id }), 'Paused')}
            >
              Pause
            </Btn>
          )}
          <Btn
            disabled={gateBtnDisabled || Boolean(unavailableBecause(run.status, ['completed', 'cancelled'], 'Run next'))}
            title={disabledTitle(unavailableBecause(run.status, ['completed', 'cancelled'], 'Run next'))}
            onClick={(e) =>
              run_(e.currentTarget, 'workflow_run_next_node', { status: 'running', done: run.done + 1 }, () => runNextM.mutateAsync({ runId: run.id }), 'Ran next node')
            }
          >
            Run next
          </Btn>
          <Btn
            disabled={gateBtnDisabled || Boolean(unavailableBecause(run.status, ['completed', 'cancelled'], 'Run until'))}
            title={disabledTitle(unavailableBecause(run.status, ['completed', 'cancelled'], 'Run until'))}
            onClick={() => {
              setUntilTarget(remaining[0] ?? '');
              setShowUntilPicker((v) => !v);
            }}
          >
            Run until…
          </Btn>
          <Btn
            disabled={gateBtnDisabled || !run.cur}
            title={disabledTitle(run.cur ? undefined : 'Retry node is unavailable — this run has no current node.')}
            onClick={(e) =>
              run.cur &&
              run_(e.currentTarget, 'workflow_retry_node', { status: 'running' }, () => retryM.mutateAsync({ runId: run.id, nodeId: run.cur as string }), 'Retry requested')
            }
          >
            Retry node
          </Btn>
          <Btn
            variant="danger"
            disabled={gateBtnDisabled || Boolean(unavailableBecause(run.status, ['completed', 'failed', 'cancelled'], 'Cancel'))}
            title={disabledTitle(unavailableBecause(run.status, ['completed', 'failed', 'cancelled'], 'Cancel'))}
            onClick={(e) =>
              run_(e.currentTarget, 'workflow_cancel_run', { status: 'cancelled' }, () => cancelM.mutateAsync({ runId: run.id }), 'Cancelled')
            }
          >
            Cancel
          </Btn>
          <Btn
            disabled={gateBtnDisabled}
            title={disabledTitle(undefined)}
            onClick={(e) =>
              run_(
                e.currentTarget,
                'workflow_reset_run',
                { status: 'queued', cur: null, done: 0, err: 0 },
                () => resetM.mutateAsync({ runId: run.id }),
                'Reset',
              )
            }
          >
            Reset
          </Btn>
        </div>
        {showUntilPicker && (
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <label className="lbl" htmlFor="dock-until-target">
              run until (remaining nodes, in order)
            </label>
            {remaining.length === 0 ? (
              <p className="note" style={{ margin: '4px 0 0' }}>No nodes remain after {run.cur}.</p>
            ) : (
              <>
                <select id="dock-until-target" className="mono" value={untilTarget} onChange={(e) => setUntilTarget(e.target.value)}>
                  {remaining.map((nid) => (
                    <option key={nid} value={nid}>
                      {nid}
                    </option>
                  ))}
                </select>
                {clampedAtBreakpoint && (
                  <p className="note" style={{ margin: '4px 0 0' }}>
                    nodes past <span className="mono">{clampedAtBreakpoint}</span> are hidden — it carries a
                    breakpoint, so drive mode won't run through it unattended. Toggle it off in the node grid to
                    reach further.
                  </p>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <Btn onClick={() => setShowUntilPicker(false)}>Cancel</Btn>
                  <Btn
                    variant="pri"
                    disabled={gateBtnDisabled}
                    onClick={(e) => {
                      const trigger = e.currentTarget;
                      setShowUntilPicker(false);
                      run_(
                        trigger,
                        'workflow_run_until',
                        { status: 'running', cur: untilTarget },
                        () => runUntilM.mutateAsync({ runId: run.id, nodeId: untilTarget }),
                        'Running until ' + untilTarget,
                      );
                    }}
                  >
                    Go
                  </Btn>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {run.status === 'blocked' && (
        <div className="gate">
          <span className="lbl">⛔ gate · {run.cur}</span>
          <p>{(run.cur && GATE_COPY[run.cur]) ?? DEFAULT_GATE_COPY_DOCK}</p>
          {isRealPublishGate(run.cur) && (
            <p style={{ color: 'var(--bad)', fontWeight: 600, margin: '0 0 10px' }}>
              Approving here is expected to publish live content — not a draft, not a simulation.
            </p>
          )}
          <Btn variant="danger" disabled={gateBtnDisabled} onClick={(e) => gateDecision(e.currentTarget, 'approve')}>
            Approve &amp; resume
          </Btn>
          <Btn disabled={gateBtnDisabled} onClick={(e) => gateDecision(e.currentTarget, 'decline')}>
            Decline &amp; cancel run
          </Btn>
          <Btn onClick={() => setShowReadiness((v) => !v)}>
            {showReadiness ? 'Hide readiness' : 'View readiness'}
          </Btn>
          {showReadiness && (
            <div style={{ marginTop: 10 }}>
              {readinessQ.isLoading ? (
                <Skeleton lines={3} />
              ) : readinessQ.isError ? (
                <p className="note" style={{ margin: 0, color: 'var(--bad)' }}>{errorMessage(readinessQ.error)}</p>
              ) : (
                <>
                  {readinessQ.data?.checks.map((c) => (
                    <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 5, fontSize: 12 }}>
                      <span
                        className="mono"
                        style={{ color: c.pass === true ? 'var(--ok)' : c.pass === false ? 'var(--bad)' : 'var(--faint)', width: 14, flex: 'none' }}
                      >
                        {c.pass === true ? '✓' : c.pass === false ? '✗' : '?'}
                      </span>
                      <span>
                        {c.label} — <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{c.detail}</span>
                      </span>
                    </div>
                  ))}
                  <p className="note">
                    the evidence, not a vibe — workflow_publish_readiness. Checks above are derived from this run's own
                    record (errors, progress, budget); the operator decision check is never reported as a pass here, since
                    that is exactly what Approve/Decline records.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {run.status === 'failed' && (
        <div className="card" style={{ borderColor: 'color-mix(in srgb,var(--bad) 40%,transparent)' }}>
          <span className="lbl" style={{ color: 'var(--bad)' }}>
            errors ({run.err})
          </span>
          <p className="mono" style={{ fontSize: 11.5, margin: 0 }}>
            {run.cur}: output schema validation failed
          </p>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="lbl" style={{ marginBottom: 0 }}>
            timeline
          </span>
          {/* U5 — entry point into the trace waterfall for this bound run. */}
          <button
            type="button"
            className="btn"
            style={{ padding: '2px 9px', fontSize: 11 }}
            onClick={() => useStore.getState().openModal('waterfall', { run: run.id })}
          >
            ⏱ waterfall
          </button>
        </div>
        <div className="tl">{durBars}</div>
        <p className="note">
          {timedCount > 0
            ? `measured duration, ${timedCount} of ${bars.length} nodes timed — hover a bar for the figure`
            : 'no node in this run has finished yet, so nothing is timed'}
        </p>
        <div className="dockstat">
          <span>{run.started}</span>
          <span>{run.dur}</span>
        </div>
      </div>
    </aside>
  );
}
