import { describe, expect, it, vi } from "vitest";
import { resolveConversationSkills } from "../../../src/agent/conversations/conversationSkills.js";
import { ConversationalRunner } from "../../../src/agent/conversations/conversationalRunner.js";
import type { ConversationProvider } from "../../../src/agent/conversations/conversationProviders.js";
import { createCanonicalClientManagerAgent } from "../../../src/agent/conversations/agentDefinitions.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { SkillDefinition } from "../../../src/agent/skills/skillTypes.js";

const skill = (skillId: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition => ({
  skillId, name: skillId, description: "test skill", version: "1.0.0", status: "active",
  instructions: `Instructions for ${skillId}.`,
  inputSchema: { type: "object" }, outputSchema: { type: "object" },
  allowedTools: [], requiredArtifacts: [], producedArtifacts: [],
  examples: [{ name: "ok", input: {}, output: {} }],
  preconditions: [], completionCriteria: [], blockerCriteria: [],
  memoryPolicy: { namespaces: [skillId], read: true, write: false },
  toolPolicy: { requestedTools: [], mutatingToolsRequireApproval: true },
  riskLevel: "read", metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...overrides
});

describe("resolveConversationSkills (F2)", () => {
  it("injects only active assigned skills, exactly once each, in the agent's declared order — inactive and missing are omitted and reported, never thrown", async () => {
    const manager = new RepositoryManager();
    const repo = manager.getSkillRepository();
    await repo.create(skill("skill_a"));
    await repo.create(skill("skill_b", { status: "deprecated" }));
    await repo.create(skill("skill_d"));
    // skill_c is deliberately never created.

    const agent = { ...createCanonicalClientManagerAgent(), skills: ["skill_a", "skill_b", "skill_c", "skill_d", "skill_a"] };
    const resolution = await resolveConversationSkills(agent, repo);

    expect(resolution.applied.map((s) => s.skillId)).toEqual(["skill_a", "skill_d"]);
    expect(resolution.missing).toEqual(["skill_c"]);
    expect(resolution.inactive).toEqual(["skill_b"]);
    expect(resolution.blocks).toHaveLength(2);
    expect(resolution.blocks[0]).toContain("Instructions for skill_a.");
    expect(resolution.blocks[1]).toContain("Instructions for skill_d.");
    // Deduped: skill_a appears exactly once despite being listed twice in the agent's own skills.
    expect(resolution.blocks.filter((block) => block.includes("Instructions for skill_a.")).length).toBe(1);
  });

  it("does not throw when every assigned skill is missing — resolution completes, empty blocks, full missing list", async () => {
    const manager = new RepositoryManager();
    const agent = { ...createCanonicalClientManagerAgent(), skills: ["ghost_one", "ghost_two"] };
    await expect(resolveConversationSkills(agent, manager.getSkillRepository())).resolves.toEqual({
      blocks: [], applied: [], missing: ["ghost_one", "ghost_two"], inactive: []
    });
  });
});

describe("chat-path skill injection cannot widen tool grants (F2)", () => {
  it("an assigned skill's allowedTools never changes the chat turn's exposed tools, even though the skill's instructions do reach the prompt", async () => {
    const manager = new RepositoryManager();
    const repo = manager.getSkillRepository();
    await repo.create(skill("tool_widening_skill", {
      allowedTools: ["object_publish"],
      toolPolicy: { requestedTools: ["object_publish"], mutatingToolsRequireApproval: true }
    }));

    await manager.getWorkspaceRepository().ensureConversationalAgentSeeds();
    await manager.getWorkspaceRepository().updateConversationalAgent(
      "agt_client_manager",
      { skills: ["tool_widening_skill"] },
      { reason: "assign a tool-declaring skill for the test", source: "system", actor: { kind: "system", id: "test" } }
    );
    const agent = (await manager.getWorkspaceRepository().getConversationalAgent("agt_client_manager"))!;

    const provider: ConversationProvider = vi.fn(async () => ({ assistantText: "ok", toolCalls: [], inputTokens: 1, outputTokens: 1, provider: "openai" }));
    const runner = new ConversationalRunner({
      workspaceRepository: manager.getWorkspaceRepository(), projectRepository: manager.getProjectRepository(),
      conversationTurnRepository: manager.getConversationTurnRepository(), usageRepository: manager.getUsageRepository(),
      skillRepository: repo, provider, wait: () => Promise.resolve()
    });
    const callerTools = [{ name: "patch", description: "Propose a governed patch.", input_schema: { type: "object", additionalProperties: false } }];

    await runner.run({
      agent_ref: `agt_client_manager@${agent.rev}`,
      project_id: "platform", conversation_id: "chat_widen", turn_id: "turn_widen",
      actor: { kind: "human", id: "usr_1" }, context: { site_id: "site_platform" },
      messages: [{ role: "user", text: "hi" }], tools: callerTools,
      constraints: { max_tokens: 1000, timeout_ms: 5000 }
    });

    // The provider received exactly the caller's own tool list — the skill's allowedTools/toolPolicy
    // never touched it — while the skill's instructions did reach the system prompt.
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ tools: callerTools }));
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("Instructions for tool_widening_skill.") }));
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("## Assigned skills") }));
  });
});
