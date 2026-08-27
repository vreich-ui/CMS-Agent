// U5 — the trace waterfall: one row per node, positioned by real start
// offset and sized by real duration, in topological order, for one run.
// Opens as `?modal=waterfall&m.run=…` (deep-linkable) from the Runs screen's
// row actions, the dock's timeline card, and ⌘K's "open trace waterfall for
// <run>" verb action.
//
// Order comes from the run's workflow graph (same dependsOn-based layering
// GraphOverlay.tsx uses — helpers.layerGraph), so spans read top-to-bottom
// in real dependency order rather than fixture/list order. When the graph
// has no data for this run's workflow (see GraphOverlay.tsx's own honest
// empty-state note on why that can legitimately happen), this falls back to
// the run record's own node order rather than showing nothing.
//
// A node with no measured `durationMs` — queued, or still running — renders
// as an honest "not timed" row, never a zero-width bar pretending to be
// instant (HANDOFF's standing rule, restated in the U5 brief). Failed and
// blocked spans are marked with a status chip AND a bar-border/glyph
// treatment, never color alone.

import { useMemo } from 'react';
import * as adapters from '../../api/adapters';
import { useRun, useRunCost, useWorkflowGraph } from '../../api/hooks';
import { Modal } from '../overlay/Modal';
import { Skeleton } from '../Skeleton';
import { StatusChip } from '../primitives';
import { formatDurationMs, layerGraph } from '../../screens/Workbench/helpers';
import { useStore } from '../../store';
import type { RunNode } from '../../types';

interface Span {
  nodeId: string;
  status: string;
  startedAt: number | null;
  durationMs: number | null;
  costUsd: number | null;
}

/** Boundary-trust read of the cost ledger's per-node stages — declared narrower
 * than the live shape in adapters.ts (see its own RawRunCostLedger doc
 * comment); this app has never needed the field until now, so it's read
 * defensively rather than assumed present (fixture mode genuinely has none —
 * see runCosts.json — so "no cost data" is an honest, common outcome here). */
function costByNode(ledger: unknown): Map<string, number> {
  const stages = (ledger as { stages?: Array<{ nodeId: string; costUsdEstimate?: number }> } | undefined)?.stages;
  const map = new Map<string, number>();
  if (Array.isArray(stages)) {
    for (const s of stages) {
      if (typeof s.nodeId === 'string' && typeof s.costUsdEstimate === 'number') map.set(s.nodeId, s.costUsdEstimate);
    }
  }
  return map;
}

function topoOrder(runNodes: RunNode[], graphNodes: Array<adapters.RawWorkflowNode> | undefined): string[] {
  const runIds = runNodes.map((n) => n.nodeId);
  if (!graphNodes || graphNodes.length === 0) return runIds;
  const known = new Set(runIds);
  const present = graphNodes.filter((n) => known.has(n.id));
  if (present.length === 0) return runIds;
  const edges = present.flatMap((n) => n.dependsOn.filter((d) => known.has(d)).map((dep) => ({ from: dep, to: n.id })));
  const layering = layerGraph(present.map((n) => n.id), edges);
  const ordered = layering.layers.flat();
  const extra = runIds.filter((id) => !ordered.includes(id));
  return [...ordered, ...extra];
}

const BAD_HATCH =
  'repeating-linear-gradient(45deg, color-mix(in srgb, var(--bad) 55%, transparent) 0 3px, transparent 3px 6px)';

function Bar({ span, leftPct, widthPct }: { span: Span; leftPct: number; widthPct: number }) {
  const isBad = span.status === 'failed';
  const isBlocked = span.status === 'blocked' || span.status === 'paused';
  const bg = isBad ? BAD_HATCH : isBlocked ? undefined : 'var(--run)';
  const borderColor = isBad ? 'var(--bad)' : isBlocked ? 'var(--acc)' : span.status === 'completed' ? 'var(--ok)' : 'var(--line2)';
  return (
    <div
      style={{
        position: 'absolute',
        left: `${leftPct}%`,
        width: `${Math.max(widthPct, 0.6)}%`,
        top: 3,
        bottom: 3,
        minWidth: 3,
        borderRadius: 4,
        background: bg ?? 'var(--line2)',
        border: `1.5px ${isBlocked ? 'dashed' : 'solid'} ${borderColor}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingRight: 3,
      }}
      title={`${span.nodeId} — ${span.status}${span.durationMs !== null ? ` — ${formatDurationMs(span.durationMs)}` : ''}`}
    >
      {isBad && (
        <span aria-hidden="true" style={{ color: 'var(--bad)', fontSize: 10, fontWeight: 700 }}>
          ✕
        </span>
      )}
    </div>
  );
}

function WaterfallBody({ runId, onPick }: { runId: string; onPick: (nodeId: string) => void }) {
  const runQ = useRun(runId);
  const run = runQ.data ?? null;
  const graphQ = useWorkflowGraph(run?.wf ?? null);
  const costQ = useRunCost(runId);

  const costMap = useMemo(() => costByNode(costQ.data?.ledger), [costQ.data]);

  const order = useMemo(() => topoOrder(run?.nodes ?? [], graphQ.data?.nodes), [run, graphQ.data]);

  const spans = useMemo<Span[]>(() => {
    if (!run) return [];
    const byId = new Map(run.nodes.map((n) => [n.nodeId, n]));
    return order.map((nodeId) => {
      const n = byId.get(nodeId);
      return {
        nodeId,
        status: n?.status ?? 'queued',
        startedAt: n?.startedAt ? Date.parse(n.startedAt) : null,
        durationMs: n?.durationMs ?? null,
        costUsd: costMap.get(nodeId) ?? null,
      };
    });
  }, [run, order, costMap]);

  const timed = spans.filter((s) => s.startedAt !== null && s.durationMs !== null);
  const minStart = timed.length > 0 ? Math.min(...timed.map((s) => s.startedAt as number)) : 0;
  const maxEnd =
    timed.length > 0 ? Math.max(...timed.map((s) => (s.startedAt as number) + (s.durationMs as number))) : 1;
  const totalRange = Math.max(1, maxEnd - minStart);

  // U7 — shared skeleton treatment instead of a bare loading line.
  if (runQ.isLoading) return <Skeleton lines={5} />;
  if (!run) return <p className="note" style={{ color: 'var(--bad)' }}>Run {runId} could not be resolved.</p>;
  if (spans.length === 0) return <p className="note">This run has no node records yet.</p>;

  const hasAnyCost = costMap.size > 0;

  return (
    <div>
      <div className="kv" style={{ gridTemplateColumns: '110px 1fr', fontSize: 12, marginBottom: 12 }}>
        <span className="k">run</span>
        <span className="mono">{run.id}</span>
        <span className="k">workflow</span>
        <span>{run.wf}</span>
        <span className="k">nodes timed</span>
        <span>
          {timed.length} of {spans.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {spans.map((span) => {
          const isTimed = span.startedAt !== null && span.durationMs !== null;
          const leftPct = isTimed ? (((span.startedAt as number) - minStart) / totalRange) * 100 : 0;
          const widthPct = isTimed ? (Math.max(span.durationMs as number, 1) / totalRange) * 100 : 0;
          return (
            <button
              key={span.nodeId}
              type="button"
              onClick={() => onPick(span.nodeId)}
              style={{ gridTemplateColumns: '160px 1fr 150px' }}
              className="wf-row"
            >
              <span
                className="mono"
                style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {span.nodeId}
              </span>
              <span style={{ position: 'relative', height: 22, background: 'var(--panel3)', borderRadius: 4 }}>
                {isTimed ? (
                  <Bar span={span} leftPct={leftPct} widthPct={widthPct} />
                ) : (
                  <span
                    className="mono"
                    style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', paddingLeft: 6, fontSize: 10, color: 'var(--faint)' }}
                  >
                    not timed — {span.status}
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                <StatusChip status={span.status} />
                <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', minWidth: 44, textAlign: 'right' }}>
                  {span.durationMs !== null ? formatDurationMs(span.durationMs) : '—'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="note">
        tool calls per span: not available from any live verb today — never fabricated here.{' '}
        {hasAnyCost
          ? 'cost per span from workflow_get_run_cost where the ledger has a stage entry for that node.'
          : 'cost per span: the cost ledger for this run carries no per-node stage breakdown, so cost is not shown per span.'}
      </p>
    </div>
  );
}

export function TraceWaterfallModal({ params, onClose }: { params: Record<string, string>; onClose: () => void }) {
  const runId = params.run ?? '';
  const bindRun = useStore((s) => s.bindRun);
  const run = useRun(runId || null).data;

  function pick(nodeId: string) {
    if (!run) return;
    bindRun(run.id, run.wf, nodeId);
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Trace waterfall" size="work" sub={runId ? <span className="mono">{runId}</span> : 'no run specified'}>
      {runId ? (
        <WaterfallBody runId={runId} onPick={pick} />
      ) : (
        <p className="note">Open this from a run's row action, the dock's timeline card, or ⌘K.</p>
      )}
    </Modal>
  );
}
