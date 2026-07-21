export const executionStatuses = ["queued", "running", "completed", "failed", "blocked", "cancelled"] as const;
export type ExecutionStatus = typeof executionStatuses[number];

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
};

export type ApprovalRequired = {
  nodeId: string;
  type: "approval_required";
  reason: string;
  requestedAt: string;
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
