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
  schema?: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  allowedTools: string[];
  requiredInputs: string[];
  produces: string[];
  riskLevel: WorkspaceRiskLevel;
  dependsOn: string[];
  status: WorkspaceNodeStatus;
  position: WorkspaceNodePosition;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type WorkspaceGraphValidation = { valid: true; issues: [] } | { valid: false; issues: string[] };
