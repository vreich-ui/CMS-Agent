import type { RJSFSchema } from "@rjsf/utils";

export type JsonValue = unknown;

export type McpConfig = {
  endpoint: string;
  token?: string;
  authToken?: string;
  requiresToken?: boolean;
};

export type ExecutionStatus = "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";

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
};

export type WorkspaceNode = {
  id: string;
  name: string;
  prompt: string;
  schema?: RJSFSchema | JsonValue;
  updatedAt?: string;
};

export type WorkspaceExport = {
  schemaVersion?: number;
  workspaceVersion?: number;
  updatedAt?: string;
  nodes?: WorkspaceNode[];
  stageOutputs?: unknown[];
  learningObservations?: unknown[];
};

export type WorkspaceDocument = WorkspaceExport;
export type ArticleBodySchema = RJSFSchema;

export type ToolEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: unknown;
};

export type ValidationIssue = {
  path?: Array<string | number>;
  message?: string;
  code?: string;
  [key: string]: unknown;
};

export type ArticleValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  articleBody?: unknown;
};

export type ConnectionStatusTone = "idle" | "success" | "error";

export type ConnectionStatus = {
  tone: ConnectionStatusTone;
  serverName?: string;
  protocolVersion?: string;
  error?: string;
};

export type InitializeResult = {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
};

export type ModelUsageBucket = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  costUsdEstimate: number;
  recordCount: number;
};

export type ModelUsageRecord = {
  usageId: string;
  runId?: string;
  workflowId?: string;
  projectId?: string;
  nodeId?: string;
  agentId?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  costUsdEstimate: number;
  currency: "USD";
  status: "estimated" | "actual";
  recordedAt: string;
  metadata?: Record<string, unknown>;
};

export type ModelUsageSummary = ModelUsageBucket & {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCostUsdEstimate: number;
  byModel: Record<string, ModelUsageBucket>;
  byNode: Record<string, ModelUsageBucket>;
  byProject: Record<string, ModelUsageBucket>;
};

export type BudgetStatus = {
  spentUsdEstimate: number;
  remainingUsdEstimate: number;
  budgetUsd: number;
  percentUsed: number;
  status: "ok" | "warning" | "exceeded";
};

export type RepositoryHealth = {
  backend: "memory" | "json" | "blobs";
  writable: boolean;
  readable: boolean;
  version: string;
};

export type RepositoryHealthSummary = {
  workspace: RepositoryHealth;
  execution: RepositoryHealth;
  artifact: RepositoryHealth;
  learning: RepositoryHealth;
  usage: RepositoryHealth;
};
