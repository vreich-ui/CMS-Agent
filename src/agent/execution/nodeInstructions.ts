import { repositoryManager } from "../runtime/repositories.js";
import { resolveSkillsForNode } from "../skills/skillResolver.js";
import type { SkillRepository } from "../repository/interfaces/SkillRepository.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";

// Inspection and both provider runners use this same core. Keep provider-specific output protocol,
// run context and playbook wrappers outside it; never bake skills into the stored node prompt.
export async function resolveNodeInstructions(
  node: WorkspaceNode,
  repository: SkillRepository = repositoryManager.getSkillRepository(),
  // C2 — the run's pinned selection for this node, when the caller is dispatching inside a run.
  // Omitted by inspection paths, which then resolve the live assignment as a current preview.
  selection?: { skillIds: string[]; versions?: Record<string, string> }
) {
  const policy = await resolveSkillsForNode(node, repository, selection
    ? { pinnedSkillIds: selection.skillIds, ...(selection.versions ? { pinnedVersions: selection.versions } : {}) }
    : {});
  return {
    prompt: policy.instructions,
    nodePrompt: node.prompt,
    skillInstructions: policy.instructions.slice(`Node prompt:\n${node.prompt}`.length).replace(/^\n\n---\n\n/, ""),
    conflicts: policy.conflicts,
    errors: policy.conflicts.filter((conflict) => conflict.severity === "blocker").map((conflict) => conflict.message)
  };
}
