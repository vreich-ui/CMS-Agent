import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { WorkspaceNode } from "../../types/workspace";

export type AgentNodeData = {
  name: string;
  kind?: string;
  status?: string;
  riskLevel?: WorkspaceNode["riskLevel"];
  counts: { skills: number; tools: number; dependsOn: number };
};

export type AgentNodeType = Node<AgentNodeData, "agent">;

// Minimal truthful card: identity, status, risk, counts. Deliberately NO prompt text or schema
// details — everything else lives in the summary rail (and the S4 modal). Fixed dimensions come
// from .design-node so cards can never overlap by growing.
export const AgentNodeCard = memo(function AgentNodeCard({ data }: NodeProps<AgentNodeType>) {
  const risk = data.riskLevel ?? "read";
  return <div className="design-node">
    <Handle type="target" position={Position.Left} />
    <strong className="design-node-name">{data.name}</strong>
    <span className="design-node-meta">{data.kind ?? "node"} · {data.status ?? "unknown"}</span>
    <span className={`risk-badge risk-badge--${risk}`}>{risk}</span>
    <span className="design-node-counts">{data.counts.skills} skills · {data.counts.tools} tools · {data.counts.dependsOn} deps</span>
    <Handle type="source" position={Position.Right} />
  </div>;
});
