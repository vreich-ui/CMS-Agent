import type { WorkspaceNode } from "./types/workspace.js";

const hasPosition = (node: WorkspaceNode): node is WorkspaceNode & { position: { x: number; y: number } } =>
  !!node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y);

// Order workspace nodes for display: top-to-bottom by grid position.y, then left-to-right by
// position.x. The MCP backend already returns nodes in canonical Publishing Conductor order, so this
// is a defensive layer that keeps the graph and node list stable regardless of storage insertion,
// mutation order, or updatedAt. Nodes without a position keep their original relative order.
export function orderWorkspaceNodesForDisplay(nodes: WorkspaceNode[]): WorkspaceNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const aHas = hasPosition(a.node);
      const bHas = hasPosition(b.node);
      if (aHas && bHas) {
        if (a.node.position!.y !== b.node.position!.y) return a.node.position!.y - b.node.position!.y;
        if (a.node.position!.x !== b.node.position!.x) return a.node.position!.x - b.node.position!.x;
      } else if (aHas || bHas) {
        return aHas ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.node);
}
