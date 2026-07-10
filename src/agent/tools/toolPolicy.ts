import type { WorkspaceRiskLevel, WorkspaceNode } from "../workspace/nodeTypes.js";
import type { SkillDefinition } from "../skills/skillTypes.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import type { ToolDefinition, ToolExecutionContext, ToolPolicyResult } from "./toolTypes.js";

const riskRank: Record<WorkspaceRiskLevel, number> = { read: 1, write: 2, publish: 3, admin: 4 };
const includes = (list: string[] | undefined, toolId: string) => !list || list.length === 0 || list.includes(toolId);

export function evaluateToolPolicy(input: { tool: ToolDefinition; context: ToolExecutionContext; node?: WorkspaceNode; skill?: SkillDefinition; project?: ProjectConnectionConfig }): ToolPolicyResult {
  const { tool, context, node, skill, project } = input;
  const reasons: string[] = [];
  if (!tool.enabled) reasons.push("tool_disabled");
  if (node && !node.allowedTools.includes(tool.toolId)) reasons.push("node_tool_not_allowed");
  if (skill && !skill.allowedTools.includes(tool.toolId)) reasons.push("skill_tool_not_allowed");
  if (!includes(context.platformAllowedTools, tool.toolId)) reasons.push("platform_tool_not_allowed");
  if (!includes(context.runAuthorizedTools, tool.toolId)) reasons.push("run_tool_not_authorized");
  const maxRisk = context.maxRiskLevel ?? node?.riskLevel ?? "read";
  if (riskRank[tool.riskLevel] > riskRank[maxRisk]) reasons.push("risk_level_exceeds_authorization");
  const approvalStatus = tool.requiresApproval ? (context.approvedToolIds?.includes(tool.toolId) ? "approved" : "missing") : "not_required";
  if (approvalStatus === "missing") reasons.push("approval_required");
  if (tool.category === "project_mcp" && tool.toolId === "project.call_tool" && project && !project.allowedTools.length) reasons.push("project_has_no_allowed_tools");
  return reasons.length ? { allowed: false, code: "tool_denied", reasons } : { allowed: true, approvalStatus };
}
