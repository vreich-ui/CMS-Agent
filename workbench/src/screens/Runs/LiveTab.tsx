// Tab 1 — Live. `.livecards` of runs whose status is running / paused /
// blocked (spec/mockup.html renderRuns(), S.runtab==='live'). This is the
// operator's "what needs me right now" view, so a blocked card names why
// it's stopped and a stalled card is never quiet about it (§7.2, §7.10).

import { Btn, Card, Chip, Dot, Note, StatusChip } from '../../components/primitives';
import { Ic } from '../../components/Icons';
import type { Run, Workflow } from '../../types';
import { blockedSummary, orderedNodes, shortId } from './helpers';

const LIVE_STATUSES = new Set(['running', 'paused', 'blocked']);

function LiveCard({ run, wf, onOpen }: { run: Run; wf: Workflow | undefined; onOpen: () => void }) {
  const total = wf ? orderedNodes(wf).length : run.done;
  return (
    <div className="livecard">
      <div className="top">
        <span className="mono" style={{ fontSize: 11.5 }}>
          {shortId(run.id)}
        </span>
        <StatusChip status={run.status} />
      </div>
      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
        {wf && <Ic id={wf.icon} />}
        {wf?.name ?? run.wf}
        <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· {run.proj}</span>
      </div>
      <div className="kv" style={{ gridTemplateColumns: '80px 1fr', fontSize: 12, margin: '8px 0' }}>
        <span className="k">stopped at</span>
        <span className="mono" style={{ fontSize: 11.5 }}>
          {run.cur ?? '—'}
        </span>
        <span className="k">progress</span>
        <span className="num">
          {run.done}/{total} · ${run.cost.toFixed(2)}
        </span>
      </div>
      {run.stall ? (
        <div style={{ margin: '0 0 10px' }}>
          <Chip status="failed">
            <Dot status="failed" />
            stalled — driver not responding
          </Chip>
          <p className="note" style={{ margin: '6px 0 0' }}>
            the run engine stopped advancing this run on its own — cancel it and start a fresh run rather than
            waiting on it.
          </p>
        </div>
      ) : run.status === 'blocked' ? (
        <p className="note" style={{ margin: '0 0 10px' }}>
          blocked at <span className="mono">{run.cur}</span> — {blockedSummary(run.cur)}.
        </p>
      ) : null}
      <Btn variant="pri" onClick={onOpen}>
        Open in workbench →
      </Btn>
    </div>
  );
}

export function LiveTab({
  runs,
  workflowById,
  onOpen,
  onGoHistory,
}: {
  runs: Run[];
  workflowById: Record<string, Workflow>;
  onOpen: (run: Run) => void;
  onGoHistory: () => void;
}) {
  const live = runs.filter((r) => LIVE_STATUSES.has(r.status));

  if (live.length === 0) {
    return (
      <Card label="live runs">
        <p style={{ margin: '0 0 10px', color: 'var(--muted)' }}>
          Nothing is running, paused, or blocked right now — the pipeline is caught up.
        </p>
        <Btn onClick={onGoHistory}>View history →</Btn>
      </Card>
    );
  }

  return (
    <>
      <div className="livecards">
        {live.map((run) => (
          <LiveCard key={run.id} run={run} wf={workflowById[run.wf]} onOpen={() => onOpen(run)} />
        ))}
      </div>
      <Note>A run whose worker died shows a stalled badge here, so you know to reset it.</Note>
    </>
  );
}

// Re-exported so a future tab (or a test) can reuse the same "what counts as
// live" definition without duplicating the status set.
export { LIVE_STATUSES };
