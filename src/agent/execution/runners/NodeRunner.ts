import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { NodeRunnerContext, ExecutionMode } from "../executionContext.js";
export type NodeRunnerInput = { node: WorkspaceNode; input: unknown };
export type NodeRunnerResult = { ok: true; output: unknown; usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; reasoningTokens?: number; actual: boolean }; trace?: unknown } | { ok: false; code: string; message: string; retryable?: boolean; details?: unknown };
export interface NodeRunner { run(input: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult>; validateConfiguration(node: WorkspaceNode): { ok: true } | { ok: false; errors: string[] }; supports(mode: ExecutionMode): boolean; }
