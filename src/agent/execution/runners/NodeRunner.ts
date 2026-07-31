import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { NodeRunnerContext, ExecutionMode } from "../executionContext.js";
import type { NodeToolCallRecord } from "../../workspace/executionTypes.js";
export type NodeRunnerInput = { node: WorkspaceNode; input: unknown };
// Persisted with the node's execution state by the executor (see executionTypes.NodeToolCallRecord).
export type { NodeToolCallRecord };
export type NodeRunnerResult = { ok: true; output: unknown; usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; reasoningTokens?: number; actual: boolean }; trace?: unknown; toolCalls?: NodeToolCallRecord[] } | { ok: false; code: string; message: string; retryable?: boolean; details?: unknown; toolCalls?: NodeToolCallRecord[] };
export interface NodeRunner { run(input: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult>; validateConfiguration(node: WorkspaceNode): { ok: true } | { ok: false; errors: string[] }; supports(mode: ExecutionMode): boolean; }
