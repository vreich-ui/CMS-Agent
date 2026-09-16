// W5 — SCORES.
//
// Every workflow here ends in judgement: four editorial reviews and an aggregator on
// publishing_conductor, a fidelity score and a gap adjudication on capture, a fit adjudication on
// clone, a contract verdict before anything is built. Every one of those was reachable only by
// opening a run, then a node, then a JSON blob — so "are our runs getting better or worse" was not
// a question this system could answer at all.
//
// The rows come off the run index (`workflow_list_runs { include: ["scores"] }`), so a page of
// scores opens no run records. Eval RESULTS are a second, independent source, joined by runId:
// a rubric's verdict on a run is not the same thing as the run's own reviews saying it went well,
// and folding them together would hide exactly the disagreement worth looking at.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';
import { useRunsPage } from '../../api/hooks';
import { Card, Lbl } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { QueryError } from '../../components/QueryError';
import type { Run, Workflow } from '../../types';

const SPARK_WINDOW = 20;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The mean of a run's NUMERIC scores. A verdict is a decision, not a measurement — it is shown,
 *  never averaged into one. A run with no numeric score has no point on the line. */
function numericMean(scores: Record<string, number | string> | undefined): number | null {
  const numbers = Object.values(scores ?? {}).filter(isNumber);
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function Sparkline({ points }: { points: Array<{ runId: string; value: number }> }) {
  if (points.length < 2) return <span className="note">Not enough scored runs yet to draw a trend.</span>;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 240;
  const height = 34;
  const step = width / (points.length - 1);
  const d = points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(height - ((point.value - min) / span) * (height - 4) - 2).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label={`score trend over the last ${points.length} scored runs`} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke="var(--acc)" strokeWidth="1.5" />
      {points.map((point, i) => (
        <circle key={point.runId} cx={i * step} cy={height - ((point.value - min) / span) * (height - 4) - 2} r="1.8" fill="var(--acc)" />
      ))}
    </svg>
  );
}

export function ScoresTab({
  workflows,
  workflowId,
  onSelectWorkflow,
  onOpen,
}: {
  workflows: Workflow[];
  workflowId: string;
  onSelectWorkflow: (id: string) => void;
  onOpen: (run: Run) => void;
}) {
  const runsQ = useRunsPage({ workflowId, limit: SPARK_WINDOW, include: ['scores'] });
  // W7 — the key carried `workflowId` while the call took no arguments, so switching the dropdown
  // refetched the same unbounded list under a new key every time. `evaluation.list_results` is
  // fleet-wide and joined by RUN ID below; one key for one list.
  const evalsQ = useQuery({
    queryKey: ['evalResults', 'all'],
    queryFn: () => verbs.evaluationListResults(),
    retry: false,
  });

  // W7 — `useRunsPage` carries `placeholderData: keepPreviousData`, and this tab renders outside
  // the dimming the other Runs tabs apply while refetching. Changing the workflow therefore left
  // the PREVIOUS workflow's run ids and per-node scores on screen, undimmed and unlabelled, under
  // the new selection for the length of a round trip — which on this plane is seconds. A stale
  // page is shown as loading rather than as this workflow's answer.
  const showingPrevious = runsQ.isPlaceholderData;
  const runs = showingPrevious ? [] : runsQ.data?.runs ?? [];
  // `useRunsPage` sets `placeholderData: keepPreviousData`, which types the result as
  // DefinedUseQueryResult — `isError` is the literal `false` there, so branching on `runsQ.isError`
  // narrows the other side to `never` and `runsQ.error` stops type-checking. The query can still
  // fail at runtime, so the error is read off the result directly rather than through a discriminant
  // the types have already decided.
  const runsError = runsQ.error;
  const refetchRuns = () => void runsQ.refetch();
  const evalByRun = useMemo(() => {
    const map = new Map<string, { score?: number; verdict?: string }>();
    for (const result of evalsQ.data ?? []) {
      if (!result.runId) continue;
      map.set(result.runId, { score: result.score ?? undefined, verdict: result.verdict ?? undefined });
    }
    return map;
  }, [evalsQ.data]);

  const nodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs) for (const id of Object.keys(run.scores ?? {})) ids.add(id);
    return [...ids].sort();
  }, [runs]);

  const points = useMemo(
    () =>
      runs
        .slice()
        .reverse()
        .flatMap((run) => {
          const mean = numericMean(run.scores);
          return mean === null ? [] : [{ runId: run.id, value: mean }];
        }),
    [runs],
  );

  if (runsQ.isError) {
    return <QueryError label="scores" message={runsQ.error?.message} onRetry={() => void runsQ.refetch()} />;
  }

  return (
    <Card
      label={
        <>
          scores · last {SPARK_WINDOW} runs
          <select
            id="scores-workflow"
            className="mono"
            value={workflowId}
            onChange={(e) => onSelectWorkflow(e.target.value)}
            style={{ marginLeft: 8, fontSize: 11.5 }}
          >
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </>
      }
    >
      {runsQ.isLoading || showingPrevious ? (
        <Skeleton lines={4} />
      ) : runsError ? (
        <QueryError label="run scores" message={runsError.message} onRetry={refetchRuns} />
      ) : runs.length === 0 ? (
        <p className="note">No runs yet for this workflow.</p>
      ) : nodeIds.length === 0 ? (
        <p className="note" id="scores-none">
          None of these runs recorded a score. That is not a score of zero: a run that has not reached
          its reviews records nothing, and this table shows what was recorded rather than filling the
          gap in.
        </p>
      ) : (
        <>
          <Lbl>trend · mean of each run&rsquo;s numeric scores, oldest to newest</Lbl>
          <Sparkline points={points} />
          <p className="note">
            Verdicts (&ldquo;pass&rdquo;, &ldquo;revise&rdquo;, &ldquo;blocked&rdquo;) are decisions, not
            measurements — they are shown per run below and never averaged into the line.
          </p>
          {/* W7 — this carried `className="grid"`, which is the RUN GRID's container class: base.css
              gives `.grid thead th` a vertical writing-mode, an 86px height and a 180° rotation,
              meant for a wrapper div around a table, not for the table itself. Applied here the
              column names printed sideways and ran up into the paragraph above them. This table's
              columns are node ids read left to right, so it gets its own class. */}
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="scoretbl" id="scores-table">
            <thead>
              <tr>
                <th>run</th>
                {nodeIds.map((nodeId) => (
                  <th key={nodeId} className="mono">
                    {nodeId}
                  </th>
                ))}
                <th>eval</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <button type="button" className="linkish mono" onClick={() => onOpen(run)} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }}>
                      …{run.id.slice(-10)}
                    </button>
                  </td>
                  {nodeIds.map((nodeId) => {
                    const score = run.scores?.[nodeId];
                    return (
                      <td key={nodeId} className="mono">
                        {score === undefined ? <span style={{ color: 'var(--faint)' }}>—</span> : isNumber(score) ? score.toFixed(2) : score}
                      </td>
                    );
                  })}
                  <td className="mono">
                    {(() => {
                      const evaluation = evalByRun.get(run.id);
                      if (!evaluation) return <span style={{ color: 'var(--faint)' }}>—</span>;
                      return `${evaluation.score !== undefined ? evaluation.score.toFixed(2) : ''}${evaluation.verdict ? ` ${evaluation.verdict}` : ''}`.trim();
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="note">
            A dash is &ldquo;this run recorded nothing for that node&rdquo;, never a zero. The eval
            column is a rubric&rsquo;s own verdict, joined by run id — an independent opinion from the
            run&rsquo;s own reviews, and a disagreement between the two is the interesting case.
          </p>
          {/* W7 — without this, a failed eval query rendered a dash in every eval cell and the
              sentence above told the reader it meant "recorded nothing". It did not: it meant we
              never asked successfully. */}
          {evalsQ.isError && (
            <p className="note" style={{ color: 'var(--bad)' }}>
              The eval column could not be loaded ({evalsQ.error?.message ?? 'evaluation_list_results failed'}), so every
              dash in it means &ldquo;not fetched&rdquo;, not &ldquo;no verdict&rdquo;.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
