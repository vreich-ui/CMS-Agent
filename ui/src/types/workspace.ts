import type { RJSFSchema } from "@rjsf/utils";

export type JsonValue = unknown;

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
  executionMode?: "mock" | "openai";
};

export type WorkspaceNode = {
  id: string;
  name: string;
  kind?: string;
  description?: string;
  prompt: string;
  schema?: RJSFSchema | JsonValue;
  inputSchema?: RJSFSchema | JsonValue;
  outputSchema?: RJSFSchema | JsonValue;
  allowedTools?: string[];
  assignedSkills?: string[];
  requiredInputs?: string[];
  produces?: string[];
  dependsOn?: string[];
  riskLevel?: "read" | "write" | "publish" | "admin";
  status?: "draft" | "active" | "deprecated";
  position?: { x: number; y: number };
  metadata?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  executionConfig?: Record<string, unknown>;
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

// UI mirrors of the S1 relationship model (src/agent/workspace/relationshipTypes.ts). Execution
// edges are never stored — they are derived from node.dependsOn server-side.
export type RelationshipKind = "execution" | "data" | "memory" | "policy" | "evaluation" | "approval";

export type WorkspaceRelationship = {
  id: string;
  kind: RelationshipKind;
  sourceId: string;
  targetId: string;
  direction: "forward" | "bidirectional";
  label?: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  schemaRefs?: string[];
  artifactRefs?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ConstellationStructure = {
  agents: Array<Pick<WorkspaceNode, "id" | "name" | "kind" | "status" | "riskLevel" | "dependsOn" | "position">>;
  relationships: WorkspaceRelationship[];
  derivedExecutionEdges: Array<{ kind: "execution"; sourceId: string; targetId: string; derivedFrom: "dependsOn" }>;
};

// UI mirrors of the S1 immutable change history (src/agent/workspace/changeTypes.ts).
export type WorkspaceActorKind = "human" | "agent" | "system";
export type WorkspaceActor = { kind: WorkspaceActorKind; id?: string; label?: string };
export type WorkspaceChangeSource = "mcp" | "ui" | "system";
export type WorkspaceChangeOperation = "create" | "update" | "delete" | "clone" | "reorder" | "restore" | "import" | "record";
export type WorkspaceChangeTarget = { type: "node" | "graph" | "relationship" | "workspace"; id?: string };

export type WorkspaceChangeEvent = {
  eventId: string;
  type: string;
  operation: WorkspaceChangeOperation;
  target: WorkspaceChangeTarget;
  actor: WorkspaceActor;
  source: WorkspaceChangeSource;
  reason?: string;
  baseRevisionId?: string;
  parentRevisionId?: string;
  resultingRevisionId?: string;
  workspaceVersion: number;
  riskLevel?: string;
  before?: unknown;
  after?: unknown;
  correlation?: { runId?: string; requestId?: string };
  createdAt: string;
};

export type WorkspaceChangePage = { events: WorkspaceChangeEvent[]; nextCursor?: string };

export type RevisionDiff = {
  fromRevisionId: string;
  toRevisionId: string;
  nodes: {
    added: WorkspaceNode[];
    removed: WorkspaceNode[];
    changed: Array<{ nodeId: string; changedFields: string[]; before: WorkspaceNode; after: WorkspaceNode }>;
  };
  relationships: {
    added: WorkspaceRelationship[];
    removed: WorkspaceRelationship[];
    changedIds: string[];
  };
};

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
  backend: "memory" | "json" | "blobs";
  storageHealth: "healthy" | "degraded";
  workspaceVersion: number;
  workspace: RepositoryHealth;
  execution: RepositoryHealth;
  artifact: RepositoryHealth;
  learning: RepositoryHealth;
  usage: RepositoryHealth;
  skill: RepositoryHealth;
};


// Safe, non-secret project connection view returned by project.list / project.get. Only env var
// *names* and configured booleans are exposed — never endpoint values, tokens, or headers.
export type ProjectConnectionState = {
  endpointConfigured: boolean;
  tokenConfigured: boolean;
  mcpEndpointEnvVar: string;
  tokenEnvVar?: string;
};

// Per-tool permission, mirroring Claude Code's allow/ask/deny model.
export type ToolPermission = "allowed" | "needs_approval" | "blocked";

export type ProjectSummary = {
  projectId: string;
  name: string;
  authMode: "none" | "bearer_env";
  allowedTools: string[];
  // Client-wide fallback permission and flattened per-tool overrides. With the remote tool list
  // (project.list_tools) these give every tool's effective permission on the Access page.
  defaultToolPolicy: ToolPermission;
  toolPolicies: Record<string, ToolPermission>;
  contentContract: { contentContract: string; canonicalArticleBody: string };
  publishingPolicy: { publishEnabled: boolean; requiresExplicitPublish: boolean; description: string };
  status: "active" | "disabled";
  connection: ProjectConnectionState;
};

// Result shape of project.list_tools (ProjectMcpAdapter.listTools).
export type ProjectToolsResult = {
  ok: boolean;
  projectId: string;
  connection: ProjectConnectionState;
  tools: Array<{ name: string; description?: string }>;
  allowedTools: string[];
  defaultToolPolicy: ToolPermission;
  toolPolicies: Record<string, ToolPermission>;
  error?: string;
};

export type SkillDefinition = {
  skillId: string; name: string; description: string; version: string; status: "draft" | "active" | "deprecated"; instructions: string; inputSchema: JsonValue; outputSchema: JsonValue; allowedTools: string[]; requiredArtifacts: string[]; producedArtifacts: string[]; examples: Array<{ name: string; input: JsonValue; output: JsonValue; notes?: string }>; preconditions: string[]; completionCriteria: string[]; blockerCriteria: string[]; memoryPolicy: JsonValue; toolPolicy: JsonValue; riskLevel: WorkspaceNode["riskLevel"]; metadata: Record<string, unknown>; createdAt: string; updatedAt: string;
};
export type SkillResolvedPolicy = { nodeId: string; skillIds: string[]; instructions: string; effectiveTools: string[]; requestedTools: string[]; deniedTools: string[]; conflicts: Array<{ severity: "warning" | "blocker"; source: string; message: string }>; };
