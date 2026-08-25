// WP-15 — Workflows library screen. Markup/behaviour mirror spec/mockup.html
// (`#s-library`, `renderLibrary()`) and its `.cards .wfcard .wfcard.planned
// .ttl .desc .stats .foot` CSS (already present in styles/base.css) — no new
// CSS is introduced here. Data comes only through api/hooks.ts
// (useWorkflows/useRuns), never from fixtures directly.

import { useMemo } from 'react';
import { useRuns, useWorkflows } from '../../api/hooks';
import { Ic } from '../../components/Icons';
import { Btn, Lbl } from '../../components/primitives';
import { useStore } from '../../store';
import type { Run, RunStatus, Workflow } from '../../types';

// Statuses that count as "needing attention" — mirrors mockup's
// ['running','paused','blocked'].includes(r.status).
const ATTENTION_STATUSES: ReadonlySet<RunStatus> = new Set(['running', 'paused', 'blocked']);

/** Mirrors the mockup's orderedNodes(wf): phases flattened in display order. */
function orderedNodeIds(wf: Workflow): string[] {
  return wf.phases.flatMap(([, ids]) => ids);
}

function WfCardSkeleton() {
  return (
    <div className="wfcard" aria-hidden="true" style={{ opacity: 0.5 }}>
      <div className="ttl">
        <span style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--line2)', display: 'inline-block' }} />
        <span style={{ width: '55%', height: 14, borderRadius: 4, background: 'var(--line2)', display: 'inline-block' }} />
      </div>
      <span className="lbl" style={{ width: '40%', height: 10, borderRadius: 4, background: 'var(--line2)', display: 'inline-block' }} />
      <p className="desc" style={{ background: 'var(--line2)', borderRadius: 4 }}>&nbsp;</p>
      <div className="stats">
        <span style={{ width: 60, height: 11, borderRadius: 4, background: 'var(--line2)', display: 'inline-block' }} />
      </div>
    </div>
  );
}

function ErrorCard({ label, message }: { label: string; message: string }) {
  return (
    <div className="card">
      <span className="lbl">{label}</span>
      <p style={{ margin: 0, color: 'var(--bad)' }}>{message}</p>
    </div>
  );
}

function WorkflowCard({ wf, runs }: { wf: Workflow; runs: Run[] }) {
  const setWf = useStore((s) => s.setWf);
  const setNode = useStore((s) => s.setNode);
  const setScreen = useStore((s) => s.setScreen);
  const unbindRun = useStore((s) => s.unbindRun);
  const openStartModal = useStore((s) => s.openStartModal);

  const nodeIds = orderedNodeIds(wf);
  const active = runs.filter((r) => ATTENTION_STATUSES.has(r.status)).length;
  // runs arrive newest-first per workflow (mockStore.getRuns preserves fixture
  // order, which is newest-first — see fixtures/README.md), so runs[0] is the
  // most recent run, mirroring the mockup's `rs[0]`.
  const last = runs[0];

  function openWorkbench() {
    setWf(wf.id);
    if (nodeIds[0]) setNode(nodeIds[0]);
    unbindRun(); // clears runId, mode -> 'build', tab -> 'prompt'
    setScreen('bench');
  }

  return (
    <div className="wfcard">
      <div className="ttl">
        <Ic id={wf.icon} />
        <h3>{wf.name}</h3>
      </div>
      <Lbl>{wf.fn}</Lbl>
      <p className="desc">{wf.desc}</p>
      <div className="stats">
        <span>{nodeIds.length} nodes</span>
        <span>{active} needing attention</span>
        <span>
          {last ? (
            <>
              last:{' '}
              <span className={`chip ${last.status}`} style={{ padding: '1px 7px' }}>
                {last.status}
              </span>
            </>
          ) : (
            'no runs yet'
          )}
        </span>
      </div>
      <div className="foot">
        <Btn onClick={openWorkbench}>Open workbench</Btn>
        <Btn
          variant="pri"
          onClick={() => {
            setWf(wf.id);
            openStartModal();
          }}
        >
          Start run
        </Btn>
      </div>
    </div>
  );
}

/**
 * UI-only fourth card — deliberately NOT part of the workflow data (it is a
 * planned conductor, not a real one), so it is hardcoded here rather than
 * threaded through the fixtures/hooks like the real three. Markup mirrors
 * the mockup's trailing `.wfcard.planned` literal verbatim.
 */
function PlannedCard() {
  return (
    <div className="wfcard planned">
      <div className="ttl">
        <Ic id="ic-charity" />
        <h3>Foundation-charity conductor</h3>
      </div>
      <Lbl>foundation &amp; charity publishing specialist</Lbl>
      <p className="desc">
        Planned. The rail&rsquo;s phase grouping is data-driven — it absorbs a new conductor without UI work.
      </p>
      <div className="stats">
        <span>— nodes</span>
      </div>
    </div>
  );
}

export function Library() {
  const workflowsQ = useWorkflows();
  const runsQ = useRuns({});

  const runsByWf = useMemo(() => {
    const map = new Map<string, Run[]>();
    for (const run of runsQ.data ?? []) {
      const list = map.get(run.wf);
      if (list) list.push(run);
      else map.set(run.wf, [run]);
    }
    return map;
  }, [runsQ.data]);

  const isLoading = workflowsQ.isLoading || runsQ.isLoading;
  const isError = workflowsQ.isError || runsQ.isError;

  return (
    <main className="pagewrap">
      <div className="pagehead">
        <h1>Workflows</h1>
        <span className="sub">function-based conductors — clients bind at run start, not here</span>
      </div>

      {isError ? (
        <ErrorCard
          label="workflows"
          message={workflowsQ.error?.message ?? runsQ.error?.message ?? 'Failed to load workflows.'}
        />
      ) : isLoading ? (
        <div className="cards">
          <WfCardSkeleton />
          <WfCardSkeleton />
          <WfCardSkeleton />
        </div>
      ) : (
        <div className="cards">
          {(workflowsQ.data ?? []).map((wf) => (
            <WorkflowCard key={wf.id} wf={wf} runs={runsByWf.get(wf.id) ?? []} />
          ))}
          <PlannedCard />
        </div>
      )}
    </main>
  );
}
