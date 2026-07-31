// R-18 — "paused" exists because "blocked" had come to mean three unrelated things: a publish-approval
// hold (approvalsRequired populated), a budget hold (budgetBlock populated), and an operator pressing
// pause (neither populated). An operator-paused run was therefore only distinguishable from a
// publish-held one by the ABSENCE of both markers, which is not a signal anyone should have to read.
// workflow.pause_run now reports "paused"; resume_run returns the run to "queued" as before.
export const executionStatuses = ["queued", "running", "paused", "completed", "failed", "blocked", "cancelled"] as const;
export type ExecutionStatus = typeof executionStatuses[number];

// Per-call audit stub for the controlled-tool calls a node execution made. ToolExecutor's full audit
// records live in process memory and die with the serverless invocation (why tool.list_executions
// returned [] for every past conductor run); these stubs are persisted with the node state so a run's
// tool activity is diagnosable after the fact — metadata only, never payloads.
export type NodeToolCallRecord = { toolId: string; toolExecutionId?: string; status: "success" | "denied" | "error"; errorCode?: string; durationMs?: number };

// Stamped by the executor's claim-save at the moment a node is handed to a runner, BEFORE the model
// loop starts. This is the run record's heartbeat: while a node is genuinely in flight the persisted
// record shows it "running" with this marker, and once now() has passed dispatchedAt + timeoutMs +
// margin the driver provably died mid-node (the runner's own timeout would have finished it first) —
// which is how an operator tells "stalled" from "working" instead of watching status:"running"
// forever. A stale dispatch is reclaimed to queued on the next advance, so the run stays resumable.
export type NodeDispatchClaim = { dispatchedAt: string; timeoutMs: number };

export type NodeExecutionState = {
  nodeId: string;
  status: ExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  errors?: string[];
  warnings?: string[];
  produces?: string[];
  toolCalls?: NodeToolCallRecord[];
  dispatch?: NodeDispatchClaim;
};

// R-18 — `pending` distinguishes the two moments a publish gate is knowable:
//   pending === true  — LOOK-AHEAD. The previous node just finished and the next dependency-ready node
//                       is publish-risk. Nothing has been attempted, no publication_decision.v1 has
//                       been emitted, and the run still reports status "running". Before this existed,
//                       approvalsRequired was [] here, so a run parked one step before the publish gate
//                       was indistinguishable from a run still working — invisible to the UI and to an
//                       operator, which is exactly what R-18 recorded.
//   pending absent    — ATTEMPTED. Someone called an advance on the publish-risk node without approval;
//                       the gate refused, the run is "blocked", and the node carries its
//                       publication_decision.v1 "blocked" output as the audit record.
// A look-ahead entry is replaced (not duplicated) by the attempted entry for the same node.
export type ApprovalRequired = {
  nodeId: string;
  type: "approval_required";
  reason: string;
  requestedAt: string;
  pending?: boolean;
};

// Set when the conductor halts a run because its configured per-run cost ceiling (budgetUsd) has
// been reached. The run enters status "blocked" (the nearest existing blocked state) WITHOUT the
// pending node being started — it stays queued and is never partially charged — so raising the
// ceiling and resuming continues exactly where it paused. Distinct from an approval block: no
// ApprovalRequired entry is minted, and this marker is what tells a caller/dashboard the pause is
// "for budget" rather than "for approval".
export type RunBudgetBlock = {
  blockedAt: string;
  budgetUsd: number;
  spentUsdEstimate: number;
  // The dependency-ready node that would have run next (and would have crossed the ceiling).
  nextNodeId?: string;
  reason: string;
};

export type ExecutionArtifact = {
  id: string;
  nodeId: string;
  type: string;
  value: unknown;
  createdAt: string;
};

// A late-stage entrypoint: a node whose output is supplied up front so the run enters directly at
// that node's downstream successors. The entrypoint node and all its ancestors start seeded as
// completed (never re-run), while the nodes after it run normally. Persisted on the run so reset
// rebuilds the same seeded starting state instead of a full run.
export type WorkflowEntrypoint = {
  nodeId: string;
  output: unknown;
};

export type WorkflowExecutionRecord = {
  runId: string;
  workflowId: string;
  projectId: string;
  status: ExecutionStatus;
  currentNodeId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  nodes: NodeExecutionState[];
  artifacts: ExecutionArtifact[];
  errors: string[];
  approvalsRequired: ApprovalRequired[];
  initialInput?: unknown;
  stageOutputs: Record<string, unknown>;
  dryRun: true;
  executionMode?: "mock" | "openai";
  // Monotonic revision used for optimistic concurrency control. A read carries the stored `rev`;
  // a save only succeeds when the stored `rev` still matches, then increments it. This makes the
  // read-mutate-write cycle for a run atomic so overlapping calls can never re-run a completed node
  // or regress `currentNodeId`. Absent (undefined) is treated as 0 for records written before this
  // field existed.
  rev?: number;
  // Set when the run started from a late-stage entrypoint (a supplied node output). Retained so a
  // reset rebuilds the identical seeded starting state rather than a full ideation-to-publish run.
  entrypoint?: WorkflowEntrypoint;
  // Optional per-run cost ceiling in USD. Default OFF: undefined means no gate and behavior is
  // unchanged. When set, the conductor halts the run before dispatching any node once the run's
  // accrued (actual+estimated) model cost reaches this ceiling. Persisted on the run so a reset
  // rebuilds the same ceiling.
  budgetUsd?: number;
  // Present only while the run is paused for budget (see RunBudgetBlock). Cleared the moment the
  // run advances past the budget check (e.g. after the ceiling is raised and the run resumes).
  budgetBlock?: RunBudgetBlock;
};
