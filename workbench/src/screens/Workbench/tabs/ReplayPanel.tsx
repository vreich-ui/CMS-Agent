// W6 — replay this node against a run, without touching that run.
//
// The Prompt tab could edit a prompt and could show what the model would receive, and then the
// only way to find out what the node would PRODUCE was to start a whole run: minutes, every
// upstream node again, and a run record an operator then has to explain. `node.execute` has always
// been able to run one node on its own; nothing in the Workbench called it.
//
// What this sends and why:
//   * `dependencyOutputs` — the bound run's stage outputs, narrowed to this node's `dependsOn`.
//     This is not decoration. Omit them and nodeRuntime.prepareNodeExecution fills each dependency
//     from `workspaceRepository.getStageOutput(id)` — the workspace's LATEST value for that node,
//     which is whatever the newest run happened to write. The replay would then silently be against
//     different inputs than the run on screen, and its diff would be meaningless.
//   * `input` — the run's own initial input. `executeNode` validates `data.input ?? {}` against the
//     node's inputSchema before it does anything else, so a node with required input fields refuses
//     a replay that sends nothing.
//   * `modelConfig` — the Model tab's unsaved draft, when there is one (the server deep-merges it
//     over the node's stored config for this call only).
//
// What it deliberately does NOT send: the Prompt tab's unsaved draft. `promptOverride` exists on
// `executeNode` and is deliberately withheld from the public node.execute tool (nodeRuntime.ts's own
// comment: the sanctioned public mutation path stays workspace.update_node_prompt). A replay
// therefore runs the SAVED prompt, and this panel says so rather than letting an operator believe
// they just tested their unsaved edit.
//
// The result is a NEW synthetic run server-side (workflowId "independent_node", projectId
// "workspace"). It does not touch the bound run, is not part of any workflow, and cannot publish.
//
// It is NOT, however, free of consequence, and an earlier draft of this panel said it was. On a
// completed execution `executeNode` calls `workspaceRepository.saveStageOutput(nodeId, …)` — it
// overwrites the WORKSPACE's latest stage output for that node. That value is what
// `prepareNodeExecution` falls back to when a caller omits a dependency, and what
// `workspace.adopt_output_as_default` adopts when no runId is given. A free mock replay therefore
// leaves a schema-shaped placeholder sitting in the workspace's most-recent slot for that node.
// The panel says so, and invalidates the reads that depend on it rather than leaving them stale.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../../api/verbs';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card, Lbl } from '../../../components/primitives';
import { FieldsDiffView } from '../../../components/diff/FieldsDiffView';
import { errMsg, normalizeValidationIssues } from '../../../components/drive/overrideStatus';
import { formatDurationMs } from '../helpers';
import { unsavedModelConfigPatch } from './ModelTab';
import { ErrorNote, READONLY_REASON, SchemaIssueList, type SchemaIssue } from './Shared';
import type { Run, WorkflowNode } from '../../../types';

interface ReplayState {
  status?: string;
  output?: unknown;
  errors: string[];
  durationMs?: number;
  runId?: string;
  executionId?: string;
  executionMode: 'mock' | 'openai';
  /** null while the validation call is in flight or was never made. */
  issues: SchemaIssue[] | null;
  validateError?: string;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function ReplayPanel({ node, nodeId, run, promptDirty }: { node: WorkflowNode; nodeId: string; run: Run | null; promptDirty: boolean }) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const [running, setRunning] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayState | null>(null);

  const original = run?.stageOutputs?.[nodeId];
  const deps = node.dependsOn ?? [];
  const missing = run ? deps.filter((id) => run.stageOutputs?.[id] === undefined) : deps;

  const blocked = !run
    ? 'Bind a run first — a replay reads its upstream outputs, and without one there is nothing to replay against.'
    : missing.length
      ? `This run has no output for ${missing.join(', ')} — the server would fall back to the workspace's most recent value for those nodes, which is not what is on screen.`
      : IS_READ_ONLY
        ? READONLY_REASON
        : null;

  async function handleReplay(triggerEl: HTMLElement | null) {
    if (!run || blocked || running) return;
    setNextConfirmTrigger(triggerEl);
    setRunning(true);
    setCallError(null);
    setResult(null);
    const executionMode: 'mock' | 'openai' = live ? 'openai' : 'mock';
    try {
      const dependencyOutputs: Record<string, unknown> = {};
      for (const id of deps) dependencyOutputs[id] = run.stageOutputs?.[id];
      const modelConfig = unsavedModelConfigPatch(node);
      const raw = await verbs.nodeExecute({
        nodeId,
        runId: run.id,
        ...(deps.length ? { dependencyOutputs } : {}),
        ...(run.input !== undefined ? { input: run.input } : {}),
        ...(modelConfig ? { modelConfig } : {}),
        executionMode,
      });
      const flat = verbs.nodeExecuteResultOf(raw, nodeId);
      const next: ReplayState = { ...flat, executionMode, issues: null };
      setResult(next);

      // A completed execution wrote this node's latest workspace stage output (see the header note),
      // so every read of "this node's most recent output" is now stale. The Default output tab's
      // prefill reads exactly that, and would otherwise keep offering the pre-replay value.
      if (flat.status === 'completed') {
        qc.invalidateQueries({ queryKey: ['nodeLatestOutput', nodeId] });
        qc.invalidateQueries({ queryKey: ['stageOutputs', nodeId] });
        qc.invalidateQueries({ queryKey: ['nodeOutputs', nodeId] });
      }

      // node_validate_output on the REPLAYED value, exactly as the Default output tab validates
      // before saving one. A replay whose output does not satisfy the node's own schema is the most
      // useful thing this panel can tell an operator, and the run record's `completed` says nothing
      // about it on the mock path.
      if (flat.status === 'completed' && flat.output !== undefined) {
        try {
          const validation = await verbs.nodeValidateOutput({ nodeId, output: flat.output });
          setResult({ ...next, issues: validation.valid ? [] : normalizeValidationIssues(validation.issues) });
        } catch (err) {
          setResult({ ...next, validateError: errMsg(err) });
        }
      }
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      setCallError(errMsg(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card
      id="replay-panel"
      label={
        <>
          replay against run
          {run ? <span className="lbl"> · {run.id}</span> : <span className="pin">no run bound</span>}
        </>
      }
    >
      <p className="note" style={{ marginTop: 0 }}>
        Runs {nodeId} on its own against this run&rsquo;s upstream outputs and shows the result beside what the
        run actually produced. It writes a separate single-node execution; <strong>the run on screen is
        untouched</strong>. It does replace this node&rsquo;s most recent workspace output — what a later
        replay falls back to for a missing dependency, and what &ldquo;adopt latest&rdquo; would adopt.
      </p>
      {promptDirty && (
        <p className="note" style={{ color: 'var(--acc)' }}>
          Your unsaved prompt draft is <strong>not</strong> used — <span className="mono">node_execute</span> takes no prompt
          override, so this replays the saved prompt. Save first to replay the edit.
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
        <Btn
          id="replay-run"
          variant={live ? undefined : 'pri'}
          disabled={Boolean(blocked) || running}
          title={blocked ?? undefined}
          onClick={(e) => void handleReplay(e.currentTarget as HTMLElement)}
        >
          {running ? 'Replaying…' : '⇄ Replay against run'}
        </Btn>
        <label className="note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input id="replay-live" type="checkbox" checked={live} disabled={running} onChange={(e) => setLive(e.target.checked)} />
          real model call (costs money) — otherwise a mock dispatch produces schema-shaped placeholder output at no cost
        </label>
      </div>
      {blocked && !IS_READ_ONLY && <p className="note" style={{ marginTop: 8 }}>{blocked}</p>}
      {callError && <ErrorNote message={callError} />}

      {result && (
        <div id="replay-result" style={{ marginTop: 14 }}>
          <Lbl>
            result · {result.status ?? 'unknown'} · {result.executionMode === 'openai' ? 'live model call' : 'mock dispatch — placeholder content'}
            {typeof result.durationMs === 'number' ? ` · ${formatDurationMs(result.durationMs)}` : ''}
            {result.executionId ? ` · ${result.executionId}` : ''}
          </Lbl>
          {result.status !== 'completed' ? (
            <>
              <p className="note" style={{ color: 'var(--bad)' }}>
                The replay did not complete. Nothing was compared, because there is no output to compare.
              </p>
              <pre className="mono" style={{ margin: 0, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {result.errors.length ? result.errors.join('\n') : JSON.stringify(result.output, null, 2)}
              </pre>
            </>
          ) : (
            <>
              {result.validateError ? (
                <p className="note">Schema check could not be run: {result.validateError}</p>
              ) : result.output === undefined ? (
                <p className="note">
                  The execution completed but recorded no output for this node, so there is nothing to check
                  against its schema and nothing to compare.
                </p>
              ) : result.issues === null ? (
                <p className="note">Checking the replayed output against this node&rsquo;s schema…</p>
              ) : result.issues.length === 0 ? (
                <p className="note" style={{ color: 'var(--ok)' }}>Replayed output satisfies this node&rsquo;s output schema.</p>
              ) : (
                <>
                  <p className="note" style={{ color: 'var(--bad)' }}>
                    The replayed output does not satisfy this node&rsquo;s output schema:
                  </p>
                  <SchemaIssueList issues={result.issues} />
                </>
              )}
              <div style={{ marginTop: 10 }}>
                <Lbl>this run&rsquo;s output (left) vs the replay (right)</Lbl>
                {asRecord(original) && asRecord(result.output) ? (
                  <FieldsDiffView before={asRecord(original)} after={asRecord(result.output)} exclude={[]} />
                ) : (
                  // Not every node produces an object; a scalar or array output has no fields to
                  // pair up, so it is shown whole rather than forced through a field differ.
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <Lbl>run</Lbl>
                      <pre className="mono" style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                        {original === undefined ? '(this run produced nothing for this node)' : JSON.stringify(original, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <Lbl>replay</Lbl>
                      <pre className="mono" style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                        {JSON.stringify(result.output, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
