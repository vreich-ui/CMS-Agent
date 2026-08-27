// WP-15 — Workflows library screen. Markup/behaviour mirror spec/mockup.html
// (`#s-library`, `renderLibrary()`) and its `.cards .wfcard .wfcard.planned
// .ttl .desc .stats .foot` CSS (already present in styles/base.css). Data
// comes only through api/hooks.ts (useWorkflows/useRuns/useWorkflowGraph),
// never from fixtures directly.
//
// U1 — this is the operator's command deck: an AttentionStrip up top (what
// needs a human, ranked, with a one-click jump), a "resume where I left
// off" chip, and the workflow cards below now driven by
// useWorkflowGraph(workflowId) instead of the static catalog's node count —
// see workflowCatalog.ts's own doc comment on why that copy goes stale
// (clone_conductor's real 18-node live topology vs. the catalog's 9,
// capture_conductor's 16 vs. 11). New CSS for the strip/chip lives in
// styles/base.css's appended `/* U1 */` block.

import { useMemo } from 'react';
import { useRuns, useWorkflowGraph, useWorkflows } from '../../api/hooks';
import { AttentionStrip } from '../../components/AttentionStrip';
import { Ic } from '../../components/Icons';
import { Btn, Lbl } from '../../components/primitives';
import { useStore } from '../../store';
import type { Run, RunStatus, Workflow } from '../../types';
import { useResumeContext } from './resume';

// Statuses that count as "needing attention" — mirrors mockup's
// ['running','paused','blocked'].includes(r.status).
const ATTENTION_STATUSES: ReadonlySet<RunStatus> = new Set(['running', 'paused', 'blocked']);

/** Mirrors the mockup's orderedNodes(wf): phases flattened in display order. */
function orderedNodeIds(wf: Workflow): string[] {
  return wf.phases.flatMap(([, ids]) => ids);
}

// U7 — bars now reuse the shared shimmer (styles/base.css's `.skel-line`,
// the same treatment behind `<Skeleton>`) instead of flat `var(--line2)`,
// so this card-shaped placeholder shimmers the same way every other
// loading panel in the app now does. The card SHAPE stays bespoke — this
// mimics a WorkflowCard's own layout, which `<Skeleton>`'s generic stacked
// lines can't.
function WfCardSkeleton() {
  return (
    <div className="wfcard" aria-hidden="true" style={{ opacity: 0.6 }}>
      <div className="ttl">
        <span className="skel-line" style={{ width: 20, height: 20, borderRadius: 5, display: 'inline-block' }} />
        <span className="skel-line" style={{ width: '55%', height: 14, display: 'inline-block' }} />
      </div>
      <span className="lbl skel-line" style={{ width: '40%', height: 10, display: 'inline-block' }} />
      <p className="desc skel-line" style={{ borderRadius: 4 }}>&nbsp;</p>
      <div className="stats">
        <span className="skel-line" style={{ width: 60, height: 11, display: 'inline-block' }} />
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

  // U1(c) — the workspace's real topology for this conductor
  // (`workspace_get_graph({workflowId})`), not the catalog's hand-
  // maintained phase list, which the catalog's own doc comment admits is
  // stale for two of three workflows (clone_conductor: catalog says 9,
  // live says 18; capture_conductor: catalog says 11, live says 16 — see
  // workflowCatalog.ts and contracts/README.md). The catalog is only ever
  // used as a navigation fallback (which node to open first) and never
  // again presented as a node *count*.
  //
  // The fixture workspace (api/fixtures/README.md) is now a verbatim live
  // capture of all 48 nodes across all three conductors, so the live
  // graph query genuinely returns each conductor's real node count here
  // (publishing_conductor 24, capture_conductor 16, clone_conductor 18 —
  // contracts/README.md). `nodeCountGap`/the tooltip below are dead in
  // this fixture but stay in place as the honest fallback for any
  // workflow the live query can't resolve.
  const graphQ = useWorkflowGraph(wf.id);
  const catalogNodeIds = orderedNodeIds(wf);
  const liveNodeIds = graphQ.data?.nodes.map((n) => n.id);
  const nodeCount = liveNodeIds?.length;
  const nodeCountGap = nodeCount === 0 && catalogNodeIds.length > 0;

  const active = runs.filter((r) => ATTENTION_STATUSES.has(r.status)).length;
  // runs arrive newest-first per workflow (mockStore.getRuns preserves fixture
  // order, which is newest-first — see fixtures/README.md), so runs[0] is the
  // most recent run, mirroring the mockup's `rs[0]`.
  const last = runs[0];

  function openWorkbench() {
    const firstNode = (liveNodeIds && liveNodeIds.length > 0 ? liveNodeIds : catalogNodeIds)[0];
    setWf(wf.id);
    if (firstNode) setNode(firstNode);
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
        <span
          title={
            nodeCountGap
              ? `workspace_get_graph reported 0 live nodes for this workflow. The catalog's phase config lists ${catalogNodeIds.length} ids for reference (see workflowCatalog.ts) — not shown here as a live count.`
              : undefined
          }
        >
          {nodeCount != null ? `${nodeCount} nodes` : graphQ.isError ? 'nodes: unavailable' : '… nodes'}
        </span>
        <span>{runs.length} runs</span>
        <span>{active} needing attention</span>
        <span>
          {last ? (
            <>
              last:{' '}
              <span className={`chip ${last.status}`} style={{ padding: '1px 7px' }}>
                {last.status}
              </span>{' '}
              · {last.started}
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

/** U1(b) — shows exactly what a click will restore, before it's clicked.
 *  Renders nothing when there is nothing to resume (readResume() -> null). */
function ResumeChip() {
  const ctx = useResumeContext();
  const bindRun = useStore((s) => s.bindRun);
  const setWf = useStore((s) => s.setWf);
  const setNode = useStore((s) => s.setNode);
  const unbindRun = useStore((s) => s.unbindRun);
  const setScreen = useStore((s) => s.setScreen);

  if (!ctx) return null;

  const label = ctx.runId ? `${ctx.wf} · ${ctx.node} · run …${ctx.runId.slice(-6)}` : `${ctx.wf} · ${ctx.node}`;

  function onClick() {
    if (ctx?.runId) bindRun(ctx.runId, ctx.wf, ctx.node);
    else if (ctx) {
      setWf(ctx.wf);
      setNode(ctx.node);
      unbindRun();
      setScreen('bench');
    }
  }

  return (
    <button type="button" className="resume-chip" id="resume-chip" onClick={onClick}>
      <span className="k">resume</span>
      <span className="mono">{label}</span>
    </button>
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

      <ResumeChip />

      <AttentionStrip />

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
