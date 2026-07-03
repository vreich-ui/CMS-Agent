import { useMemo } from "react";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { WorkspaceNode } from "../types/workspace";

const promptPreview = (prompt: string) => prompt.length > 96 ? `${prompt.slice(0, 96)}…` : prompt;

type WorkspaceGraphProps = {
  nodes: WorkspaceNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
};

export function WorkspaceGraph({ nodes, selectedNodeId, onSelectNode }: WorkspaceGraphProps) {
  const graphNodes: Node[] = useMemo(() => nodes.map((node, index) => ({
    id: node.id,
    position: { x: 80 + (index % 3) * 280, y: 80 + Math.floor(index / 3) * 180 },
    data: { label: <div className="flow-card"><strong>{node.name}</strong><span>{node.id}</span><small>{promptPreview(node.prompt)}</small><em>{node.schema ? "Schema available" : "No schema"}</em></div> },
    className: node.id === selectedNodeId ? "selected-flow-node" : undefined
  })), [nodes, selectedNodeId]);

  const edges: Edge[] = useMemo(() => nodes.slice(1).map((node, index) => ({
    id: `${nodes[index].id}-${node.id}`,
    source: nodes[index].id,
    target: node.id
  })), [nodes]);

  return <ReactFlow nodes={graphNodes} edges={edges} onNodeClick={(_, node) => onSelectNode(node.id)} fitView><Background /><MiniMap /><Controls /></ReactFlow>;
}
