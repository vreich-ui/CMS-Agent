import type { ZodTypeAny } from "zod";
import type { WorkspaceRiskLevel } from "../workspace/nodeTypes.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";

// "monetize" added W5 (2026-08-12) for monetize.ev_floor — deterministic EV-floor arithmetic, its
// own category rather than folded into "usage" since it is offer/commercial math, not usage telemetry.
export const toolCategories = ["workspace", "web", "files", "artifacts", "blobs", "learning", "usage", "project_mcp", "publishing", "diagnostics", "monetize"] as const;
export type ToolCategory = typeof toolCategories[number];

// Every reason evaluateToolPolicy can refuse a call for. Declared here rather than left as inline
// string literals in toolPolicy.ts because these codes are USER-FACING: the S4 inspector renders
// them in its "Why" column, so each one needs a plain-language definition in the UI's vocabulary
// registry (ui/src/explain.ts), and a root test asserts the registry covers this list exactly.
// Adding a reason without a definition would put a raw enum in front of an operator again.
export const toolDenialReasons = [
  "tool_disabled",
  "node_tool_not_allowed",
  "skill_tool_not_allowed",
  "platform_tool_not_allowed",
  "run_tool_not_authorized",
  "risk_level_exceeds_authorization",
  "approval_required",
  "project_has_no_allowed_tools"
] as const;
export type ToolDenialReason = typeof toolDenialReasons[number];
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
  // Set by executeTool (toolExecutor.ts) once per call, from the SAME projectId it already fetched
  // for policy evaluation (evaluateToolPolicy's `project` argument). A project.* handler in
  // toolRegistry.ts reuses this instead of re-fetching by the projectId in its own arguments when the
  // two ids match — the common case, since a node's project.call_tool target is its own run's
  // project — falling back to its own fetch only when a caller genuinely names a different project.
  project?: ProjectConnectionConfig;
  // Set by executeTool for every call and aborted when the tool's own Promise.race timeout fires, so
  // a slow external call (project.call_tool against a cold remote MCP server) actually stops running
  // instead of merely having its promise rejected while the underlying fetch continues server-side.
  signal?: AbortSignal;
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
