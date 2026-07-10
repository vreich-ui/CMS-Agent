import type { WorkspaceNode, WorkspaceRiskLevel } from "../workspace/nodeTypes.js";
import type { SkillRepository } from "../repository/interfaces/SkillRepository.js";
import type { SkillConflict, SkillDefinition, SkillResolvedPolicy } from "./skillTypes.js";

const riskRank: Record<WorkspaceRiskLevel, number> = { read: 0, write: 1, publish: 2, admin: 3 };
const intersect = (...sets: string[][]) => sets.reduce((acc, set) => acc.filter((item) => set.includes(item)));
const unique = <T>(values: T[]) => [...new Set(values)];
const schemaText = (schema: unknown) => JSON.stringify(schema ?? null);
const incompatible = (a: unknown, b: unknown) => schemaText(a) !== schemaText(b) && schemaText(a) !== schemaText({ type: "object" }) && schemaText(b) !== schemaText({ type: "object" });

export type ResolveSkillOptions = { workspaceSystemPolicy?: string; projectPolicy?: string; runInstructions?: string; platformTools?: string[]; runAuthorizedTools?: string[]; riskPolicy?: WorkspaceRiskLevel };

export async function resolveSkillsForNode(node: WorkspaceNode, repository: SkillRepository, options: ResolveSkillOptions = {}): Promise<SkillResolvedPolicy> {
  const skillIds = node.assignedSkills ?? [];
  const skills = (await Promise.all(skillIds.map((id) => repository.get(id)))).filter((skill): skill is SkillDefinition => Boolean(skill));
  const conflicts: SkillConflict[] = [];
  for (const id of skillIds) if (!skills.some((skill) => skill.skillId === id)) conflicts.push({ severity: "blocker", source: id, message: `Assigned skill not found: ${id}` });
  for (const skill of skills) if (skill.status !== "active") conflicts.push({ severity: "warning", source: skill.skillId, message: `Skill is ${skill.status}.` });
  for (const skill of skills) if (incompatible(node.outputSchema, skill.outputSchema)) conflicts.push({ severity: "blocker", source: skill.skillId, message: "Skill output schema is incompatible with the node output schema." });
  const requestedTools = unique(skills.flatMap((skill) => skill.allowedTools));
  const platformTools = options.platformTools ?? requestedTools;
  const runAuthorizedTools = options.runAuthorizedTools ?? requestedTools;
  const allowedByRisk = (tool: string) => !tool.startsWith("publish.") || riskRank[options.riskPolicy ?? node.riskLevel] >= riskRank.publish;
  const effectiveTools = intersect(platformTools, node.allowedTools, requestedTools, runAuthorizedTools).filter(allowedByRisk).sort();
  const deniedTools = requestedTools.filter((tool) => !effectiveTools.includes(tool)).sort();
  for (const tool of deniedTools) conflicts.push({ severity: "warning", source: "tool_policy", message: `Tool not granted by effective policy: ${tool}` });
  const maxRisk = skills.reduce<WorkspaceRiskLevel>((risk, skill) => riskRank[skill.riskLevel] > riskRank[risk] ? skill.riskLevel : risk, node.riskLevel);
  return {
    nodeId: node.id, skillIds, inputSchema: node.inputSchema, outputSchema: node.outputSchema, effectiveTools, requestedTools, deniedTools, riskLevel: maxRisk, conflicts,
    instructions: [options.workspaceSystemPolicy, `Node prompt:\n${node.prompt}`, ...skills.map((skill) => `Skill ${skill.skillId} v${skill.version}:\n${skill.instructions}`), options.projectPolicy, options.runInstructions].filter(Boolean).join("\n\n---\n\n"),
    memoryPolicies: skills.map((skill) => skill.memoryPolicy), requiredArtifacts: unique(skills.flatMap((skill) => skill.requiredArtifacts)), producedArtifacts: unique(skills.flatMap((skill) => skill.producedArtifacts))
  };
}
