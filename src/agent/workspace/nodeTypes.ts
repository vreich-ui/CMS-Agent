export const workspaceRiskLevels = ["read", "write", "publish", "admin"] as const;
export type WorkspaceRiskLevel = typeof workspaceRiskLevels[number];

export const workspaceNodeStatuses = ["draft", "active", "deprecated"] as const;
export type WorkspaceNodeStatus = typeof workspaceNodeStatuses[number];

export type WorkspaceNodePosition = { x: number; y: number };

export type WorkspaceNode = {
  id: string;
  name: string;
  kind: string;
  description: string;
  prompt: string;
  /** @deprecated outputSchema is canonical. schema remains as a legacy import/export alias and is migrated to outputSchema on load/mutation. */
  schema?: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  allowedTools: string[];
  assignedSkills?: string[];
  requiredInputs: string[];
  produces: string[];
  riskLevel: WorkspaceRiskLevel;
  dependsOn: string[];
  status: WorkspaceNodeStatus;
  position: WorkspaceNodePosition;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  executionConfig?: Record<string, unknown>;
};

export type WorkspaceEvent = { id: string; type: string; nodeId?: string; actor?: string; summary?: string; workspaceVersion: number; beforeHash?: string; afterHash?: string; createdAt: string };
export type WorkspaceVersionSnapshot = { workspaceVersion: number; createdAt: string; summary?: string; nodes: WorkspaceNode[] };

export type WorkspaceGraphValidation = { valid: true; issues: [] } | { valid: false; issues: string[] };
