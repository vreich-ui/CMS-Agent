// Deterministic fixtures for constellation metrics tests: fixed ids and timestamps, no clocks,
// no randomness. Three system shapes — empty, partial, populated — shared across tests.

import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceRelationship } from "../../../src/agent/workspace/relationshipTypes.js";
import type { ModelUsageRecord } from "../../../src/agent/observability/modelUsageTypes.js";
import type { ToolExecutionRecord } from "../../../src/agent/tools/toolTypes.js";
import type { ConstellationInputs } from "../../../src/agent/observability/constellationMetrics.js";

const T0 = "2026-07-01T10:00:00.000Z";
const T1 = "2026-07-01T10:00:01.000Z";
const T2 = "2026-07-01T10:00:03.000Z";

export const fixtureNode = (id: string, dependsOn: string[] = [], overrides: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id,
  name: id,
  kind: "workspace",
  description: "",
  prompt: `${id} prompt`,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  allowedTools: [],
  assignedSkills: [],
  requiredInputs: [],
  produces: [],
  riskLevel: "read",
  dependsOn,
  status: "active",
  position: { x: 0, y: 0 },
  updatedAt: T0,
  ...overrides
});

// Three-agent chain: alpha -> beta -> gamma.
export const fixtureNodes = (): WorkspaceNode[] => [
  fixtureNode("alpha"),
  fixtureNode("beta", ["alpha"]),
  fixtureNode("gamma", ["beta"], { riskLevel: "publish" })
];

export const fixtureUsage = (overrides: Partial<ModelUsageRecord> & { usageId: string }): ModelUsageRecord => ({
  runId: "run_ok",
  model: "gpt-5.5",
  provider: "openai",
  inputTokens: 1000,
  outputTokens: 500,
  totalTokens: 1500,
  costUsdEstimate: 0.02,
  currency: "USD",
  status: "estimated",
  recordedAt: T1,
  ...overrides
});

// Blocked nodes never started: the executor blocks publish-risk nodes before invoking a runner.
const nodeState = (nodeId: string, status: "queued" | "completed" | "failed" | "blocked", durationMs?: number) => ({
  nodeId,
  status,
  ...(status === "completed" || status === "failed" ? { startedAt: T1, completedAt: T2, durationMs: durationMs ?? 2000 } : {})
});

export const fixtureRuns = (): WorkflowExecutionRecord[] => [
  // Fully successful run: alpha(1s) -> beta(2s) -> gamma(3s); payloads flow via stageOutputs.
  {
    runId: "run_ok",
    workflowId: "wf",
    projectId: "project-a",
    status: "completed",
    startedAt: T0,
    updatedAt: T2,
    completedAt: T2,
    nodes: [nodeState("alpha", "completed", 1000), nodeState("beta", "completed", 2000), nodeState("gamma", "completed", 3000)] as WorkflowExecutionRecord["nodes"],
    artifacts: [],
    errors: [],
    approvalsRequired: [],
    stageOutputs: { alpha: { text: "0123456789" }, beta: { text: "01234" } },
    dryRun: true,
    executionMode: "mock"
  },
  // beta failed output validation twice (one retry), then the run failed.
  {
    runId: "run_failed",
    workflowId: "wf",
    projectId: "project-a",
    status: "failed",
    startedAt: T0,
    updatedAt: T2,
    nodes: [nodeState("alpha", "completed", 1000), nodeState("beta", "failed", 500)] as WorkflowExecutionRecord["nodes"],
    artifacts: [],
    errors: ["beta:output_validation_failed", "beta:output_validation_failed"],
    approvalsRequired: [],
    stageOutputs: { alpha: { text: "0123456789" } },
    dryRun: true,
    executionMode: "mock"
  },
  // Blocked before publish-risk gamma.
  {
    runId: "run_blocked",
    workflowId: "wf",
    projectId: "project-a",
    status: "blocked",
    startedAt: T0,
    updatedAt: T2,
    nodes: [nodeState("alpha", "completed", 1000), nodeState("beta", "completed", 2000), nodeState("gamma", "blocked")] as WorkflowExecutionRecord["nodes"],
    artifacts: [],
    errors: [],
    approvalsRequired: [{ nodeId: "gamma", type: "approval_required", reason: "Publish requires explicit approval.", requestedAt: T1 }],
    stageOutputs: { alpha: { text: "0123456789" }, beta: { text: "01234" } },
    dryRun: true,
    executionMode: "mock"
  },
  // Independent single-node execution of alpha.
  {
    runId: "run_independent",
    workflowId: "independent_node",
    projectId: "workspace",
    status: "completed",
    startedAt: T0,
    updatedAt: T2,
    completedAt: T2,
    nodes: [nodeState("alpha", "completed", 4000)] as WorkflowExecutionRecord["nodes"],
    artifacts: [],
    errors: [],
    approvalsRequired: [],
    stageOutputs: {},
    dryRun: true,
    executionMode: "mock"
  }
];

export const fixtureRelationships = (): WorkspaceRelationship[] => [
  { id: "rel_data", kind: "data", sourceId: "alpha", targetId: "beta", direction: "forward", enabled: true, createdAt: T0, updatedAt: T0 },
  { id: "rel_disabled", kind: "memory", sourceId: "beta", targetId: "gamma", direction: "forward", enabled: false, createdAt: T0, updatedAt: T0 },
  { id: "rel_dangling", kind: "policy", sourceId: "alpha", targetId: "ghost", direction: "forward", enabled: true, createdAt: T0, updatedAt: T0 }
];

export const fixtureToolExecutions = (): ToolExecutionRecord[] => [
  { toolExecutionId: "tex_1", runId: "run_ok", nodeId: "beta", toolId: "web.fetch", startedAt: T1, completedAt: T2, durationMs: 10, status: "error", inputSummary: "{}", errorCode: "tool_error", riskLevel: "read", approvalStatus: "not_required" },
  { toolExecutionId: "tex_2", runId: "run_ok", nodeId: "beta", toolId: "web.fetch", startedAt: T1, completedAt: T2, durationMs: 10, status: "success", inputSummary: "{}", riskLevel: "read", approvalStatus: "not_required" }
];

export const emptyInputs = (): ConstellationInputs => ({ nodes: fixtureNodes(), relationships: [], runs: [], usageRecords: [], toolExecutions: [] });

export const partialInputs = (): ConstellationInputs => ({
  nodes: fixtureNodes(),
  relationships: [],
  runs: [],
  usageRecords: [
    fixtureUsage({ usageId: "usage_1", nodeId: "alpha" }),
    fixtureUsage({ usageId: "usage_2", nodeId: "alpha", model: "mystery-model-x", costUsdEstimate: 0.01 }),
    fixtureUsage({ usageId: "usage_3" }) // unattributed: no nodeId
  ],
  toolExecutions: []
});

export const populatedInputs = (): ConstellationInputs => ({
  nodes: fixtureNodes(),
  relationships: fixtureRelationships(),
  runs: fixtureRuns(),
  usageRecords: [
    fixtureUsage({ usageId: "usage_1", nodeId: "alpha" }),
    fixtureUsage({ usageId: "usage_2", nodeId: "alpha", status: "actual", inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsdEstimate: 0.005 }),
    fixtureUsage({ usageId: "usage_3", nodeId: "beta" })
  ],
  toolExecutions: fixtureToolExecutions()
});
