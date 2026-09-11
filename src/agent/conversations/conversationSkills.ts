import type { SkillRepository } from "../repository/interfaces/SkillRepository.js";
import { formatSkillInstructionBlock } from "../skills/skillResolver.js";
import type { ConversationalAgentDefinition } from "./agentDefinitions.js";

export type ConversationSkillResolution = {
  blocks: string[];
  applied: { skillId: string; version: string }[];
  missing: string[];
  inactive: string[];
};

// F2 — the chat-path counterpart to skillResolver.resolveSkillsForNode, deliberately narrower:
//
//   - A missing or inactive assigned skill is OMITTED and reported, never a blocker that fails the
//     turn. Chat is the operator's lifeline: unlike a node dispatch (which legitimately refuses on
//     exactly this condition, via resolveSkillsForNode's blocker), a chat turn must still complete.
//
//   - `allowedTools`/`toolPolicy` on an assigned skill is NEVER read here, and
//     evaluateToolsForNode is NEVER called: authored skill instructions must not widen what tools a
//     chat turn is offered. Only the node path (resolveSkillsForNode) may translate a skill's
//     allowedTools into an actual grant; the chat path's tool list comes from the caller alone.
//
//   - formatSkillInstructionBlock is shared with the node resolver (skillResolver.ts) so the same
//     skill's text and version can never render differently between the node and chat surfaces.
export async function resolveConversationSkills(
  agent: ConversationalAgentDefinition,
  repository: SkillRepository
): Promise<ConversationSkillResolution> {
  const skillIds = [...new Set(agent.skills ?? [])];
  // One repository read per resolution, same discipline as resolveSkillsForNode.
  const available = skillIds.length ? await repository.list({ skillIds }) : [];
  const byId = new Map(available.map((skill) => [skill.skillId, skill]));
  const missing: string[] = [];
  const inactive: string[] = [];
  const blocks: string[] = [];
  const applied: { skillId: string; version: string }[] = [];

  // Iterate in the agent's own declared order, not the repository's return order, so injection
  // order is deterministic and matches what the agent definition actually states.
  for (const skillId of skillIds) {
    const skill = byId.get(skillId);
    if (!skill) { missing.push(skillId); continue; }
    if (skill.status !== "active") { inactive.push(skillId); continue; }
    blocks.push(formatSkillInstructionBlock(skill));
    applied.push({ skillId: skill.skillId, version: skill.version });
  }

  return { blocks, applied, missing, inactive };
}
