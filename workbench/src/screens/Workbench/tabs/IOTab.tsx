// W4 — I/O: what this node was actually handed, what it produced, and what it called in between.
//
// The inspector could answer "what is this node CONFIGURED to do" in six tabs and could not answer
// "what did it DO" at all. This-run shows the node's own output; nothing showed the INPUTS it was
// given (its dependencies' stage outputs, which is what a prompt actually sees), and nothing
// anywhere showed the tool calls between the two — the part of a run an operator debugging a bad
// output most needs.
//
// For a DETERMINISTIC node it also carries the Algorithm panel, because such a node has no prompt
// to read and no grants to read: its behaviour is engine code, and before this the Workbench showed
// an operator a node that crawls a site or publishes a template and told them nothing about it.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../../api/verbs';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card, Chip, Lbl } from '../../../components/primitives';
import { Skeleton } from '../../../components/Skeleton';
import { QueryError } from '../../../components/QueryError';
import { toast } from '../../../components/Toasts';
import { formatDurationMs } from '../helpers';
import { errMsg, runNodeProvenance } from '../../../components/drive/overrideStatus';
import { recordChange, READONLY_REASON } from './Shared';
import type { Run, WorkflowNode } from '../../../types';

const PREVIEW_CHARS = 4000;

function Json({ value }: { value: unknown }) {
  const text = value === undefined ? '(nothing recorded)' : JSON.stringify(value, null, 2);
  const clipped = text.length > PREVIEW_CHARS;
  return (
    <pre className="mono" style={{ margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {clipped ? `${text.slice(0, PREVIEW_CHARS)}\n… ${text.length - PREVIEW_CHARS} more characters` : text}
    </pre>
  );
}

/**
 * The inputs this node was handed: its dependencies' stage outputs, off the RUN record. That is the
 * authoritative answer — it is literally what the dispatcher passed — and it needs no extra call,
 * because the bound run is already loaded by every surface on this screen.
 */
function Inputs({ node, run }: { node: WorkflowNode; run: Run }) {
  // W6 CORRECTION — this read `node.requiredInputs`, which is NOT the dependency list: it is a list
  // of required input ARTIFACT TYPES, and on `input_triage` (the very node the live smoke exercises)
  // it is `["content_source.v1"]` against `dependsOn: []`. The card therefore drew a row for a type
  // id that is not a key in `stageOutputs` and reported it as "not produced on this run", while
  // hiding the run's initial input — which is in fact the only thing that node is handed.
  // `dependsOn` is what nodeRuntime.prepareNodeExecution itself walks, so it is the authority here.
  const dependencies = node.dependsOn ?? [];
  // A summary row carries `dependsOn`; a node record that predates the field carries neither, and
  // falling back to the run's own stage-output keys is better than claiming no inputs at all.
  const upstream = dependencies.length
    ? dependencies
    : node.dependsOn === undefined
      ? Object.keys(run.stageOutputs ?? {}).filter((id) => id !== node.id)
      : [];
  if (!upstream.length) {
    return (
      <Card id="io-inputs" label="inputs">
        <p className="note">This node declares no dependencies — it is handed the run's own initial input.</p>
        <Json value={run.input} />
      </Card>
    );
  }
  return (
    <Card id="io-inputs" label={`inputs · ${upstream.length} upstream output${upstream.length === 1 ? '' : 's'}`}>
      {upstream.map((depId) => {
        const value = run.stageOutputs?.[depId];
        const provenance = runNodeProvenance(run.nodes, depId);
        return (
          <div key={depId} style={{ marginBottom: 12 }}>
            <Lbl>
              {depId}
              {provenance ? (
                <span style={{ color: 'var(--run)' }}>
                  {' '}
                  · {provenance.source === 'default_output' ? '⚙ supplied from default' : '⎘ operator override'}
                </span>
              ) : null}
            </Lbl>
            {value === undefined ? (
              <p className="note">Not produced on this run — this node ran without it, or has not run yet.</p>
            ) : (
              <Json value={value} />
            )}
          </div>
        );
      })}
    </Card>
  );
}

/** The canonical account of a deterministic node's behaviour — see nodeAlgorithms.ts. */
function Algorithm({ algorithm }: { algorithm: verbs.NodeAlgorithm }) {
  return (
    <Card id="io-algorithm" label={<>algorithm <span className="pin live">canonical</span></>}>
      <p style={{ marginTop: 0 }}>{algorithm.summary}</p>
      <Lbl>steps</Lbl>
      <ol className="mono" style={{ margin: '4px 0 12px', paddingLeft: 22, fontSize: 12, lineHeight: 1.6 }}>
        {algorithm.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <Lbl>reads</Lbl>
      <ul style={{ margin: '4px 0 12px', paddingLeft: 22, fontSize: 12 }}>
        {algorithm.reads.map((read, i) => (
          <li key={i}>{read}</li>
        ))}
      </ul>
      <Lbl>engine calls to the client</Lbl>
      {algorithm.engineTools.length === 0 ? (
        <p className="note">
          {algorithm.engineToolsUnverified
            ? 'This route reaches the client, but its verbs could not be attributed from source — stated rather than guessed.'
            : 'None — local computation only.'}
        </p>
      ) : (
        <ul style={{ margin: '4px 0 12px', paddingLeft: 22, fontSize: 12 }}>
          {algorithm.engineTools.map((tool) => (
            <li key={tool.verb}>
              <span className="mono">{tool.verb}</span>
              {tool.risk ? <span className={`chip risk-${tool.risk}`}> {tool.risk}</span> : null}
              {tool.description ? <> — {tool.description}</> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="note">
        These pass no node grant and no risk check, and they do not appear in the tool calls below: a
        deterministic route reaches the client directly. Implemented in <span className="mono">{algorithm.source}</span>
        {algorithm.route ? (
          <>
            {' '}
            (route <span className="mono">{algorithm.route.routeId}</span>
            {algorithm.route.phaseId ? <>, stage <span className="mono">{algorithm.route.phaseId}</span></> : null})
          </>
        ) : null}
        .
      </p>
    </Card>
  );
}

export function IOTab({ node, nodeId, run }: { node: WorkflowNode; nodeId: string; run: Run | null }) {
  // `algorithm` rides on a verb the inspector already calls for this node, so a deterministic node
  // costs no extra round trip to explain.
  const effectiveQ = useQuery({
    queryKey: ['effectiveTools', nodeId],
    queryFn: () => verbs.nodeGetEffectiveTools({ nodeId }),
  });
  const executionsQ = useQuery({
    queryKey: ['toolExecutions', run?.id ?? 'none', nodeId],
    queryFn: () => verbs.toolListExecutions({ runId: run?.id, nodeId }),
    enabled: Boolean(run?.id),
    retry: false,
  });

  const algorithm = effectiveQ.data?.algorithm ?? null;
  const state = run?.nodes.find((entry) => entry.nodeId === nodeId);
  const provenance = run ? runNodeProvenance(run.nodes, nodeId) : undefined;

  const qc = useQueryClient();
  const [adopting, setAdopting] = useState(false);
  const produced = run?.stageOutputs?.[nodeId];
  const canAdopt = Boolean(run && state?.status === 'completed' && produced !== undefined && !provenance);

  async function handleAdopt(triggerEl: HTMLElement | null) {
    if (!run) return;
    setNextConfirmTrigger(triggerEl);
    setAdopting(true);
    const before = node.defaultOutput;
    try {
      // runId-scoped deliberately: "the output I am looking at", not "whatever this node produced
      // most recently anywhere", which is what the verb does when runId is omitted and is a
      // different value whenever a newer run exists.
      const result = await verbs.workspaceAdoptOutputAsDefault({ nodeId, runId: run.id });
      await qc.invalidateQueries({ queryKey: ['node', nodeId] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
      // Same reason DefaultOutputTab invalidates it: the rail decides whether to offer a
      // push-through from bootstrap's `hasDefaultOutput`, and would otherwise keep saying no.
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
      recordChange({
        nodeId,
        kind: 'defaultOutput',
        label: `default adopted from run ${run.id}`,
        before,
        after: result?.node?.defaultOutput?.value ?? produced,
      });
      toast('Saved as default', `workspace_adopt_output_as_default → ${nodeId} (run ${run.id})`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Save as default failed', errMsg(err));
    } finally {
      setAdopting(false);
    }
  }

  return (
    <>
      {effectiveQ.isLoading && <Skeleton lines={3} />}
      {algorithm && <Algorithm algorithm={algorithm} />}

      {!run ? (
        <Card id="io-empty" label="i/o">
          <p className="note">
            Bind a run to see what this node was handed, what it produced, and what it called. Without one
            there is only its configuration, which the other tabs already show.
          </p>
        </Card>
      ) : (
        <>
          <Inputs node={node} run={run} />

          <Card
            id="io-output"
            label={
              <>
                output
                {state?.status ? <Chip status={state.status}>{state.status}</Chip> : null}
                {provenance ? (
                  <span className="pin" style={{ color: 'var(--run)' }}>
                    {provenance.source === 'default_output' ? '⚙ supplied from this node’s default' : '⎘ operator override'}
                  </span>
                ) : state?.status === 'completed' ? (
                  // W7 — "produced" used to render for ANY node with no provenance, including one
                  // that never ran, directly above "(nothing recorded)".
                  <span className="pin live">produced</span>
                ) : null}
                {typeof state?.durationMs === 'number' ? <span className="lbl"> · {formatDurationMs(state.durationMs)}</span> : null}
              </>
            }
          >
            <Json value={run.stageOutputs?.[nodeId]} />
            {/* W6 — adopting THIS run's output as the node's standing default. The verb and its
                client wrapper have existed since W4 and nothing called them: DefaultOutputTab's
                own header points at an "Adopt as default" control on the rail that was never
                built, so the only way to get a produced value into a default was to copy the JSON
                by hand into that tab's editor. This is the control that comment describes.
                Offered only on a COMPLETED output that this run actually produced: adopting a
                value the node was HANDED (a default already, or an operator override) would make
                the node's default a copy of itself or of a one-run override, which is not what
                either of those two things means. */}
            {canAdopt ? (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Btn
                  id="io-save-as-default"
                  disabled={adopting || IS_READ_ONLY}
                  title={IS_READ_ONLY ? READONLY_REASON : undefined}
                  onClick={(e) => void handleAdopt(e.currentTarget as HTMLElement)}
                >
                  {adopting ? 'Saving…' : 'Save as default'}
                </Btn>
                <span className="note">
                  Writes this value as {nodeId}’s standing default. A push-through or a defaults-mode run then
                  uses it in place of running the node — on every run, not just this one.
                </span>
              </div>
            ) : state?.status === 'completed' && provenance ? (
              <p className="note" style={{ marginTop: 10 }}>
                This value was supplied{provenance.source === 'default_output' ? ' from this node’s default' : ' by an operator override'}, not produced
                here — there is nothing to adopt.
              </p>
            ) : null}
          </Card>

          {/* W7 — the label read "· 0" while the query was still loading AND while it had failed,
              over a body that said otherwise. A count is a fact; state it only when there is one. */}
          <Card
            id="io-tool-calls"
            label={`tool calls${executionsQ.isLoading ? ' · …' : executionsQ.isError ? '' : ` · ${executionsQ.data?.length ?? 0}`}`}
          >
            {executionsQ.isLoading ? (
              <Skeleton lines={2} />
            ) : executionsQ.isError ? (
              <QueryError label="tool executions" message={executionsQ.error?.message} onRetry={() => void executionsQ.refetch()} />
            ) : (executionsQ.data ?? []).length === 0 ? (
              <p className="note">
                No controlled tool call was recorded for this node in this run.
                {algorithm ? ' A deterministic route reaches the client directly and leaves no record here — see the engine calls above.' : ''}
              </p>
            ) : (
              (executionsQ.data ?? []).map((execution, i) => (
                <div key={execution.toolExecutionId ?? `${execution.toolId}-${i}`} style={{ marginBottom: 12 }}>
                  <Lbl>
                    <span className="mono">{execution.toolId}</span>
                    {execution.caller ? <> · {execution.caller === 'engine' ? 'engine route' : 'model turn'}</> : null}
                    {execution.status ? <> · {execution.status}</> : null}
                    {typeof execution.durationMs === 'number' ? <> · {formatDurationMs(execution.durationMs)}</> : null}
                  </Lbl>
                  {execution.args !== undefined && (
                    <>
                      <Lbl>arguments</Lbl>
                      <Json value={execution.args} />
                    </>
                  )}
                  {execution.error ? (
                    <p style={{ margin: '4px 0 0', color: 'var(--bad)' }} className="mono">
                      {execution.error}
                    </p>
                  ) : execution.result !== undefined ? (
                    <>
                      <Lbl>result</Lbl>
                      <Json value={execution.result} />
                    </>
                  ) : null}
                </div>
              ))
            )}
          </Card>
        </>
      )}
    </>
  );
}
