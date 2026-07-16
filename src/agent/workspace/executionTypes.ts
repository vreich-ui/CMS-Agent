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

export type ExecutionArtifact = {
  id: string;
  nodeId: string;
  type: string;
  value: unknown;
  createdAt: string;
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
};
