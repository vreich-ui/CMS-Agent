// W6 — replay ONE node against a past run.
//
// "Replay vs dataset" sat disabled on the Prompt tab, and the only way to find out whether a prompt
// edit helped was to start a whole conductor run: minutes, dollars, and 24 other nodes' worth of noise
// between the change and the answer. This replays the single node against a run that already happened
// — its real upstream outputs, the current prompt and model config — and shows the new output beside
// the one that run recorded. Seconds and cents.
//
// WHAT MAKES THE COMPARISON HONEST. The dependency outputs handed to the node are its declared
// upstream ones only (see verbs.nodeReplayAgainstRun): everything else in that run's stageOutputs —
// including this node's OWN previous output — is withheld, because a node that can read the answer it
// is meant to produce will appear to have improved when nothing has.
//
// It costs real money: node_execute runs in "openai" mode against the live provider, which is the
// whole point (a mock replay would tell an operator nothing about a prompt edit). So the button says
// so before it is pressed, and nothing fires until it is.

import { useEffect, useState } from 'react';
import * as verbs from '../../api/verbs';
import { useRuns } from '../../api/hooks';
import { Modal } from '../overlay/Modal';
import { Btn } from '../primitives';
import { IS_READ_ONLY } from '../../api/client';
import { READONLY_REASON } from '../../screens/Workbench/tabs/Shared';
import { FieldsDiffView } from './FieldsDiffView';
import type { WorkflowNode } from '../../types';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function NodeReplayModal({
  open,
  onClose,
  node,
  workflowId,
}: {
  open: boolean;
  onClose: () => void;
  node: WorkflowNode;
  workflowId: string;
}) {
  const [runId, setRunId] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<verbs.NodeReplayResult | null>(null);

  // REVIEW FIX — this component stays MOUNTED when closed (Modal renders null; PromptTab is not keyed
  // by nodeId), so without this reset it showed node A's diff under node B's title, and kept A's
  // selected run — which B may never have reached, making the Replay button live and the comparison
  // meaningless. Reset on both edges: opening, and any change of node.
  useEffect(() => {
    setRunId('');
    setResult(null);
    setError(null);
  }, [open, node.id]);

  // The same five-row, summary-detail listing the rail and Drive already hold, so opening this modal
  // adds no request at all (react-query dedupes on the identical ['runs', filters] key — see W5).
  const runsQ = useRuns({ workflowId, limit: 5 }, { enabled: open });

  // Only runs in which this node actually recorded something are offerable: replaying against a run
  // that never reached the node gives no left-hand side and, more importantly, no upstream outputs.
  const candidates = (runsQ.data ?? []).filter((run) => run.nodes.some((n) => n.nodeId === node.id && n.status === 'completed'));

  // A node with no declared upstream (an entry node) has nothing to replay AGAINST: its input comes
  // from the run's initialInput, which this path does not reproduce, so the "replay" would be a plain
  // fresh execution dressed up as a comparison. Said plainly rather than silently producing one.
  const deps = node.deps ?? [];
  const replayable = deps.length > 0;

  const replay = async () => {
    // Guarded on the CURRENT candidate list, not only on a non-empty runId: a stale selection whose
    // run is no longer offered would replay against a run in which this node never completed, so the
    // upstream outputs come back empty and the comparison has no left-hand side.
    if (!runId || !replayable || !candidates.some((run) => run.id === runId)) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await verbs.nodeReplayAgainstRun({ nodeId: node.id, runId, dependsOn: deps }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The replay failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Replay ${node.name}`}
      sub="Run this one node against a past run's real upstream outputs, and compare."
      size="work"
      actions={
        <>
          <Btn onClick={onClose}>Close</Btn>
          <Btn
            disabled={!runId || running || !replayable || IS_READ_ONLY || !candidates.some((run) => run.id === runId)}
            onClick={() => void replay()}
            title={
              IS_READ_ONLY
                ? READONLY_REASON
                : !replayable
                ? `${node.id} has no upstream nodes, so there is nothing from a past run to replay it against.`
                : runId
                  ? 'Calls the live model for this one node — this costs money.'
                  : 'Pick a run first.'
            }
          >
            {running ? 'Replaying…' : '⇄ Replay against this run'}
          </Btn>
        </>
      }
      footNote="Replays call the live model for this node only. Upstream outputs come from the selected run; this node's own previous output is deliberately withheld from its input."
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label className="lbl" htmlFor="replay-run">
          Run
        </label>
        <select id="replay-run" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={running}>
          <option value="">Select a run…</option>
          {candidates.map((run) => (
            <option key={run.id} value={run.id}>
              {run.id.slice(-10)} · {run.status} · {run.started}
            </option>
          ))}
        </select>
        {runsQ.isLoading && <span className="note">loading runs…</span>}
        {!replayable && (
          <span className="note">
            {node.id} has no upstream nodes — its input comes from the run's own initial input, so there is nothing to replay it against here.
          </span>
        )}
        {!runsQ.isLoading && !candidates.length && (
          <span className="note">No recent run of this workflow completed {node.id} — there is nothing to replay against.</span>
        )}
      </div>

      {error && <p className="note" style={{ color: 'var(--bad)' }}>{error}</p>}

      {result && (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Replayed in {(result.durationMs / 1000).toFixed(1)}s.{' '}
            {result.validation === null
              ? 'Output schema was not checked — the validation call failed, so the result above is shown unverified.'
              : result.validation.valid
                ? 'The new output satisfies this node’s output schema.'
                : `The new output does NOT satisfy this node’s output schema: ${(result.validation.issues ?? []).map(String).join('; ')}`}
          </p>
          {/* `exclude: []` — unlike a node-definition diff, every field of an OUTPUT is interesting
              here, including a prompt field if the node happens to produce one. */}
          <FieldsDiffView before={asRecord(result.original)} after={asRecord(result.output)} exclude={[]} />
          {!asRecord(result.output) && (
            <pre className="note" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(result.output, null, 2)}</pre>
          )}
        </>
      )}
    </Modal>
  );
}
