import type { ProjectProfile } from "./types.js";
import { buildMcpServers } from "../mcp/buildMcpServers.js";
import { getAllowedSkills } from "../skills/registry.js";

export function createAgent(project: ProjectProfile) {
  return {
    model: process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5",
    instructions: [
      `You are the reusable content agent for ${project.displayName}.`,
      `Brand voice: ${project.brandVoice}`,
      `Audience: ${project.audience}`,
      `Editorial rules:\n- ${project.editorialRules.join("\n- ")}`,
      "Publishing actions must remain dry-run unless dryRun is explicitly false."
    ].join("\n\n"),
    skills: getAllowedSkills(project),
    mcpServers: buildMcpServers(project)
  };
}
