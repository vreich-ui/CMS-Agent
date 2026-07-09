import { useMemo } from "react";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { ExecutionStatus, WorkspaceNode } from "../types/workspace";
import { orderWorkspaceNodesForDisplay } from "../workspaceOrder";

const promptPreview = (prompt: string) => prompt.length > 96 ? `${prompt.slice(0, 96)}…` : prompt;

type WorkspaceGraphProps = {
  nodes: WorkspaceNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  executionStatusByNodeId?: Map<string, ExecutionStatus>;
};

export function WorkspaceGraph({ nodes, selectedNodeId, onSelectNode, executionStatusByNodeId }: WorkspaceGraphProps) {
  const orderedNodes = useMemo(() => orderWorkspaceNodesForDisplay(nodes), [nodes]);

  const graphNodes: Node[] = useMemo(() => orderedNodes.map((node, index) => ({
    id: node.id,
    position: { x: 80 + (index % 3) * 280, y: 80 + Math.floor(index / 3) * 180 },
    data: { label: <div className="flow-card"><strong>{node.name}</strong><span>{node.id}</span><small>{promptPreview(node.prompt)}</small><em>{node.schema ? "Schema available" : "No schema"}</em></div> },
    className: [node.id === selectedNodeId ? "selected-flow-node" : undefined, executionStatusByNodeId?.get(node.id) ? `flow-node-${executionStatusByNodeId.get(node.id)}` : undefined].filter(Boolean).join(" ")
  })), [executionStatusByNodeId, orderedNodes, selectedNodeId]);

  const edges: Edge[] = useMemo(() => orderedNodes.slice(1).map((node, index) => ({
    id: `${orderedNodes[index].id}-${node.id}`,
    source: orderedNodes[index].id,
    target: node.id
  })), [orderedNodes]);

  return <ReactFlow nodes={graphNodes} edges={edges} onNodeClick={(_, node) => onSelectNode(node.id)} fitView><Background /><MiniMap /><Controls /></ReactFlow>;
}
