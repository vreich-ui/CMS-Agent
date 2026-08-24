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

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { useEffectivePrompt, useInputSchema, useNodeExecutions, useStageOutput } from '../queries';
import { bumpApprovedExamples } from '../../Learning/overlay';
import { Disclosure, ErrorNote, LoadingNote } from './Shared';

const READONLY_REASON =
  'Mutations are disabled — the workbench is running read-only. The broker’s READ_ONLY env flag must be set to 0 to enable them.';

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
          title={IS_READ_ONLY ? READONLY_REASON : 'feedback_record → verdict:approved'}
          onClick={(e) => approve(e.currentTarget)}
        >
          ✓ Approve output
        </Btn>
        <Btn
          variant="danger"
          disabled={IS_READ_ONLY || busy}
          title={IS_READ_ONLY ? READONLY_REASON : 'feedback_record → verdict:rejected'}
          onClick={(e) => reject(e.currentTarget)}
        >
          ✗ Reject
        </Btn>
        <Btn
          disabled={IS_READ_ONLY || busy}
          title={IS_READ_ONLY ? READONLY_REASON : 'feedback_record → verdict:edited_approved'}
          onClick={() => setEditing((v) => !v)}
        >
          ✎ Edit &amp; approve
        </Btn>
        <Btn
          disabled={IS_READ_ONLY || busy}
          title={IS_READ_ONLY ? READONLY_REASON : 'learning_record_observation'}
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

export function ThisRunTab({ node, nodeId, run, status }: { node: WorkflowNode; nodeId: string; run: Run; status: NodeRunStatus }) {
  const setTab = useStore((s) => s.setTab);
  const qc = useQueryClient();
  const retryM = useRetryNode();
  const [retrying, setRetrying] = useState(false);

  const execQ = useNodeExecutions(nodeId, run.id);
  const promptQ = useEffectivePrompt(nodeId);
  const schemaQ = useInputSchema(nodeId);
  const outputQ = useStageOutput(run.id, nodeId);

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
        {outputQ.isLoading ? (
          <LoadingNote>loading stage output…</LoadingNote>
        ) : outputQ.isError ? (
          <ErrorNote message={outputQ.error?.message} />
        ) : (
          <div className="promptbox" style={{ maxHeight: 130 }}>
            {outputQ.data?.note ?? JSON.stringify(outputQ.data?.output ?? {}, null, 2)}
          </div>
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
