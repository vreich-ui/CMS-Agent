import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Edge,
  type NodeChange
} from "@xyflow/react";
import { AgentNodeCard, type AgentNodeType } from "./AgentNodeCard";
import { buildDesignEdges, buildDesignNodes, type DesignEdgeModel, type DesignLayers } from "../../designGraph";
import type { WorkspaceNode, WorkspaceRelationship } from "../../types/workspace";

const nodeTypes = { agent: AgentNodeCard };

type DesignCanvasProps = {
  nodes: WorkspaceNode[];
  relationships: WorkspaceRelationship[];
  layers: DesignLayers;
  selectedId: string | null;
  selectedEdgeId: string | null;
  saving: boolean;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (edge: DesignEdgeModel | null) => void;
  onMoveNode: (id: string, position: { x: number; y: number }) => void;
  onConnectDependency: (sourceId: string, targetId: string) => void;
  onRequestEdgeDelete: (edge: DesignEdgeModel) => void;
};

const toRfNodes = (nodes: WorkspaceNode[], selectedId: string | null): AgentNodeType[] =>
  buildDesignNodes(nodes).map((model) => ({
    id: model.id,
    type: "agent" as const,
    position: model.position,
    selected: model.id === selectedId,
    data: { name: model.name, kind: model.kind, status: model.status, riskLevel: model.riskLevel, counts: model.counts }
  }));

// The canvas renders MCP truth: stored positions in, position changes out (persisted on drop by
// the container). Edges are always derived — there is no local edge state to drift.
function DesignCanvasInner({ nodes, relationships, layers, selectedId, selectedEdgeId, saving, onSelectNode, onSelectEdge, onMoveNode, onConnectDependency, onRequestEdgeDelete }: DesignCanvasProps) {
  const [rfNodes, setRfNodes] = useState<AgentNodeType[]>(() => toRfNodes(nodes, selectedId));
  const storedPositions = useMemo(() => new Map(nodes.map((node) => [node.id, node.position ?? { x: 0, y: 0 }])), [nodes]);
  // Ref mirror so the debounced keyboard persist always compares against current server truth,
  // never a stale closure capture.
  const storedPositionsRef = useRef(storedPositions);
  useEffect(() => { storedPositionsRef.current = storedPositions; }, [storedPositions]);
  const keyboardMoveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Nodes currently in a pointer drag: their position changes (including the final
  // dragging:false change React Flow emits on drop) must never arm the keyboard debounce —
  // onNodeDragStop is the single persist path for pointer drags.
  const pointerDragging = useRef(new Set<string>());

  // Server state wins: whenever workspace nodes change (save response, reload, conflict reset),
  // the canvas re-derives — unsaved drag deltas are intentionally discarded.
  useEffect(() => {
    setRfNodes(toRfNodes(nodes, selectedId));
  }, [nodes, selectedId]);

  useEffect(() => () => {
    if (keyboardMoveTimer.current) clearTimeout(keyboardMoveTimer.current);
  }, []);

  const persistIfMoved = useCallback((id: string, position: { x: number; y: number }) => {
    const stored = storedPositionsRef.current.get(id);
    const rounded = { x: Math.round(position.x), y: Math.round(position.y) };
    if (!stored || (stored.x === rounded.x && stored.y === rounded.y)) return;
    onMoveNode(id, rounded);
  }, [onMoveNode]);

  const onNodesChange = useCallback((changes: NodeChange<AgentNodeType>[]) => {
    const relevant = changes.filter((change) => change.type === "position" || change.type === "select" || change.type === "dimensions");
    setRfNodes((current) => applyNodeChanges(relevant, current));
    for (const change of changes) {
      if (change.type === "select") onSelectNode(change.selected ? change.id : null);
      // Keyboard arrow-moves arrive as non-dragging position changes with no drag-stop event;
      // debounce-persist them so keyboard layout edits are as real as pointer drags.
      if (change.type === "position" && change.dragging === false && change.position && !pointerDragging.current.has(change.id)) {
        const { id, position } = change;
        if (keyboardMoveTimer.current) clearTimeout(keyboardMoveTimer.current);
        keyboardMoveTimer.current = setTimeout(() => persistIfMoved(id, position), 750);
      }
    }
  }, [onSelectNode, persistIfMoved]);

  const edgeModels = useMemo(() => buildDesignEdges(nodes, relationships, layers), [nodes, relationships, layers]);
  const edgeById = useMemo(() => new Map(edgeModels.map((edge) => [edge.id, edge])), [edgeModels]);
  const rfEdges: Edge[] = useMemo(() => edgeModels.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    selected: edge.id === selectedEdgeId,
    focusable: true,
    className: `design-edge design-edge--${edge.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed }
  })), [edgeModels, selectedEdgeId]);

  const onConnect = useCallback((connection: Connection) => {
    if (saving || !connection.source || !connection.target) return;
    onConnectDependency(connection.source, connection.target);
  }, [onConnectDependency, saving]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      onSelectNode(null);
      onSelectEdge(null);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedEdgeId) {
      const edge = edgeById.get(selectedEdgeId);
      if (edge) {
        event.preventDefault();
        onRequestEdgeDelete(edge);
      }
    }
  }, [edgeById, onRequestEdgeDelete, onSelectEdge, onSelectNode, selectedEdgeId]);

  return <div className="design-canvas" onKeyDown={onKeyDown}>
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={(_, node) => {
        pointerDragging.current.add(node.id);
        if (keyboardMoveTimer.current) clearTimeout(keyboardMoveTimer.current);
      }}
      onNodeDragStop={(_, node) => {
        pointerDragging.current.delete(node.id);
        if (!saving) persistIfMoved(node.id, node.position);
      }}
      onConnect={onConnect}
      onEdgeClick={(_, edge) => onSelectEdge(edgeById.get(edge.id) ?? null)}
      onPaneClick={() => { onSelectNode(null); onSelectEdge(null); }}
      nodesDraggable={!saving}
      nodesConnectable={!saving}
      nodesFocusable
      edgesFocusable
      elementsSelectable
      deleteKeyCode={null}
      minZoom={0.2}
      maxZoom={1.5}
      fitView
    >
      <Background />
      <Controls />
    </ReactFlow>
  </div>;
}

export function DesignCanvas(props: DesignCanvasProps) {
  return <ReactFlowProvider><DesignCanvasInner {...props} /></ReactFlowProvider>;
}
