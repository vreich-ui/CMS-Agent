// WP-42b — the graph overlay: a read-only rendering of `workspace_get_graph`,
// deliberately an *overlay* (a `.scrim`/`.modal`), never a screen — the
// demoted constellation view is not coming back as the home screen. Opens
// with "G" (from the rail's "⌗ graph overlay" ghost button, or the bare key
// from anywhere), closes with Escape, scrim click, or picking a node.
//
// Layout: the cheapest correct option named in the WP brief — a layered DAG,
// columns = the workflow's own phases (the same grouping the rail already
// shows, so this reads as "the rail's shape, drawn out" rather than a new
// invented structure), edges = the literal `from`/`to` pairs
// `workspace_get_graph` returns, drawn as SVG paths between each node's
// column/row position. Node boxes are plain HTML buttons absolutely
// positioned over the SVG (real click targets, real tab order) — the SVG
// itself only draws edges, using inline `var(--…)` tokens per the "no new
// CSS" rule's stated exception for this component.
//
// Honest gap: `workspace_get_graph` only returns publishing_conductor's
// 23-node graph today (HANDOFF's own note, confirmed against server/) —
// clone_conductor and capture_conductor are not represented there. Rather
// than call the verb anyway and either render nothing (reads as "empty
// workflow") or a stale/partial shape, this component checks the active
// workflow *before* querying and shows a plain explanation instead for
// anything other than publishing_conductor.

import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRun, useWorkflows } from '../api/hooks';
import { workspaceGetGraph } from '../api/verbs';
import { nodeRunStatus, orderedNodes, type NodeRunStatus } from '../screens/Workbench/helpers';
import { useStore } from '../store';
import type { Run, Workflow } from '../types';

const GRAPH_WORKFLOW_ID = 'publishing_conductor';
const COL_W = 172;
const ROW_H = 48;
const PAD_TOP = 30;
const PAD_X = 14;
const NODE_W = 148;
const NODE_H = 32;

const STATUS_COLOR: Record<NodeRunStatus, string> = {
  completed: 'var(--ok)',
  running: 'var(--run)',
  blocked: 'var(--acc)',
  failed: 'var(--bad)',
  cancelled: 'var(--faint)',
  queued: 'var(--line2)',
};

function edgePath(ax: number, ay: number, bx: number, by: number): string {
  const dx = Math.max(36, (bx - ax) / 2);
  return `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
}

interface Pos {
  x: number;
  y: number;
}

function GapNotice({ workflow, workflowId }: { workflow: Workflow | undefined; workflowId: string }) {
  return (
    <div className="card" style={{ borderColor: 'var(--bad)' }}>
      <span className="lbl" style={{ color: 'var(--bad)' }}>
        graph unavailable — {workflow?.name ?? workflowId}
      </span>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        <code className="mono">workspace_get_graph</code> only returns publishing_conductor's 23-node graph today.{' '}
        {workflow?.name ?? workflowId} isn't represented there yet, so this overlay shows nothing rather than a
        misleading empty or partial diagram. Switch to Publishing conductor (⌘K → "Publishing conductor") to see the
        graph.
      </p>
    </div>
  );
}

function GraphCanvas({
  workflow,
  edges,
  run,
  onSelect,
}: {
  workflow: Workflow;
  edges: Array<{ from: string; to: string }>;
  run: Run | null;
  onSelect: (nodeId: string) => void;
}) {
  const order = useMemo(() => orderedNodes(workflow), [workflow]);

  const positions = useMemo(() => {
    const map = new Map<string, Pos>();
    workflow.phases.forEach(([, ids], colIdx) => {
      ids.forEach((id, rowIdx) => {
        map.set(id, { x: PAD_X + colIdx * COL_W + COL_W / 2, y: PAD_TOP + rowIdx * ROW_H + ROW_H / 2 });
      });
    });
    return map;
  }, [workflow]);

  const maxRows = Math.max(1, ...workflow.phases.map(([, ids]) => ids.length));
  const width = PAD_X * 2 + workflow.phases.length * COL_W;
  const height = PAD_TOP + maxRows * ROW_H + 16;

  return (
    <div style={{ overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)' }}>
      <div style={{ position: 'relative', width, height, minWidth: '100%' }}>
        {workflow.phases.map(([label], colIdx) => (
          <div
            key={label}
            style={{
              position: 'absolute',
              left: PAD_X + colIdx * COL_W,
              top: 4,
              width: COL_W,
              textAlign: 'center',
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--faint)',
            }}
          >
            {label}
          </div>
        ))}
        <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
          {edges.map((e, i) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return null;
            return (
              <path
                key={`${e.from}-${e.to}-${i}`}
                d={edgePath(a.x, a.y, b.x, b.y)}
                fill="none"
                stroke="var(--line2)"
                strokeWidth={1.4}
              />
            );
          })}
        </svg>
        {[...positions.entries()].map(([id, p]) => {
          const status = run ? nodeRunStatus(run, id, order) : null;
          const borderColor = status ? STATUS_COLOR[status] : 'var(--line2)';
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              title={id}
              style={{
                position: 'absolute',
                left: p.x - NODE_W / 2,
                top: p.y - NODE_H / 2,
                width: NODE_W,
                minHeight: NODE_H,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                background: 'var(--panel2)',
                border: `1px solid ${borderColor}`,
                borderRadius: 7,
                color: 'var(--ink)',
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                textAlign: 'left',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  flex: 'none',
                  background: status ? STATUS_COLOR[status] : 'var(--faint)',
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</span>
            </button>
          );
        })}
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
  const isGraphable = wf === GRAPH_WORKFLOW_ID;

  const boundRunQ = useRun(mode === 'run' ? runId : null);
  const run = mode === 'run' ? (boundRunQ.data ?? null) : null;

  const graphQ = useQuery({
    queryKey: ['workspace_get_graph', wf],
    queryFn: () => workspaceGetGraph({ workflowId: wf }),
    enabled: open && isGraphable,
  });

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
        style={{ width: 'min(960px, 94vw)' }}
        onKeyDown={onKeyDown}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <h3 id="graphoverlay-title">Graph overlay — {workflow?.name ?? wf}</h3>
          <button className="btn" ref={closeRef} onClick={closeOverlay}>
            ✕ close
          </button>
        </div>
        <div className="sub">
          Read-only rendering of workspace_get_graph, grouped by phase. An overlay, not a screen — click a node to
          jump to it.
        </div>

        {!isGraphable ? (
          <GapNotice workflow={workflow} workflowId={wf} />
        ) : graphQ.isLoading || workflowsQ.isLoading ? (
          <p className="note">loading graph…</p>
        ) : graphQ.isError || !workflow ? (
          <p className="note" style={{ color: 'var(--bad)' }}>
            {graphQ.error instanceof Error ? graphQ.error.message : 'Could not load the graph.'}
          </p>
        ) : (
          <GraphCanvas workflow={workflow} edges={graphQ.data?.edges ?? []} run={run} onSelect={selectNode} />
        )}
      </div>
    </div>
  );
}
