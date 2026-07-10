import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
export type ExecutionMode = "mock" | "openai";
export type ExecutionErrorCode = "invalid_node_configuration" | "missing_input" | "output_validation_failed" | "tool_denied" | "tool_failed" | "model_timeout" | "model_error" | "budget_exceeded" | "approval_required" | "cancelled" | "stale_workspace_version";
export type NodeRunnerContext = { run: WorkflowExecutionRecord; executionRepository: ExecutionRepository; workspaceRepository?: WorkspaceRepository; signal?: AbortSignal; approvedToolIds?: string[]; suppliedDependencies?: Record<string, unknown>; };
