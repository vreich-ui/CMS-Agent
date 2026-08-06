import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";

export type ExecutionMode = "mock" | "openai";
export type ExecutionErrorCode = "invalid_node_configuration" | "missing_input" | "output_validation_failed" | "tool_denied" | "tool_failed" | "model_timeout" | "model_error" | "budget_exceeded" | "approval_required" | "cancelled" | "stale_workspace_version";

export type NodeRunnerContext = {
  run: WorkflowExecutionRecord;
  executionRepository: ExecutionRepository;
  workspaceRepository?: WorkspaceRepository;
  signal?: AbortSignal;
  approvedToolIds?: string[];
  suppliedDependencies?: Record<string, unknown>;
  // Perf (mcp-client-abort-timeouts-memoization): set by executor.ts's advanceRun immediately after it
  // computes summarizeModelUsage({runId}) for its own run-level budget gate (only when run.budgetUsd is
  // configured), so OpenAINodeRunner's own per-node budget guard can reuse that SAME figure instead of
  // re-querying (and re-downloading/re-summing) the identical usage records a second time for the same
  // dispatch. Left undefined by any caller that never computed it (e.g. nodeRuntime.ts's executeNode,
  // the single-node path), in which case the runner falls back to querying it itself exactly as before.
  priorRunSpendUsd?: number;
};
