import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { NodeRunnerContext, ExecutionMode } from "../executionContext.js";
import type { NodeToolCallRecord } from "../../workspace/executionTypes.js";
export type NodeRunnerInput = { node: WorkspaceNode; input: unknown };
// Persisted with the node's execution state by the executor (see executionTypes.NodeToolCallRecord).
export type { NodeToolCallRecord };
export type NodeRunnerResult = {
  ok: true;
  output: unknown;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; reasoningTokens?: number; actual: boolean };
  trace?: unknown;
  toolCalls?: NodeToolCallRecord[];
  // R-16's generic executor-level output-schema gate (executor.ts's executeRunnableNode) and a
  // runner's OWN pre-return validation (OpenAINodeRunner.ts, AnthropicNodeRunner.ts — both validate
  // to decide whether to retry on a malformed response) used to run validateOutput against the exact
  // same (output, schema) pair twice on every successful dispatch. A runner that already validated
  // `output` against `node.outputSchema` before returning sets this true so the executor can skip its
  // own redundant re-validation; omitted (or false) it defaults to the executor validating, which is
  // what keeps a runner that does NOT self-validate (MockNodeRunner, or any test double standing in
  // for a runner) honest — see outputSchemaEnforcement.test.ts's "the executor enforces the schema"
  // case, which deliberately uses such a stand-in and must keep failing a schema-violating output.
  outputValidated?: boolean;
} | { ok: false; code: string; message: string; retryable?: boolean; details?: unknown; toolCalls?: NodeToolCallRecord[] };
export interface NodeRunner { run(input: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult>; validateConfiguration(node: WorkspaceNode): { ok: true } | { ok: false; errors: string[] }; supports(mode: ExecutionMode): boolean; }
