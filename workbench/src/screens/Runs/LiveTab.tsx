// Tab 1 — Live. `.livecards` of runs whose status is running / paused /
// blocked (spec/mockup.html renderRuns(), S.runtab==='live'). This is the
// operator's "what needs me right now" view, so a blocked card names why
// it's stopped and a stalled card is never quiet about it (§7.2, §7.10).

import { Btn, Card, Chip, Dot, Note, StatusChip } from '../../components/primitives';
import { Ic } from '../../components/Icons';
import type { Run, Workflow } from '../../types';
import { blockedSummary, orderedNodes, shortId } from './helpers';

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
  matchedCount,
  workflowById,
  onOpen,
  onGoHistory,
}: {
  /** REVIEW FIX — already scoped to the live statuses BY THE SERVER (see Runs/index.tsx). This
   *  used to be the screen's generic newest-20 page, filtered here: a blocked run older than the
   *  window simply vanished, and the empty state below then announced that the pipeline was
   *  caught up. An all-clear is the one claim this tab must never make on partial data. */
  runs: Run[];
  /** Every live run the server matched, which is what this tab's count must report. */
  matchedCount: number;
  workflowById: Record<string, Workflow>;
  onOpen: (run: Run) => void;
  onGoHistory: () => void;
}) {
  const live = runs;

  if (matchedCount === 0) {
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
      {/* REVIEW FIX (round 2) — the tab is capped at 100 rows; say so rather than truncating
          silently. The empty claim above is now honest, and so is the full one. */}
      {matchedCount > live.length ? (
        <Note>
          Showing {live.length} of {matchedCount} live runs — narrow by workflow or project in History to see the
          rest.
        </Note>
      ) : null}
      <div className="livecards">
        {live.map((run) => (
          <LiveCard key={run.id} run={run} wf={workflowById[run.wf]} onOpen={() => onOpen(run)} />
        ))}
      </div>
      <Note>A run whose worker died shows a stalled badge here, so you know to reset it.</Note>
    </>
  );
}
