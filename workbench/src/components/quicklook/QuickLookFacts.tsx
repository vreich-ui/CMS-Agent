// U5 — the glanceable facts shared by the popover (Rail row / runs-grid
// cell hover) and the `quicklook` modal it promotes to on a narrow
// viewport: id, name, risk, model, tool count, last run status, last
// duration. Commits nothing — every value here is a read.
//
// "Last run status/duration" deliberately does NOT call
// `node_list_executions`/`node_get_latest_output` — both are documented
// live failures whenever a `nodeId` is present (contracts/README.md
// Finding #2). It scans `workflow_list_runs`' own rows instead: each row
// already carries the full `nodes[]` timing array (WP-00 capture,
// confirmed against `contracts/raw/workflow_list_runs.json`), so the most
// recent run that actually reached this node answers the question with
// data a verb that's known to work already returned.

import { useMemo } from 'react';
import { useNode, useRuns } from '../../api/hooks';
import { QueryError } from '../QueryError';
import { Skeleton } from '../Skeleton';
import type { Risk, Run } from '../../types';
import { formatDurationMs } from '../../screens/Workbench/helpers';

function runTimestamp(run: Run): number {
  return Number(/^run_(\d+)_/.exec(run.id)?.[1] ?? 0);
}

/** The most recent run (across `runs`) that reached `nodeId`, and what that run recorded for it. */
function lastNodeRun(runs: Run[], nodeId: string): { runId: string; status: string; durationMs: number | null } | null {
  const sorted = [...runs].sort((a, b) => runTimestamp(b) - runTimestamp(a));
  for (const r of sorted) {
    const entry = r.nodes.find((n) => n.nodeId === nodeId);
    if (entry) return { runId: r.id, status: entry.status, durationMs: entry.durationMs ?? null };
  }
  return null;
}

const RISK_TITLE: Record<Risk, string> = { read: 'read-only', write: 'writes', publish: 'can publish' };

export function QuickLookFacts({ nodeId, workflowId }: { nodeId: string; workflowId?: string }) {
  const nodeQ = useNode(nodeId);
  // W4 — the "last run" line reports what the most recent run recorded FOR THIS NODE, which
  // needs node states: `detail: 'full'`, over the newest few runs rather than a full page.
  const runsQ = useRuns(workflowId ? { workflowId, limit: 8, detail: 'full' as const } : {}, {
    enabled: Boolean(workflowId),
  });

  const last = useMemo(() => {
    if (!runsQ.data) return null;
    return lastNodeRun(runsQ.data, nodeId);
  }, [runsQ.data, nodeId]);

  if (nodeQ.isLoading) {
    // U7 — shared skeleton treatment instead of a bare "loading…" line.
    return <Skeleton lines={4} />;
  }
  // W2 — a FAILED read used to fall through to "could not be resolved", which claims the
  // workspace has no such node. It says nothing of the kind: the call failed. Those are
  // different facts and only one of them is retryable.
  if (nodeQ.isError) {
    return <QueryError message={nodeQ.error?.message} onRetry={() => void nodeQ.refetch()} inline />;
  }
  if (!nodeQ.data) {
    return (
      <p className="note" style={{ margin: 0 }}>
        <span className="mono">{nodeId}</span> could not be resolved — no live node record for it.
      </p>
    );
  }

  const n = nodeQ.data;
  return (
    <dl>
      <dt>id</dt>
      <dd>{n.id}</dd>
      <dt>name</dt>
      <dd style={{ fontFamily: 'var(--sans)' }}>{n.name}</dd>
      <dt>risk</dt>
      <dd>
        <span className={`risk ${n.risk}`} title={RISK_TITLE[n.risk]}>
          {n.risk}
        </span>
      </dd>
      <dt>model</dt>
      <dd>
        {n.model
          ? `budget $${n.model.budgetUsd} · ${n.model.maxTurns} turns · ${n.model.timeout}`
          : 'not configured'}
      </dd>
      <dt>tools</dt>
      <dd>{n.tools.length}</dd>
      <dt>last run</dt>
      <dd>
        {runsQ.isLoading && workflowId
          ? '…'
          : last
            ? `${last.status}${last.durationMs !== null ? ` · ${formatDurationMs(last.durationMs)}` : ''} (${last.runId.slice(-10)})`
            : 'no recorded run reached this node'}
      </dd>
    </dl>
  );
}
