import { repositoryManager } from "../runtime/repositories.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { SkillDefinition } from "../skills/skillTypes.js";
import { createToolRegistry } from "./toolRegistry.js";
import type { ToolDefinition, ToolExecutionContext } from "./toolTypes.js";
import { evaluateToolPolicy } from "./toolPolicy.js";

export function listTools(): ToolDefinition[] { return createToolRegistry(); }
export function getTool(toolId: string): ToolDefinition | undefined { return listTools().find((t) => t.toolId === toolId || t.name === toolId); }

export async function resolveEffectiveToolsForNode(nodeId: string, context: Partial<ToolExecutionContext> = {}) {
  const node = await repositoryManager.getWorkspaceRepository().getNode(nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  const skills = await repositoryManager.getSkillRepository().list({ skillIds: node.assignedSkills ?? [] });
  const tools = listTools();
  return tools.map((tool) => {
    const skill = skills.find((s) => s.allowedTools.includes(tool.toolId));
    const policy = evaluateToolPolicy({ tool, node, skill, context: { runId: context.runId ?? "effective", nodeId, ...context } });
    return { toolId: tool.toolId, name: tool.name, category: tool.category, riskLevel: tool.riskLevel, allowed: policy.allowed, denialReasons: policy.allowed ? [] : policy.reasons };
  });
}

export async function resolvePolicySubjects(nodeId: string, skillId?: string): Promise<{ node?: WorkspaceNode; skill?: SkillDefinition }> {
  const node = await repositoryManager.getWorkspaceRepository().getNode(nodeId);
  const skill = skillId ? await repositoryManager.getSkillRepository().get(skillId) : undefined;
  return { node, skill };
}
