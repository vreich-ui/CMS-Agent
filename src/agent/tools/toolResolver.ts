import { repositoryManager } from "../runtime/repositories.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { SkillDefinition } from "../skills/skillTypes.js";

import { createToolRegistry } from "./toolRegistry.js";
import type { ToolDefinition, ToolExecutionContext } from "./toolTypes.js";
import { evaluateToolPolicy } from "./toolPolicy.js";

export function listTools(): ToolDefinition[] { return createToolRegistry(); }
export function getTool(toolId: string): ToolDefinition | undefined { return listTools().find((t) => t.toolId === toolId || t.name === toolId); }

export type ResolvedTool = { toolId: string; name: string; category: string; riskLevel: string; allowed: boolean; denialReasons: string[] };

// R-5: THE single authority on whether a node may reach a tool.
//
// There were two answers to that question and they disagreed. skill.resolve_for_node computed
// effective tools as a plain set intersection (platform ∩ node.allowedTools ∩ skill-requested ∩
// run-authorized, minus a "publish."-prefix risk rule), while node.get_effective_tools ran the real
// policy in toolPolicy.ts — which additionally honors tool.enabled, the tool-vs-node risk ladder,
// and requiresApproval. So the two tools reported different verdicts for project.call_tool on
// article_body, contract_intelligence, publish_payload and artifact_plan: the set intersection said
// granted, the policy said approval_required. Both were "the answer" depending on which tool you
// asked, and no third place reconciled them.
//
// This is now the only implementation. It is pure over its inputs so the skill resolver can call it
// with a node it already holds, and resolveEffectiveToolsForNode below is the repository-loading
// wrapper. A denial reason added to toolPolicy.ts therefore reaches BOTH surfaces at once.
export function evaluateToolsForNode(
  node: WorkspaceNode,
  skills: SkillDefinition[],
  context: Partial<ToolExecutionContext> = {},
  tools: ToolDefinition[] = listTools()
): ResolvedTool[] {
  return tools.map((tool) => {
    const skill = skills.find((s) => s.allowedTools.includes(tool.toolId));
    const policy = evaluateToolPolicy({ tool, node, skill, context: { runId: context.runId ?? "effective", nodeId: node.id, ...context } });
    return { toolId: tool.toolId, name: tool.name, category: tool.category, riskLevel: tool.riskLevel, allowed: policy.allowed, denialReasons: policy.allowed ? [] : policy.reasons };
  });
}

// preloadedNode lets a caller that already holds the node (nodeRuntime.ts's executeNode, which loads
// it once itself) skip this function's own getNode round-trip instead of re-fetching the identical
// record. Every existing caller passes only nodeId and is unaffected — it still fetches exactly as
// before.
export async function resolveEffectiveToolsForNode(nodeId: string, context: Partial<ToolExecutionContext> = {}, preloadedNode?: WorkspaceNode): Promise<ResolvedTool[]> {
  const node = preloadedNode ?? await repositoryManager.getWorkspaceRepository().getNode(nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  const skills = await repositoryManager.getSkillRepository().list({ skillIds: node.assignedSkills ?? [] });
  return evaluateToolsForNode(node, skills, context);
}

export async function resolvePolicySubjects(nodeId: string, skillId?: string): Promise<{ node?: WorkspaceNode; skill?: SkillDefinition }> {
  const node = await repositoryManager.getWorkspaceRepository().getNode(nodeId);
  const skill = skillId ? await repositoryManager.getSkillRepository().get(skillId) : undefined;
  return { node, skill };
}
