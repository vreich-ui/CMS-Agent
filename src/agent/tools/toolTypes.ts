import type { ZodTypeAny } from "zod";
import type { WorkspaceRiskLevel } from "../workspace/nodeTypes.js";

export const toolCategories = ["workspace", "web", "files", "artifacts", "blobs", "learning", "usage", "project_mcp", "publishing", "diagnostics"] as const;
export type ToolCategory = typeof toolCategories[number];
export type ToolSideEffect = "none" | "workspace_write" | "external_read" | "external_write" | "publish";
export type ToolStatus = "allowed" | "denied" | "error" | "timeout" | "success";

export type ToolExecutionContext = {
  runId: string;
  nodeId: string;
  projectId?: string;
  skillId?: string;
  approvedToolIds?: string[];
  runAuthorizedTools?: string[];
  platformAllowedTools?: string[];
  maxRiskLevel?: WorkspaceRiskLevel;
  dryRun?: boolean;
};

export type ToolDefinition<I = unknown, O = unknown> = {
  toolId: string;
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  riskLevel: WorkspaceRiskLevel;
  sideEffect: ToolSideEffect;
  requiresApproval: boolean;
  timeoutMs: number;
  category: ToolCategory;
  enabled: boolean;
  handler: (input: I, context: ToolExecutionContext) => Promise<O> | O;
  metadata: Record<string, unknown>;
};

export type ToolExecutionRecord = {
  toolExecutionId: string;
  runId: string;
  nodeId: string;
  toolId: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "success" | "denied" | "error" | "timeout";
  inputSummary: unknown;
  outputSummary?: unknown;
  errorCode?: string;
  riskLevel: WorkspaceRiskLevel;
  approvalStatus: "not_required" | "approved" | "missing";
};

export type ToolDenial = { allowed: false; code: string; reasons: string[] };
export type ToolAllowed = { allowed: true; approvalStatus: ToolExecutionRecord["approvalStatus"] };
export type ToolPolicyResult = ToolAllowed | ToolDenial;
