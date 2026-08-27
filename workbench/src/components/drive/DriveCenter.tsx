// U3 — drive mode's center pane: the step debugger. Rendered by Center.tsx
// in place of the normal tab set when `mode === 'drive'`.
//
//   - Step one node (workflow_run_next_node), then stop — the just-stepped
//     node's output, its validation against the declared output schema,
//     its measured duration and cost (when known — never fabricated) show
//     immediately below.
//   - From there: accept & step again, retry with an edited prompt
//     (workspace_update_node_prompt, then workflow_retry_node), or override
//     the output (opens the U3 override modal).
//   - Breakpoints: a pause-before flag per node, defaulted ON for every
//     'publish'-risk node, persisted per run (components/drive/breakpoints.ts).
//     Step is always a single deliberate node regardless of the flag — the
//     flag's job is to keep "Run until…" (in the dock) from walking past a
//     flagged node without stopping there first; see Dock.tsx's clamped
//     picker.
//   - The node grid: one row per node in this run, with its status, its
//     breakpoint toggle, and — reusing the rail's exact vocabulary, not a
//     second one — the ⎘ override marker.
//
// No bound run: says so, offers to start a dry run or bind an existing one.
// Never a dead mode bar.

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';
import { ActionCancelledError } from '../../api/confirmAction';
import { IS_READ_ONLY } from '../../api/client';
import {
  useNodes,
  useRetryNode,
  useRun,
  useRunCost,
  useRunNextNode,
  useRuns,
  useWorkflowGraph,
  useWorkflows,
} from '../../api/hooks';
import { setNextConfirmTrigger } from '../ConfirmDialog';
import { Btn, Card, Dot, RiskBadge, StatusChip } from '../primitives';
import { toast } from '../Toasts';
import { useStore } from '../../store';
import type { Run, WorkflowNode } from '../../types';
import { formatDurationMs, nodeStatusFromRun, optimisticRunControl, orderedNodes } from '../../screens/Workbench/helpers';
import { ErrorNote, LoadingNote, SchemaIssueList, type SchemaIssue } from '../../screens/Workbench/tabs/Shared';
import { getBreakpoint, toggleBreakpoint } from './breakpoints';
import { errMsg, extractOutputList, findOverride, formatWhen, normalizeValidationIssues } from './overrideStatus';

/** Same defensive per-node cost read the trace waterfall uses (its own copy
 * — trace/TraceWaterfallModal.tsx is not ours to edit or import from). The
 * live ledger shape this reads is documented on RawRunCostLedger in
 * adapters.ts; fixture mode genuinely carries none, which reads as "cost
 * not available for this node" below rather than a fabricated $0.00. */
function costByNode(ledger: unknown): Map<string, number> {
  const stages = (ledger as { stages?: Array<{ nodeId: string; costUsdEstimate?: number }> } | undefined)?.stages;
  const map = new Map<string, number>();
  if (Array.isArray(stages)) {
    for (const s of stages) {
      if (typeof s.nodeId === 'string' && typeof s.costUsdEstimate === 'number') map.set(s.nodeId, s.costUsdEstimate);
    }
  }
  return map;
}

// U7 polish — operator copy, not developer copy (same fix as tabs/Shared.tsx's
// READONLY_REASON; kept as a separate local copy here rather than importing
// across that screen/component boundary).
const READONLY_REASON_DRIVE =
  'This workbench is connected read-only right now, so nothing here can be saved or run. Ask whoever administers this deployment to switch it to read-write.';

interface LastStepped {
  nodeId: string;
  at: number;
}

// ============================================================================
// Empty state — no run bound. Offers to start a dry run or bind an existing
// one; never a dead mode bar.
// ============================================================================

function DriveEmptyState({ wf }: { wf: string }) {
  const openStartModal = useStore((s) => s.openStartModal);
  const bindRunForDrive = useStore((s) => s.bindRunForDrive);
  const workflowsQ = useWorkflows();
  const wfRunsQ = useRuns({ workflowId: wf });
  const workflow = workflowsQ.data?.find((w) => w.id === wf);
  const recent = (wfRunsQ.data ?? []).slice(0, 6);

  return (
    <Card label="drive mode">
      <p style={{ margin: '0 0 12px', color: 'var(--muted)' }}>
        Hand-drive a run of <b>{workflow?.name ?? wf}</b> one node at a time — step, retry with an edited prompt, or
        insert the output variant you prefer. Drive mode needs a bound run first.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <Btn variant="pri" disabled={IS_READ_ONLY} onClick={openStartModal}>
          ▸ Start a dry run…
        </Btn>
      </div>
      <span className="lbl">bind an existing run</span>
      {wfRunsQ.isLoading ? (
        <LoadingNote>loading recent runs…</LoadingNote>
      ) : wfRunsQ.isError ? (
        <ErrorNote message={wfRunsQ.error?.message} />
      ) : recent.length === 0 ? (
        <p className="note" style={{ margin: 0 }}>No runs yet for this workflow.</p>
      ) : (
        recent.map((r) => (
          <button
            key={r.id}
            type="button"
            className="nrow"
            onClick={() => bindRunForDrive(r.id, wf, r.cur ?? '')}
          >
            <Dot status={r.status} />
            <span className="nm mono" style={{ fontSize: 11 }}>
              …{r.id.slice(-6)} · {r.proj}
            </span>
            <span className="fan">{r.started.split(' ').slice(0, 2).join(' ')}</span>
          </button>
        ))
      )}
    </Card>
  );
}

// ============================================================================
// Upstream readout — for the node about to run, which of its dependencies
// carry an operator override, so "a downstream node reads it" is something
// the operator can actually see, not just something that happens invisibly
// server-side.
// ============================================================================

function UpstreamDep({ depId, runId }: { depId: string; runId: string }) {
  const q = useQuery({
    queryKey: ['nodeOutputs', depId, runId],
    queryFn: () => verbs.nodeListOutputs({ nodeId: depId, runId }),
    staleTime: 15_000,
    retry: false,
  });
  const override = findOverride(extractOutputList(q.data));
  return (
    <span className="mono" style={{ fontSize: 11 }}>
      {depId}
      {override ? (
        <span style={{ color: 'var(--run)' }}> (⎘ operator override, {formatWhen(override.createdAt)})</span>
      ) : (
        <span style={{ color: 'var(--faint)' }}> (no override)</span>
      )}
    </span>
  );
}

function UpstreamReadout({ nodeId, runId, deps }: { nodeId: string; runId: string; deps: string[] }) {
  if (deps.length === 0) return null;
  return (
    <p className="note" style={{ margin: '8px 0 0', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <span>{nodeId} reads from:</span>
      {deps.map((d, i) => (
        <span key={d}>
          <UpstreamDep depId={d} runId={runId} />
          {i < deps.length - 1 ? ',' : ''}
        </span>
      ))}
    </p>
  );
}

// ============================================================================
// Node grid — one row per node: status, breakpoint toggle, override marker.
// Same override vocabulary as Rail.tsx (⎘ / chip-override / same title).
// ============================================================================

function GridRow({
  nid,
  n,
  run,
  bpVersion,
  onToggleBp,
  selected,
  onSelect,
}: {
  nid: string;
  n: WorkflowNode | undefined;
  run: Run;
  bpVersion: number;
  onToggleBp: (nid: string, risk: string | undefined) => void;
  selected: boolean;
  onSelect: (nid: string) => void;
}) {
  void bpVersion; // forces a re-render on toggle without threading state through every row
  const status = nodeStatusFromRun(run, nid);
  const runNode = run.nodes.find((x) => x.nodeId === nid);
  const bp = getBreakpoint(run.id, nid, n?.risk);

  const overrideQ = useQuery({
    queryKey: ['nodeOutputs', nid, run.id],
    queryFn: () => verbs.nodeListOutputs({ nodeId: nid, runId: run.id }),
    enabled: status === 'completed',
    staleTime: 30_000,
    retry: false,
  });
  const hasOverride = overrideQ.isSuccess && Boolean(findOverride(extractOutputList(overrideQ.data)));

  return (
    <tr className={['drive-gridrow', selected ? 'sel' : ''].filter(Boolean).join(' ')}>
      <td style={{ padding: '4px 8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="stop before this node runs (Run until…)">
          <input type="checkbox" checked={bp} onChange={() => onToggleBp(nid, n?.risk)} />
        </label>
      </td>
      <td style={{ padding: '4px 8px' }}>
        <Dot status={status} />
      </td>
      <td style={{ padding: '4px 8px' }}>
        <button type="button" className="mono" style={{ textAlign: 'left', color: 'var(--ink)' }} onClick={() => onSelect(nid)}>
          {nid}
        </button>
      </td>
      <td style={{ padding: '4px 8px' }}>{n && n.risk === 'publish' && <RiskBadge risk="publish" />}</td>
      <td style={{ padding: '4px 8px' }}>
        {hasOverride && (
          <span className="chip-override" title="carries an operator output override in this run">
            ⎘ override
          </span>
        )}
      </td>
      <td style={{ padding: '4px 8px', textAlign: 'right' }} className="mono">
        {typeof runNode?.durationMs === 'number' ? formatDurationMs(runNode.durationMs) : '—'}
      </td>
    </tr>
  );
}

// ============================================================================
// Step result — the just-stepped node's output/validation/duration/cost,
// and the three actions available from there.
// ============================================================================

function StepResultCard({
  run,
  lastStepped,
  wf,
  onStepAgain,
  stepping,
}: {
  run: Run;
  lastStepped: LastStepped;
  wf: string;
  onStepAgain: (triggerEl: HTMLElement | null) => void;
  stepping: boolean;
}) {
  const qc = useQueryClient();
  const nodeId = lastStepped.nodeId;
  const openModal = useStore((s) => s.openModal);
  const retryM = useRetryNode();
  const costQ = useRunCost(run.id);
  const nodesQ = useNodes(wf);
  const node = nodesQ.data?.find((n) => n.id === nodeId);

  const [retryOpen, setRetryOpen] = useState(false);
  const [retryText, setRetryText] = useState('');
  const [retryBusy, setRetryBusy] = useState(false);

  const promptQ = useQuery({
    queryKey: ['effectivePrompt', nodeId],
    queryFn: () => verbs.nodeGetEffectivePrompt({ nodeId }),
    enabled: retryOpen,
  });

  useEffect(() => {
    setRetryOpen(false);
    setRetryText('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  useEffect(() => {
    if (retryOpen && promptQ.data && retryText === '') setRetryText(promptQ.data.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryOpen, promptQ.data]);

  const outputsQ = useQuery({
    queryKey: ['nodeOutputs', nodeId, run.id],
    queryFn: () => verbs.nodeListOutputs({ nodeId, runId: run.id }),
  });
  const list = useMemo(() => extractOutputList(outputsQ.data), [outputsQ.data]);
  const entry = list[0];
  const override = findOverride(list);

  const schemaQ = useQuery({
    queryKey: ['outputSchema', nodeId],
    queryFn: () => verbs.nodeGetOutputSchema({ nodeId }),
  });

  const validateQ = useQuery({
    queryKey: ['validateOutput', nodeId, entry?.id],
    queryFn: () => verbs.nodeValidateOutput({ nodeId, output: entry?.value }),
    enabled: Boolean(entry),
  });
  const issues: SchemaIssue[] = validateQ.data ? (validateQ.data.valid ? [] : normalizeValidationIssues(validateQ.data.issues)) : [];

  const status = nodeStatusFromRun(run, nodeId);
  const runNode = run.nodes.find((n) => n.nodeId === nodeId);
  const costMap = useMemo(() => costByNode(costQ.data?.ledger), [costQ.data]);
  const cost = costMap.get(nodeId);

  async function applyEditAndRetry(triggerEl: HTMLElement | null) {
    setRetryBusy(true);
    try {
      setNextConfirmTrigger(triggerEl);
      await verbs.workspaceUpdateNodePrompt({ nodeId, prompt: retryText });
      setNextConfirmTrigger(triggerEl);
      await optimisticRunControl(qc, run.id, { status: 'running', cur: nodeId }, () =>
        retryM.mutateAsync({ runId: run.id, nodeId }),
      );
      toast('Retrying with edited prompt', `workspace_update_node_prompt + workflow_retry_node → ${nodeId}`);
      setRetryOpen(false);
      qc.invalidateQueries({ queryKey: ['nodeOutputs', nodeId, run.id] });
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Retry failed', errMsg(err));
    } finally {
      setRetryBusy(false);
    }
  }

  return (
    <Card label={`just ran · ${nodeId}${node?.name ? ` — ${node.name}` : ''}`} style={{ borderLeft: '3px solid var(--acc-dim)' }}>
      <div className="kv" style={{ gridTemplateColumns: '110px 1fr', fontSize: 12, marginBottom: 8 }}>
        <span className="k">status</span>
        <span><StatusChip status={status} /></span>
        <span className="k">duration</span>
        <span className="num">{typeof runNode?.durationMs === 'number' ? formatDurationMs(runNode.durationMs) : 'not measured for this node'}</span>
        <span className="k">cost</span>
        <span className="num">{typeof cost === 'number' ? `$${cost.toFixed(3)}` : 'not available for this node'}</span>
        <span className="k">validation</span>
        <span>
          {!entry ? (
            <span className="note" style={{ margin: 0 }}>no output recorded to validate yet</span>
          ) : validateQ.isLoading ? (
            <LoadingNote>validating…</LoadingNote>
          ) : validateQ.isError ? (
            <ErrorNote message={validateQ.error?.message} />
          ) : issues.length === 0 ? (
            <span className="valnote">✓ validates against the declared output schema</span>
          ) : (
            <span style={{ color: 'var(--bad)' }}>{issues.length} schema issue{issues.length === 1 ? '' : 's'}</span>
          )}
        </span>
      </div>
      <SchemaIssueList issues={issues} />

      {override && (
        <p className="note" style={{ color: 'var(--run)', margin: '4px 0 8px' }}>
          ⎘ this output was supplied by the operator, {formatWhen(override.createdAt)}
          {override.note ? ` — note: "${override.note}"` : ' — no note given'}. It did not come from the node itself.
        </p>
      )}

      <span className="lbl">output</span>
      {outputsQ.isLoading ? (
        <LoadingNote>loading recorded output…</LoadingNote>
      ) : outputsQ.isError ? (
        <ErrorNote message={outputsQ.error?.message} />
      ) : !entry ? (
        <p className="note" style={{ margin: '4px 0 0' }}>No output recorded for this node in this run yet.</p>
      ) : (
        <div className="promptbox" style={{ maxHeight: 180 }}>{JSON.stringify(entry.value, null, 2)}</div>
      )}
      {schemaQ.data && (
        <p className="note" style={{ margin: '4px 0 0' }}>schema reference available — see Schemas tab in Build mode for the full declaration.</p>
      )}

      <div className="editnote" style={{ marginTop: 12 }}>
        <Btn
          variant="pri"
          disabled={stepping || IS_READ_ONLY || run.status === 'completed'}
          title={IS_READ_ONLY ? READONLY_REASON_DRIVE : undefined}
          onClick={(e) => onStepAgain(e.currentTarget)}
        >
          {stepping ? 'Stepping…' : '✓ Accept & step again'}
        </Btn>
        <Btn disabled={IS_READ_ONLY} onClick={() => setRetryOpen((v) => !v)}>
          ✎ Retry with edited prompt
        </Btn>
        <Btn disabled={IS_READ_ONLY} onClick={() => openModal('override', { node: nodeId, run: run.id })}>
          ⎘ Override output…
        </Btn>
      </div>

      {retryOpen && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="drive-retry-prompt">edited prompt for {nodeId}</label>
          {promptQ.isLoading ? (
            <LoadingNote>resolving effective prompt…</LoadingNote>
          ) : (
            <textarea id="drive-retry-prompt" rows={6} value={retryText} onChange={(e) => setRetryText(e.target.value)} />
          )}
          <div className="editnote">
            <Btn onClick={() => setRetryOpen(false)}>Cancel</Btn>
            <Btn
              variant="pri"
              disabled={retryBusy || !retryText.trim() || IS_READ_ONLY}
              onClick={(e) => applyEditAndRetry(e.currentTarget)}
            >
              {retryBusy ? 'Applying…' : 'Save prompt edit & retry node →'}
            </Btn>
          </div>
          <p className="note">
            Two separate confirmations follow — one for workspace_update_node_prompt, one for workflow_retry_node.
            Neither is skipped.
          </p>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// Main session — a bound run.
// ============================================================================

function DriveSession({ runId, wf }: { runId: string; wf: string }) {
  const qc = useQueryClient();
  const setNode = useStore((s) => s.setNode);
  const selectedNode = useStore((s) => s.node);
  const setMode = useStore((s) => s.setMode);
  const unbindRun = useStore((s) => s.unbindRun);

  const runQ = useRun(runId);
  const workflowsQ = useWorkflows();
  const nodesQ = useNodes(wf);
  const graphQ = useWorkflowGraph(wf);
  const runNextM = useRunNextNode();

  const [lastStepped, setLastStepped] = useState<LastStepped | null>(null);
  const [stepping, setStepping] = useState(false);
  const [bpVersion, setBpVersion] = useState(0);

  useEffect(() => {
    setLastStepped(null);
  }, [runId]);

  const run = runQ.data ?? null;
  const workflow = workflowsQ.data?.find((w) => w.id === wf);
  const order = useMemo(() => (workflow ? orderedNodes(workflow) : []), [workflow]);
  const nodesById = useMemo(() => {
    const map = new Map<string, WorkflowNode>();
    for (const n of nodesQ.data ?? []) map.set(n.id, n);
    return map;
  }, [nodesQ.data]);

  const nextNodeId = run?.cur ?? null;
  const nextNode = nextNodeId ? nodesById.get(nextNodeId) : undefined;
  const nextDeps = useMemo(() => {
    if (!nextNodeId) return [];
    const raw = graphQ.data?.nodes.find((n) => n.id === nextNodeId);
    return raw?.dependsOn ?? [];
  }, [graphQ.data, nextNodeId]);

  async function handleStep(triggerEl: HTMLElement | null) {
    if (!run || !run.cur) return;
    const steppedId = run.cur;
    const idx = order.indexOf(steppedId);
    const nextId = idx >= 0 && idx + 1 < order.length ? order[idx + 1] : null;
    setNextConfirmTrigger(triggerEl);
    setStepping(true);
    try {
      await optimisticRunControl(
        qc,
        run.id,
        { status: nextId ? 'running' : 'completed', cur: nextId, done: run.done + 1 },
        () => runNextM.mutateAsync({ runId: run.id }),
      );
      setLastStepped({ nodeId: steppedId, at: Date.now() });
      toast('Stepped', `workflow_run_next_node → ${steppedId} in …${run.id.slice(-10)}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Step failed', errMsg(err));
    } finally {
      setStepping(false);
    }
  }

  function toggleBp(nid: string, risk: string | undefined) {
    if (!run) return;
    toggleBreakpoint(run.id, nid, risk);
    setBpVersion((v) => v + 1);
  }

  // U7 polish — error checked before loading (mirrors Rail.tsx's P2-02
  // fix), and workflowsQ's own error is now actually surfaced: two
  // independent queries, so checking the combined isLoading first used to
  // hide an already-final workflowsQ failure behind "loading run…" for as
  // long as runQ was still in flight, and never showed it at all once
  // runQ settled (only runQ.isError was ever checked below).
  if (runQ.isError || workflowsQ.isError) {
    return (
      <Card label="drive mode">
        <ErrorNote message={runQ.error?.message ?? workflowsQ.error?.message} />
      </Card>
    );
  }
  if (runQ.isLoading || workflowsQ.isLoading) {
    return <Card label="drive mode"><LoadingNote>loading run…</LoadingNote></Card>;
  }
  if (!run) {
    return (
      <Card label="drive mode">
        <p className="note" style={{ margin: 0 }}>
          <span className="mono">{runId}</span> could not be resolved (workflow_get_run returned nothing for it).
        </p>
      </Card>
    );
  }

  const nextBp = nextNodeId ? getBreakpoint(run.id, nextNodeId, nextNode?.risk) : false;

  return (
    <>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span className="lbl" style={{ display: 'block', marginBottom: 4 }}>drive mode — hand-driving</span>
          <span className="mono" style={{ fontSize: 12.5 }}>{run.id}</span> <StatusChip status={run.status} />{' '}
          <span className="num" style={{ fontSize: 12 }}>{run.done}/{order.length || run.nodes.length} nodes</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={() => setMode('run')}>← run mode</Btn>
          <Btn onClick={unbindRun}>unbind</Btn>
        </div>
      </div>

      {run.status === 'completed' || !run.cur ? (
        <Card label="up next" style={{ borderLeft: '3px solid var(--acc-dim)' }}>
          <p className="note" style={{ margin: 0 }}>This run has no remaining node to step — it's {run.status}.</p>
        </Card>
      ) : (
        <Card label="up next" style={{ borderLeft: '3px solid var(--acc-dim)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 13 }}>{run.cur}</span>
            {nextNode && nextNode.risk === 'publish' && <RiskBadge risk="publish" />}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={nextBp} onChange={() => toggleBp(run.cur as string, nextNode?.risk)} />
              breakpoint (stops "Run until…" before this node)
            </label>
          </div>
          <UpstreamReadout nodeId={run.cur} runId={run.id} deps={nextDeps} />
          <div className="editnote">
            <Btn
              variant="pri"
              disabled={stepping || IS_READ_ONLY}
              title={IS_READ_ONLY ? READONLY_REASON_DRIVE : undefined}
              onClick={(e) => handleStep(e.currentTarget)}
            >
              {stepping ? 'Stepping…' : `▸ Step (run ${run.cur})`}
            </Btn>
            <Btn
              disabled={IS_READ_ONLY}
              title="Supply this node's output yourself instead of running it"
              onClick={() => useStore.getState().openModal('override', { node: run.cur as string, run: run.id })}
            >
              ⎘ Override output…
            </Btn>
          </div>
        </Card>
      )}

      {lastStepped && (
        <StepResultCard run={run} lastStepped={lastStepped} wf={wf} onStepAgain={handleStep} stepping={stepping} />
      )}

      <Card label={`node grid · ${order.length || run.nodes.length} nodes`}>
        <div style={{ overflowX: 'auto' }}>
          <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--faint)' }}>
                <th style={{ padding: '4px 8px' }}>brk</th>
                <th style={{ padding: '4px 8px' }} />
                <th style={{ padding: '4px 8px' }}>node</th>
                <th style={{ padding: '4px 8px' }}>risk</th>
                <th style={{ padding: '4px 8px' }}>override</th>
                <th style={{ padding: '4px 8px', textAlign: 'right' }}>duration</th>
              </tr>
            </thead>
            <tbody>
              {(order.length ? order : run.nodes.map((n) => n.nodeId)).map((nid) => (
                <GridRow
                  key={nid}
                  nid={nid}
                  n={nodesById.get(nid)}
                  run={run}
                  bpVersion={bpVersion}
                  onToggleBp={toggleBp}
                  selected={selectedNode === nid}
                  onSelect={setNode}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          breakpoints persist per run in this browser only. Publish-risk nodes default ON — a run must not walk into
          a live publish while you're not looking.
        </p>
      </Card>
    </>
  );
}

export function DriveCenter() {
  const wf = useStore((s) => s.wf);
  const runId = useStore((s) => s.runId);

  if (!runId) return <DriveEmptyState wf={wf} />;
  return <DriveSession runId={runId} wf={wf} />;
}
