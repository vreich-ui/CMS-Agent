// "This run" tab — the execution record for the selected node within the
// bound run. Structure mirrors spec/mockup.html's S.tab==='thisrun' branch
// (renderCenter(), ~line 71). Real data where the read verbs carry it
// (node_get_effective_prompt, node_get_input_schema, node_list_executions,
// stage_get_output); honest gaps where they don't — see the WP report for
// what has no live source in this fixture set (a tool-call log per
// execution; the exact per-node duration/cost breakdown).
//
// WP-54: the four capture buttons are wired for real. Approve / Reject /
// Edit & approve all call `feedback_record`; Record observation calls
// `learning_record_observation` with provenance stamped from this run and
// node. Approve and Edit & approve additionally bump the session-local
// approved-examples overlay (Learning/overlay.ts — the mock backend's
// feedback_record only ever moves `preferencePairs`, never
// `approvedExamples`, whatever verdict is passed; see that file's header).
// Every one of the four is a deliberate, occasional action on one output —
// unlike Compare's rapid-fire verdicts, it goes through the app's normal
// confirm dialog like every other mutating control in this file already
// does (see handleRetry below).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRetryNode } from '../../../api/hooks';
import * as verbs from '../../../api/verbs';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card, KV, StatusChip } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { useStore } from '../../../store';
import type { Run, WorkflowNode } from '../../../types';
import { DEFAULT_GATE_COPY_CENTER, GATE_COPY, optimisticRunControl, type NodeRunStatus } from '../helpers';
import { useEffectivePrompt, useInputSchema, useNodeExecutions, useStageOutputsList } from '../queries';
import { bumpApprovedExamples } from '../../Learning/overlay';
import { Disclosure, ErrorNote, LoadingNote } from './Shared';
// U3 — "an overridden node wears a distinct marker... 'This run' for an
// overridden node must say the output was supplied by the operator, when,
// and with what note — never present an override as if the node produced
// it." Same node_list_outputs reading, same ⎘ vocabulary, as Rail.tsx's
// marker and the override modal.
import { extractOutputList, formatWhen } from '../../../components/drive/overrideStatus';
// Defect A — the one precedence resolution (override > canonical artifact >
// legacy stage record > honest empty message) replacing the old
// stage-store-only read. See that module's header for the full story.
import { boundedOutputText, resolveNodeOutput } from '../outputResolution';

// U7 polish — operator copy, not developer copy (see tabs/Shared.tsx's
// own READONLY_REASON, kept as a separate local copy per this file's
// existing pattern rather than importing across that boundary).
const READONLY_REASON =
  'This workbench is connected read-only right now, so nothing here can be saved or run. Ask whoever administers this deployment to switch it to read-write.';

function CaptureButtons({ nodeId, runId }: { nodeId: string; runId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [recordingObs, setRecordingObs] = useState(false);
  const [editText, setEditText] = useState('');
  const [obsText, setObsText] = useState('');

  const feedbackM = useMutation({ mutationFn: verbs.feedbackRecord });
  const obsM = useMutation({
    mutationFn: verbs.learningRecordObservation,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['observations'] }),
  });

  async function approve(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await feedbackM.mutateAsync({ nodeId, runId, verdict: 'approved' });
      bumpApprovedExamples();
      qc.invalidateQueries({ queryKey: ['readiness'] });
      toast('Approved', `feedback_record → verdict:approved — fills the SFT-example meter`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Approve failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function reject(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await feedbackM.mutateAsync({ nodeId, runId, verdict: 'rejected' });
      toast('Rejected', 'feedback_record → verdict:rejected');
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Reject failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function submitEdit(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await feedbackM.mutateAsync({ nodeId, runId, verdict: 'edited_approved', note: editText });
      bumpApprovedExamples();
      qc.invalidateQueries({ queryKey: ['readiness'] });
      toast('Edited & approved', 'feedback_record → verdict:edited_approved — the edit becomes an SFT example');
      setEditing(false);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Edit & approve failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function submitObservation(triggerEl: HTMLElement | null) {
    if (!obsText.trim()) return;
    setNextConfirmTrigger(triggerEl);
    try {
      await obsM.mutateAsync({ nodeId, runId, txt: obsText });
      toast('Observation recorded', `learning_record_observation → ${nodeId} · ${runId.slice(-10)}`);
      setObsText('');
      setRecordingObs(false);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Record observation failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  const busy = feedbackM.isPending || obsM.isPending;

  return (
    <>
      <div className="editnote">
        <Btn
          disabled={IS_READ_ONLY || busy}
          title={IS_READ_ONLY ? READONLY_REASON : 'Record this output as approved.'}
          onClick={(e) => approve(e.currentTarget)}
        >
          ✓ Approve output
        </Btn>
        <Btn
          variant="danger"
          disabled={IS_READ_ONLY || busy}
          title={IS_READ_ONLY ? READONLY_REASON : 'Record this output as rejected.'}
          onClick={(e) => reject(e.currentTarget)}
        >
          ✗ Reject
        </Btn>
        <Btn
          disabled={IS_READ_ONLY || busy}
          title={IS_READ_ONLY ? READONLY_REASON : 'Edit the output, then record your edited version as approved.'}
          onClick={() => setEditing((v) => !v)}
        >
          ✎ Edit &amp; approve
        </Btn>
        <Btn
          disabled={IS_READ_ONLY || busy}
          title={IS_READ_ONLY ? READONLY_REASON : "Add a note about this node's behavior for the learning system."}
          onClick={() => setRecordingObs((v) => !v)}
        >
          + Record observation
        </Btn>
      </div>

      {editing && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>edited output (becomes an SFT example on submit)</label>
          <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={4} />
          <div className="editnote">
            <Btn onClick={() => setEditing(false)}>Cancel</Btn>
            <Btn variant="pri" disabled={!editText.trim() || busy} onClick={(e) => submitEdit(e.currentTarget)}>
              Submit edit &amp; approve
            </Btn>
          </div>
        </div>
      )}

      {recordingObs && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>
            observation — provenance stamped automatically: node <span className="mono">{nodeId}</span>, run{' '}
            <span className="mono">{runId.slice(-10)}</span>
          </label>
          <textarea value={obsText} onChange={(e) => setObsText(e.target.value)} rows={3} placeholder="What did you notice?" />
          <div className="editnote">
            <Btn onClick={() => setRecordingObs(false)}>Cancel</Btn>
            <Btn variant="pri" disabled={!obsText.trim() || busy} onClick={(e) => submitObservation(e.currentTarget)}>
              Record → learning_record_observation
            </Btn>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Defect A — bounded presentation for a large output value. Renders a
 * capped prefix by default; the full value is never discarded, only
 * withheld from the initial paint, and an explicit disclosure both says the
 * true full size and reveals the rest on demand. Sized for the live
 * capture_map evidence (~176,860 chars) staying inspectable without
 * freezing the page on first render.
 */
function BoundedOutputView({ value }: { value: unknown }) {
  const bounded = useMemo(() => boundedOutputText(value), [value]);
  const [expanded, setExpanded] = useState(false);
  if (!bounded.truncated) {
    return <div className="promptbox" style={{ maxHeight: 220 }}>{bounded.full}</div>;
  }
  return (
    <div>
      <div className="promptbox" style={{ maxHeight: 220 }}>{expanded ? bounded.full : bounded.prefix}</div>
      <p
        style={{
          fontSize: 11.5,
          color: 'var(--faint)',
          margin: '6px 0 0',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span>
          {expanded
            ? `Showing the full value — ${bounded.fullLength.toLocaleString()} characters.`
            : `Showing the first ${bounded.prefix.length.toLocaleString()} of ${bounded.fullLength.toLocaleString()} characters.`}
        </span>
        <Btn style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'show less' : 'show full value'}
        </Btn>
      </p>
    </div>
  );
}

export function ThisRunTab({ node, nodeId, run, status }: { node: WorkflowNode; nodeId: string; run: Run; status: NodeRunStatus }) {
  const setTab = useStore((s) => s.setTab);
  const openModal = useStore((s) => s.openModal);
  const qc = useQueryClient();
  const retryM = useRetryNode();
  const [retrying, setRetrying] = useState(false);

  const execQ = useNodeExecutions(nodeId, run.id);
  const promptQ = useEffectivePrompt(nodeId);
  const schemaQ = useInputSchema(nodeId);
  // Defect A — node_list_outputs (the current-run canonical artifact +
  // operator-override source) and stage_list_outputs (the legacy
  // compatibility fallback) both feed one resolver instead of
  // stage_get_output being asked to answer alone (see outputResolution.ts's
  // header). Not gated on `status === 'completed'` any more: an override
  // must win regardless of whether the node has finished (drive mode sets
  // one before a node has even run) — see Rail.tsx's own override query for
  // the narrower case that's still fine to gate on completion (a rail chip
  // only worth asking about once a node could plausibly carry one from a
  // *previous* run of this same node/run pair rendered elsewhere).
  const outputsQ = useQuery({
    queryKey: ['nodeOutputs', nodeId, run.id],
    queryFn: () => verbs.nodeListOutputs({ nodeId, runId: run.id }),
    retry: false,
  });
  const stageOutputsQ = useStageOutputsList(nodeId);

  const resolved = resolveNodeOutput({
    status,
    runId: run.id,
    nodeId,
    nodeOutputs: extractOutputList(outputsQ.data),
    stageOutputs: stageOutputsQ.data ?? [],
  });

  // Defect B — when this node crosses into a terminal state (typically
  // while useRun's active-run polling is refreshing `run` in the
  // background), refetch everything downstream of that fact so the output
  // appears without a page reload: this node's execution record, its
  // canonical artifact + override source, the legacy fallback, the run's
  // cost ledger, and the run lists that show its progress. Guarded so it
  // fires only on a genuine transition (never on mount already-terminal,
  // never repeatedly for a node that was already terminal last render).
  // REVIEW FIX (R10) — keyed by node. A single ref meant selecting a running node and
  // then a completed one looked like ONE node transitioning, firing a full
  // invalidation burst on every such selection change.
  const prevStatusRef = useRef<{ nodeId: string; status: NodeRunStatus } | null>(null);
  useEffect(() => {
    const previous = prevStatusRef.current;
    const prev = previous && previous.nodeId === nodeId ? previous.status : null;
    prevStatusRef.current = { nodeId, status };
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    const wasTerminal = prev === 'completed' || prev === 'failed' || prev === 'cancelled';
    if (prev !== null && !wasTerminal && isTerminal) {
      qc.invalidateQueries({ queryKey: ['nodeExecutions', nodeId, run.id] });
      qc.invalidateQueries({ queryKey: ['nodeOutputs', nodeId, run.id] });
      qc.invalidateQueries({ queryKey: ['stageOutputs', nodeId] });
      qc.invalidateQueries({ queryKey: ['runCost', run.id] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    }
  }, [status, nodeId, run.id, qc]);

  // WP-21: "↻ Retry this node" wired to the same confirm-gated useRetryNode
  // the dock's own Retry control uses — same optimistic-patch-then-rollback
  // helper too, so a declined confirm or a rejected call leaves the run
  // exactly as it was.
  async function handleRetry(triggerEl: HTMLElement | null) {
    // Capture the real trigger before it goes into the "Retrying…" label
    // state (see ConfirmDialog.tsx's setNextConfirmTrigger doc comment).
    // The button itself is intentionally never `disabled` while the confirm
    // dialog and mutation are in flight: the dialog's own scrim already
    // blocks re-clicking it, and disabling would auto-blur it, breaking
    // focus-return once the dialog closes.
    setNextConfirmTrigger(triggerEl);
    setRetrying(true);
    try {
      await optimisticRunControl(qc, run.id, { status: 'running' }, () => retryM.mutateAsync({ runId: run.id, nodeId }));
      toast('Retrying node', `workflow_retry_node → ${run.id.slice(-10)}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Retry failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRetrying(false);
    }
  }

  if (status === 'queued') {
    return (
      <Card label="this run">
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          Not engaged in {run.id.slice(-10)} — upstream stopped at <span className="mono">{run.cur}</span>. Dimmed
          in the rail.
        </p>
      </Card>
    );
  }

  const execution = execQ.data?.[0];
  const durationText =
    execution && execution.durationMs != null ? `${(execution.durationMs / 1000).toFixed(1)}s` : 'duration not captured for this run';

  return (
    <>
      <Card label={`execution record · ${run.id.slice(-10)} · ${run.proj}`}>
        <KV>
          <span className="k">status</span>
          <span>
            <StatusChip status={status} />
          </span>
          <span className="k">input</span>
          <span>
            {schemaQ.isLoading ? (
              <LoadingNote>checking declared schema…</LoadingNote>
            ) : schemaQ.isError ? (
              <ErrorNote message={schemaQ.error?.message} />
            ) : (
              <>
                input schema declared · no live input payload captured to validate against this execution{' '}
                <Disclosure openLabel="view schema">
                  <div className="schemabox" style={{ maxHeight: 180 }}>
                    {JSON.stringify(schemaQ.data, null, 2)}
                  </div>
                </Disclosure>
              </>
            )}
          </span>
          <span className="k">effective prompt</span>
          <span>
            {promptQ.isLoading ? (
              <LoadingNote>resolving effective prompt…</LoadingNote>
            ) : promptQ.isError ? (
              <ErrorNote message={promptQ.error?.message} />
            ) : (
              <>
                resolved with skill + playbook overlays · {promptQ.data?.diverged ? 'diverged from canonical' : 'matches canonical'}{' '}
                <Disclosure openLabel="view">
                  <div className="promptbox" style={{ maxHeight: 200 }}>
                    {promptQ.data?.prompt || '(empty)'}
                  </div>
                </Disclosure>
              </>
            )}
          </span>
          <span className="k">duration · cost</span>
          <span className="num">
            {durationText} · run total ${run.cost.toFixed(2)}
          </span>
        </KV>
      </Card>

      <Card label="tool calls">
        {execQ.isLoading ? (
          <LoadingNote>loading execution record…</LoadingNote>
        ) : execQ.isError ? (
          <ErrorNote message={execQ.error?.message} />
        ) : (
          <p style={{ color: 'var(--faint)', fontSize: 12, margin: 0, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span>
              No per-call tool-call log is captured for this run/node in the current data model — see the
              node&rsquo;s {node.tools.length} allowed tool{node.tools.length === 1 ? '' : 's'} in
            </span>
            <Btn style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => setTab('tools')}>
              Tools
            </Btn>
          </p>
        )}
      </Card>

      {status === 'blocked' && (
        <div className="card" style={{ borderColor: 'var(--acc-dim)' }}>
          <span className="lbl" style={{ color: 'var(--acc)' }}>
            gate
          </span>
          <p style={{ margin: 0 }}>{GATE_COPY[nodeId] ?? DEFAULT_GATE_COPY_CENTER}</p>
        </div>
      )}

      {status === 'failed' && (
        <div className="card" style={{ borderColor: 'color-mix(in srgb,var(--bad) 40%,transparent)' }}>
          <span className="lbl" style={{ color: 'var(--bad)' }}>
            error
          </span>
          <p className="mono" style={{ fontSize: 12, margin: 0 }}>
            output failed schema validation: required field &quot;verdict&quot; missing — retry with edits, or inspect
            the effective prompt.
          </p>
        </div>
      )}

      <Card label="output">
        {resolved.source === 'override' && (
          // U3 — never presented as if the node produced it: says who, when,
          // and with what note, every time this banner shows at all. This
          // is precedence tier 1 — it wins over a canonical artifact or a
          // legacy stage record whenever one is also present.
          <p className="note" style={{ color: 'var(--run)', marginTop: 0 }}>
            ⎘ this output was supplied by the operator, {formatWhen(resolved.createdAt)}
            {resolved.overrideNote ? ` — note: "${resolved.overrideNote}"` : ' — no note given'}.
          </p>
        )}
        {resolved.source === 'canonical' && (
          <p className="note" style={{ color: 'var(--muted)', marginTop: 0, fontSize: 12 }}>
            current-run artifact{resolved.artifactType ? ` · ${resolved.artifactType}` : ''}
            {resolved.createdAt ? ` · ${formatWhen(resolved.createdAt)}` : ''} — from node_list_outputs.
          </p>
        )}
        {resolved.source === 'legacy' && (
          // Defect A — a legacy stage-store record is a compatibility
          // fallback, not this run's own source of truth: said so
          // explicitly, and never claims run-attribution the record's id
          // doesn't actually prove (legacyScope === 'unscoped').
          <p className="note" style={{ color: 'var(--acc)', marginTop: 0, fontSize: 12 }}>
            ⚠ legacy stage-store record
            {resolved.legacyScope === 'unscoped' ? " — its id doesn't confirm it belongs to this exact run" : ' for this run'}
            {resolved.createdAt ? `, ${formatWhen(resolved.createdAt)}` : ''}. No current-run canonical artifact was
            found for this node — this is a compatibility fallback.
          </p>
        )}
        {outputsQ.isLoading || stageOutputsQ.isLoading ? (
          <LoadingNote>loading stage output…</LoadingNote>
        ) : outputsQ.isError ? (
          <ErrorNote message={outputsQ.error?.message} />
        ) : stageOutputsQ.isError ? (
          <ErrorNote message={stageOutputsQ.error?.message} />
        ) : resolved.source === 'empty' ? (
          // Defect B — honest, per-state text: never "No stage output
          // recorded" for a node that simply hasn't completed yet.
          <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: 0 }}>{resolved.emptyMessage}</p>
        ) : (
          <BoundedOutputView value={resolved.value} />
        )}
        {status === 'completed' ? (
          <CaptureButtons nodeId={nodeId} runId={run.id} />
        ) : (
          <p style={{ color: 'var(--faint)', fontSize: 12, margin: '10px 0 0' }}>
            Approve / Reject / Edit &amp; approve / Record observation appear once this node completes.
          </p>
        )}
        <div className="editnote">
          <Btn onClick={() => setTab('prompt')}>Edit prompt</Btn>
          <Btn onClick={() => openModal('override', { node: nodeId, run: run.id })}>⎘ Override output…</Btn>
          <Btn
            variant="pri"
            disabled={IS_READ_ONLY}
            title={IS_READ_ONLY ? READONLY_REASON : undefined}
            onClick={(e) => handleRetry(e.currentTarget)}
          >
            {retrying ? 'Retrying…' : '↻ Retry this node'}
          </Btn>
        </div>
      </Card>
    </>
  );
}
