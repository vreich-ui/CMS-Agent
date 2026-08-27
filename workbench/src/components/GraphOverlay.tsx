// U5 — the graph overlay: a real, navigable rendering of the ACTIVE
// workflow's live topology, not a "this is a gap" notice. Opens with "G"
// (from the rail's "⌗ graph overlay" ghost button, or the bare key from
// anywhere), closes with Escape, scrim click, or picking a node.
//
// Data: `useWorkflowGraph(wf)` -> `workspace_get_graph({workflowId})`, the
// one verb that answers "what does this workflow actually look like" (see
// api/hooks.ts's own doc comment). Layout is computed fresh from each
// node's own `dependsOn` list rather than the graph call's separate `edges`
// array — the two are supposed to agree (and do, live), but a node's
// `dependsOn` is the one field every code path (live AND the fixture mock)
// keeps in sync with the node record itself, so it is the more trustworthy
// source to lay a DAG out from. Layers come from helpers.layerGraph()
// (longest-path-from-roots, cycles broken defensively — see its doc
// comment). If the workflow's own graph genuinely has no nodes yet
// (workspace_get_graph can honestly return an empty set for a workflow this
// environment has no live/fixture data for), that is shown as an honest
// empty state, never a fabricated diagram.
//
// Phase tint (from the catalog's phase groupings — presentation only, see
// workflowCatalog.ts), risk badge (unmistakable on 'publish'), and — when a
// run is bound — real per-node run status (helpers.nodeStatusFromRun, not
// position-inferred) are all shown with text/glyphs alongside color, never
// color alone. The run's current/stopped node gets an extra ring and is
// scrolled into view on open — the whole point of this overlay, per the
// brief, is landing the operator's eye on the node that matters without
// hunting.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as adapters from '../api/adapters';
import { useRun, useWorkflowGraph, useWorkflows } from '../api/hooks';
import { RiskBadge } from './primitives';
import { Skeleton } from './Skeleton';
import { layerGraph, nodeStatusFromRun, phaseLabelForNode, type NodeRunStatus } from '../screens/Workbench/helpers';
import { useStore } from '../store';
import type { Run, Workflow, WorkflowNode } from '../types';

const COL_W = 190;
const ROW_H = 58;
const PAD_TOP = 34;
const PAD_X = 18;
const NODE_W = 164;
const NODE_H = 42;
const MIN_SCALE = 0.3;
const MAX_SCALE = 1.75;

const STATUS_META: Record<NodeRunStatus, { color: string; glyph: string; label: string }> = {
  completed: { color: 'var(--ok)', glyph: '✓', label: 'completed' },
  running: { color: 'var(--run)', glyph: '▶', label: 'running' },
  blocked: { color: 'var(--acc)', glyph: '⛔', label: 'blocked' },
  failed: { color: 'var(--bad)', glyph: '✕', label: 'failed' },
  cancelled: { color: 'var(--faint)', glyph: '∅', label: 'cancelled' },
  queued: { color: 'var(--line2)', glyph: '·', label: 'queued' },
};

// Cycled per phase index — a decorative grouping wash, never the only
// signal (every node also carries its phase name in a caption + title).
const PHASE_TINTS = ['var(--acc)', 'var(--run)', 'var(--ok)', 'var(--paused)', 'var(--bad)'];

interface Pos {
  x: number;
  y: number;
  layer: number;
}

interface GraphNode {
  node: WorkflowNode;
  deps: string[];
}

function EmptyNotice({ workflowName }: { workflowName: string }) {
  return (
    <div className="card" style={{ borderColor: 'var(--line2)' }}>
      <span className="lbl">no live graph for {workflowName}</span>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        <code className="mono">workspace_get_graph</code> returned no nodes for this workflow in this environment —
        shown honestly rather than a fabricated diagram. Switch workflow (⌘K → a workflow name) to see a graph that
        has data.
      </p>
    </div>
  );
}

function NodeBox({
  gn,
  pos,
  phaseIdx,
  phaseLabel,
  status,
  isCurrent,
  onSelect,
}: {
  gn: GraphNode;
  pos: Pos;
  phaseIdx: number;
  phaseLabel: string | null;
  status: NodeRunStatus | null;
  isCurrent: boolean;
  onSelect: (id: string) => void;
}) {
  const meta = status ? STATUS_META[status] : null;
  const tint = PHASE_TINTS[phaseIdx % PHASE_TINTS.length];
  const label = [
    gn.node.id,
    phaseLabel ? `phase: ${phaseLabel}` : 'ungrouped',
    `risk: ${gn.node.risk}`,
    meta ? `status: ${meta.label}` : null,
    isCurrent ? 'current node' : null,
  ]
    .filter(Boolean)
    .join(' — ');

  return (
    <button
      type="button"
      onClick={() => onSelect(gn.node.id)}
      title={gn.node.id}
      aria-label={label}
      style={{
        position: 'absolute',
        left: pos.x - NODE_W / 2,
        top: pos.y - NODE_H / 2,
        width: NODE_W,
        height: NODE_H,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        padding: '5px 9px',
        background: `color-mix(in srgb, ${tint} 10%, var(--panel2))`,
        border: `1.5px solid ${meta ? meta.color : 'var(--line2)'}`,
        borderRadius: 8,
        boxShadow: isCurrent ? `0 0 0 3px color-mix(in srgb, var(--acc) 45%, transparent)` : undefined,
        color: 'var(--ink)',
        textAlign: 'left',
        overflow: 'hidden',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {meta && (
          <span aria-hidden="true" style={{ color: meta.color, fontSize: 10, flex: 'none' }}>
            {meta.glyph}
          </span>
        )}
        <span
          className="mono"
          style={{ fontSize: 10.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {gn.node.id}
        </span>
        <RiskBadge risk={gn.node.risk} />
      </span>
      <span
        className="mono"
        style={{ fontSize: 9, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {phaseLabel ?? 'ungrouped'}
      </span>
    </button>
  );
}

function GraphCanvas({
  workflow,
  nodes,
  run,
  onSelect,
}: {
  workflow: Workflow;
  nodes: GraphNode[];
  run: Run | null;
  onSelect: (nodeId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [fitted, setFitted] = useState(false);

  const nodeIds = useMemo(() => nodes.map((n) => n.node.id), [nodes]);
  const edges = useMemo(
    () => nodes.flatMap((n) => n.deps.map((dep) => ({ from: dep, to: n.node.id }))),
    [nodes],
  );
  const layering = useMemo(() => layerGraph(nodeIds, edges), [nodeIds, edges]);

  const positions = useMemo(() => {
    const map = new Map<string, Pos>();
    layering.layers.forEach((layerIds, layerIdx) => {
      layerIds.forEach((id, rowIdx) => {
        map.set(id, {
          x: PAD_X + layerIdx * COL_W + COL_W / 2,
          y: PAD_TOP + rowIdx * ROW_H + ROW_H / 2,
          layer: layerIdx,
        });
      });
    });
    return map;
  }, [layering]);

  const maxRows = Math.max(1, ...layering.layers.map((l) => l.length));
  const diagramWidth = PAD_X * 2 + (layering.maxLayer + 1) * COL_W;
  const diagramHeight = PAD_TOP + maxRows * ROW_H + 20;

  const phaseByNode = useMemo(() => {
    const map = new Map<string, { label: string | null; idx: number }>();
    const labelOrder: string[] = [];
    for (const gn of nodes) {
      const label = phaseLabelForNode(workflow, gn.node.id);
      if (label && !labelOrder.includes(label)) labelOrder.push(label);
      map.set(gn.node.id, { label, idx: 0 });
    }
    for (const [id, entry] of map) {
      entry.idx = entry.label ? labelOrder.indexOf(entry.label) : labelOrder.length;
      map.set(id, entry);
    }
    return map;
  }, [nodes, workflow]);

  function fitToWidth() {
    const containerWidth = scrollRef.current?.clientWidth ?? diagramWidth;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, containerWidth / diagramWidth));
    setScale(next);
  }

  // Fit once when the graph first has real dimensions, then leave the
  // operator's own zoom alone.
  useEffect(() => {
    if (fitted || diagramWidth <= 0) return;
    fitToWidth();
    setFitted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramWidth, fitted]);

  // Land the operator's eye on the node that matters: the run's current/
  // stopped node, scrolled into view once positions are known.
  useEffect(() => {
    if (!run?.cur) return;
    const id = run.cur;
    const raf = requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`button[title="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'center', inline: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [run?.cur, positions]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" className="btn" onClick={() => setScale((s) => Math.max(MIN_SCALE, s - 0.15))}>
          − zoom out
        </button>
        <button type="button" className="btn" onClick={() => setScale((s) => Math.min(MAX_SCALE, s + 0.15))}>
          + zoom in
        </button>
        <button type="button" className="btn" onClick={fitToWidth}>
          fit to width
        </button>
        <span className="note" style={{ margin: 0 }}>
          {Math.round(scale * 100)}% · {nodes.length} nodes · {layering.maxLayer + 1} layers
          {layering.hadCycle ? ' · a cycle was detected and broken so this still renders' : ''}
        </span>
      </div>
      <div
        ref={scrollRef}
        style={{
          overflow: 'auto',
          maxHeight: '62vh',
          border: '1px solid var(--line)',
          borderRadius: 10,
          background: 'var(--bg)',
        }}
      >
        <div style={{ width: diagramWidth * scale, height: diagramHeight * scale, position: 'relative' }}>
          <div
            style={{
              width: diagramWidth,
              height: diagramHeight,
              position: 'absolute',
              left: 0,
              top: 0,
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
            }}
          >
            <svg
              width={diagramWidth}
              height={diagramHeight}
              style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
            >
              {edges.map((e, i) => {
                const a = positions.get(e.from);
                const b = positions.get(e.to);
                if (!a || !b) return null;
                const dx = Math.max(30, (b.x - a.x) / 2);
                return (
                  <path
                    key={`${e.from}-${e.to}-${i}`}
                    d={`M ${a.x + NODE_W / 2} ${a.y} C ${a.x + NODE_W / 2 + dx} ${a.y}, ${b.x - NODE_W / 2 - dx} ${b.y}, ${b.x - NODE_W / 2} ${b.y}`}
                    fill="none"
                    stroke="var(--line2)"
                    strokeWidth={1.4}
                  />
                );
              })}
            </svg>
            {nodes.map((gn) => {
              const pos = positions.get(gn.node.id);
              if (!pos) return null;
              const phase = phaseByNode.get(gn.node.id) ?? { label: null, idx: 0 };
              const status = run ? nodeStatusFromRun(run, gn.node.id) : null;
              return (
                <NodeBox
                  key={gn.node.id}
                  gn={gn}
                  pos={pos}
                  phaseIdx={phase.idx}
                  phaseLabel={phase.label}
                  status={status}
                  isCurrent={run?.cur === gn.node.id}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function GraphOverlay() {
  const open = useStore((s) => s.graphOverlayOpen);
  const openOverlay = useStore((s) => s.openGraphOverlay);
  const closeOverlay = useStore((s) => s.closeGraphOverlay);
  const wf = useStore((s) => s.wf);
  const mode = useStore((s) => s.mode);
  const runId = useStore((s) => s.runId);
  const setNode = useStore((s) => s.setNode);
  const setScreen = useStore((s) => s.setScreen);

  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const workflowsQ = useWorkflows();
  const workflow = workflowsQ.data?.find((w) => w.id === wf);

  const boundRunQ = useRun(mode === 'run' ? runId : null);
  const run = mode === 'run' ? (boundRunQ.data ?? null) : null;

  const graphQ = useWorkflowGraph(open ? wf : null);

  const graphNodes = useMemo<GraphNode[]>(() => {
    const raw = graphQ.data?.nodes ?? [];
    return raw.map((n) => ({ node: adapters.toNode(n), deps: n.dependsOn }));
  }, [graphQ.data]);

  // "G" opens from anywhere (never while typing); Escape/scrim-click/node-
  // click close. Mirrors CommandPalette.tsx's guard exactly.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'g') return;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (typing) return;
      openOverlay();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openOverlay]);

  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      closeRef.current?.focus();
    } else {
      triggerRef.current?.focus?.();
      triggerRef.current = null;
    }
  }, [open]);

  if (!open) return null;

  function selectNode(nodeId: string) {
    setNode(nodeId);
    setScreen('bench');
    closeOverlay();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeOverlay();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="scrim open"
      ref={scrimRef}
      onMouseDown={(e) => {
        if (e.target === scrimRef.current) closeOverlay();
      }}
    >
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="graphoverlay-title"
        style={{ width: 'min(1180px, 96vw)' }}
        onKeyDown={onKeyDown}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <h3 id="graphoverlay-title">Graph overlay — {workflow?.name ?? wf}</h3>
          <button className="btn" ref={closeRef} onClick={closeOverlay}>
            ✕ close
          </button>
        </div>
        <div className="sub">
          Real topology from workspace_get_graph, layered by dependency depth. Click a node (or Tab to it, Enter to
          pick) to jump to it in the rail and close this overlay.
        </div>

        {/* U7 polish — error checked before loading (mirrors Rail.tsx's
            P2-02 fix). Two independent queries: checking the combined
            isLoading first used to leave workflowsQ's error invisible
            (falling only into the honest-but-wrong `!workflow` branch)
            for as long as graphQ was still loading or retrying. */}
        {graphQ.isError || workflowsQ.isError ? (
          <p className="note" style={{ color: 'var(--bad)' }}>
            {graphQ.error instanceof Error
              ? graphQ.error.message
              : workflowsQ.error instanceof Error
                ? workflowsQ.error.message
                : 'Could not load the graph.'}
          </p>
        ) : graphQ.isLoading || workflowsQ.isLoading ? (
          <Skeleton lines={5} />
        ) : !workflow ? (
          <p className="note" style={{ color: 'var(--bad)' }}>Could not load the graph.</p>
        ) : graphNodes.length === 0 ? (
          <EmptyNotice workflowName={workflow.name} />
        ) : (
          <GraphCanvas workflow={workflow} nodes={graphNodes} run={run} onSelect={selectNode} />
        )}
      </div>
    </div>
  );
}
