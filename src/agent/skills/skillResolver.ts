import { evaluateToolsForNode } from "../tools/toolResolver.js";
import type { WorkspaceNode, WorkspaceRiskLevel } from "../workspace/nodeTypes.js";
import type { SkillRepository } from "../repository/interfaces/SkillRepository.js";
import { checkSchemaCompatibility } from "./schemaCompatibility.js";
import { seededSkillDefinitions } from "./seededSkills.js";
import type { SkillConflict, SkillDefinition, SkillResolvedPolicy } from "./skillTypes.js";

const riskRank: Record<WorkspaceRiskLevel, number> = { read: 0, write: 1, publish: 2, admin: 3 };
const unique = <T>(values: T[]) => [...new Set(values)];
const SEEDED_SKILL_IDS = new Set(seededSkillDefinitions.map((skill) => skill.skillId));

// Shared by the node resolver (below) and the chat path (conversationSkills.ts) so the two surfaces
// can never render a skill's instructions or version differently.
export const formatSkillInstructionBlock = (skill: SkillDefinition): string => `Skill ${skill.skillId} v${skill.version}:\n${skill.instructions}`;

// F1 — a missing assigned skill has two different remedies depending on WHY it's missing, and the
// blocker message should name the right one instead of just stating the fact:
//   - a CANONICAL seed (part of seededSkillDefinitions, e.g. structure_studio_standards_pack) that
//     is absent from THIS store is a top-up gap: calling a skill read tool (skill_list /
//     skill_resolve_for_node) additively restores it without touching any other row.
//   - anything else is genuinely unknown and has no such remedy: it must be created (skill_create) or
//     the assignment removed (skill_unassign) — there is no seed to top up.
const missingSkillMessage = (skillId: string): string => SEEDED_SKILL_IDS.has(skillId)
  ? `Assigned skill not found: ${skillId} — this is a canonical seed absent from this store; call skill_list or skill_resolve_for_node to additively restore it (operator edits to other skills are never touched).`
  : `Assigned skill not found: ${skillId} — this id is not a canonical seed; create it (skill_create) or unassign it from this node (skill_unassign).`;

export type ResolveSkillOptions = { workspaceSystemPolicy?: string; projectPolicy?: string; runInstructions?: string; platformTools?: string[]; runAuthorizedTools?: string[]; riskPolicy?: WorkspaceRiskLevel };

export async function resolveSkillsForNode(node: WorkspaceNode, repository: SkillRepository, options: ResolveSkillOptions = {}): Promise<SkillResolvedPolicy> {
  const skillIds = unique(node.assignedSkills ?? []);
  // One repository read per resolution. The blob repository loads the skill document on every
  // read; fetching each assigned skill separately multiplies that cost on every model dispatch.
  const available = skillIds.length ? await repository.list({ skillIds }) : [];
  const assigned = skillIds.map((id) => available.find((skill) => skill.skillId === id)).filter((skill): skill is SkillDefinition => Boolean(skill));
  const skills = assigned.filter((skill) => skill.status === "active");
  const conflicts: SkillConflict[] = [];
  for (const id of skillIds) if (!assigned.some((skill) => skill.skillId === id)) conflicts.push({ severity: "blocker", source: id, message: missingSkillMessage(id) });
  for (const skill of assigned) if (skill.status !== "active") conflicts.push({ severity: "warning", source: skill.skillId, message: `Skill is ${skill.status}; its instructions are not applied.` });
  // R-2: a real structural check (see schemaCompatibility.ts), not JSON.stringify equality. Only a
  // genuine contradiction — one no output could satisfy — is a blocker, and the conflict now names
  // which field contradicts instead of asserting that two schemas are not byte-identical.
  for (const skill of skills) {
    const compatibility = checkSchemaCompatibility(node.outputSchema, skill.outputSchema);
    if (!compatibility.compatible) conflicts.push({ severity: "blocker", source: skill.skillId, message: `Skill output schema contradicts the node output schema: ${compatibility.reasons.join(" ")}` });
  }

  const requestedTools = unique(skills.flatMap((skill) => skill.allowedTools));
  // R-5: delegate to the single tool authority (toolResolver.evaluateToolsForNode) rather than
  // re-deriving grants here with a second, weaker rule set. This resolver's job is to say which of
  // the SKILLS' requested tools survive policy; the policy itself lives in one place, so
  // skill.resolve_for_node and node.get_effective_tools can no longer report different verdicts for
  // the same node and tool.
  const decisions = new Map(
    (requestedTools.length ? evaluateToolsForNode(node, skills, {
      platformAllowedTools: options.platformTools,
      runAuthorizedTools: options.runAuthorizedTools,
      ...(options.riskPolicy ? { maxRiskLevel: options.riskPolicy } : {})
    }) : []).map((decision) => [decision.toolId, decision])
  );
  const effectiveTools = requestedTools.filter((tool) => decisions.get(tool)?.allowed).sort();
  const deniedTools = requestedTools.filter((tool) => !effectiveTools.includes(tool)).sort();
  const deniedToolReasons = Object.fromEntries(deniedTools.map((tool) => [tool, decisions.get(tool)?.denialReasons ?? ["tool_not_registered"]]));
  for (const tool of deniedTools) {
    // A tool the registry does not define at all is a different failure from one policy refused, and
    // saying so beats a generic "not granted" that sends the reader looking in the wrong place.
    const reasons = deniedToolReasons[tool];
    conflicts.push({ severity: "warning", source: "tool_policy", message: `Tool not granted by effective policy: ${tool} (${reasons.join(", ")})` });
  }

  const maxRisk = skills.reduce<WorkspaceRiskLevel>((risk, skill) => riskRank[skill.riskLevel] > riskRank[risk] ? skill.riskLevel : risk, node.riskLevel);
  return {
    nodeId: node.id, skillIds, inputSchema: node.inputSchema, outputSchema: node.outputSchema, effectiveTools, requestedTools, deniedTools, deniedToolReasons, riskLevel: maxRisk, conflicts,
    instructions: [options.workspaceSystemPolicy, `Node prompt:\n${node.prompt}`, ...skills.map(formatSkillInstructionBlock), options.projectPolicy, options.runInstructions].filter(Boolean).join("\n\n---\n\n"),
    memoryPolicies: skills.map((skill) => skill.memoryPolicy), requiredArtifacts: unique(skills.flatMap((skill) => skill.requiredArtifacts)), producedArtifacts: unique(skills.flatMap((skill) => skill.producedArtifacts))
  };
}
