import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { resolveConversationSkills } from "../../../src/agent/conversations/conversationSkills.js";
import { createCanonicalClientManagerAgent } from "../../../src/agent/conversations/agentDefinitions.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

// F2/F3 — the version reported for one skill must be IDENTICAL across the chat prompt block
// (resolveConversationSkills), node.get_effective_skills, and workspace.get_node_effective_config's
// effectiveSkills — all three resolve through the same skill repository read of the same row, so a
// version reported on one surface can never disagree with what another surface (or an actual node
// dispatch / chat turn) would apply.
describe("cross-surface skill version parity", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("reports the identical version for the same skill in the chat prompt block, node.get_effective_skills, and workspace.get_node_effective_config", async () => {
    const created = await call("skill.create", { skill: { skillId: "parity_test_skill", name: "Parity", description: "x", instructions: "Follow the parity protocol.", version: "3.4.5" } });
    expect(created.result.structuredContent.ok).toBe(true);
    await call("workspace.create_node", { node: { id: "parity_test_node", name: "Parity Node", prompt: "Do work.", assignedSkills: ["parity_test_skill"] } });

    const nodePolicy = (await data("node.get_effective_skills", { nodeId: "parity_test_node" })).policy;
    const nodeVersionMatch = /Skill parity_test_skill v([^:]+):/.exec(nodePolicy.instructions);
    expect(nodeVersionMatch?.[1]).toBe("3.4.5");

    const config = (await data("workspace.get_node_effective_config", { id: "parity_test_node" })).config;
    expect(config.effectiveSkills).toContainEqual({ skillId: "parity_test_skill", version: "3.4.5", status: "active" });

    const agent = { ...createCanonicalClientManagerAgent(), skills: ["parity_test_skill"] };
    const resolution = await resolveConversationSkills(agent, repositoryManager.getSkillRepository());
    expect(resolution.applied).toEqual([{ skillId: "parity_test_skill", version: "3.4.5" }]);
    expect(resolution.blocks[0]).toContain("Skill parity_test_skill v3.4.5:");
  });
});
