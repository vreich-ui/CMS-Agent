import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ config: undefined as any, calls: 0 }));
vi.mock("@openai/agents", () => ({
  OpenAIProvider: class { async getModel() { return { async getResponse() { return { usage: {}, output: [] }; }, async *getStreamedResponse() {} }; } },
  Agent: class { constructor(config: unknown) { captures.config = config; } },
  run: async () => { captures.calls++; return { finalOutput: { artifact: "content_source.v1", summary: "CMS-Agent offline fixture." }, rawResponses: [], lastResponseId: "offline" }; },
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class {}
}));

import { executeNode, getEffectivePrompt } from "../../../src/agent/workspace/nodeRuntime.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import { AnthropicNodeRunner } from "../../../src/agent/execution/runners/AnthropicNodeRunner.js";
import { resolveNodeInstructions } from "../../../src/agent/execution/nodeInstructions.js";
import { resolveSkillsForNode } from "../../../src/agent/skills/skillResolver.js";

const base = () => ({ ...listWorkspaceNodes().find(n => n.id === "input_triage")!, assignedSkills: ["editorial_craft"], allowedTools: [] });
const context = () => ({ run: { runId: "offline", workflowId: "publishing_conductor", projectId: "cms-agent-test", stageOutputs: {} } as any, executionRepository: {} as any });
const sentinel = "CMS_AGENT_SKILL_REQUIRE_OFFER_PROOF";

describe("CMS-Agent resolved skill instructions", () => {
  beforeEach(async () => {
    vi.stubEnv("WORKSPACE_STORE", "memory"); vi.stubEnv("OPENAI_API_KEY", "offline-fake-key"); vi.stubEnv("ANTHROPIC_API_KEY", "offline-fake-key");
    resetRepositoryManager(); captures.config = undefined; captures.calls = 0;
    await repositoryManager.getSkillRepository().update("editorial_craft", { instructions: sentinel, status: "active", outputSchema: { type: "object" } });
  });
  afterEach(() => { vi.restoreAllMocks(); resetRepositoryManager(); vi.unstubAllEnvs(); });

  it("independent OpenAI execution sends the same skill core shown in the preview, once", async () => {
    const node = base();
    vi.spyOn(repositoryManager.getWorkspaceRepository(), "getNode").mockResolvedValue(node);
    const preview = await getEffectivePrompt(node.id);
    const result: any = await executeNode({ nodeId: node.id, input: {}, executionMode: "openai" });
    expect(result.execution.status).toBe("completed");
    expect(captures.config.instructions).toContain(preview.prompt);
    expect(captures.config.instructions.split(sentinel)).toHaveLength(2);
    expect(preview.prompt.split(node.prompt)).toHaveLength(2);
    expect(preview.skillInstructions).toContain(sentinel);
    expect(preview.skillInstructions).not.toContain(node.prompt);
  });

  it("provider dispatch sees skill edits on the next call without editing the stored node", async () => {
    const node = base(); const originalPrompt = node.prompt; const runner = new OpenAINodeRunner();
    expect((await runner.run({ node, input: {} }, context())).ok).toBe(true);
    await repositoryManager.getSkillRepository().update("editorial_craft", { instructions: "CMS_AGENT_UPDATED_SKILL" });
    expect((await runner.run({ node, input: {} }, context())).ok).toBe(true);
    expect(captures.config.instructions).toContain("CMS_AGENT_UPDATED_SKILL");
    expect(captures.config.instructions).not.toContain(sentinel);
    expect(node.prompt).toBe(originalPrompt);
  });

  it("Anthropic sends the same resolved core exactly once", async () => {
    let body: any; const node = base();
    const runner = new AnthropicNodeRunner((async (_url: unknown, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "offline", stop_reason: "tool_use", content: [{ type: "tool_use", name: "emit_output", input: { artifact: "content_source.v1", summary: "Fixture." } }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
    }) as typeof fetch);
    expect((await runner.run({ node, input: {} }, context())).ok).toBe(true);
    expect(body.system).toContain((await resolveNodeInstructions(node)).prompt);
    expect(body.system.split(sentinel)).toHaveLength(2);
  });

  it.each(["draft", "deprecated"] as const)("does not inject %s skill instructions or schema conflicts", async (status) => {
    await repositoryManager.getSkillRepository().update("editorial_craft", { status, outputSchema: { type: "string" } });
    const policy = await resolveNodeInstructions(base());
    expect(policy.prompt).not.toContain(sentinel);
    expect(policy.errors).toEqual([]);
    expect(policy.conflicts).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringContaining(status) }));
    expect((await new OpenAINodeRunner().run({ node: base(), input: {} }, context())).ok).toBe(true);
    expect(captures.config.instructions).not.toContain(sentinel);
  });

  it.each(["missing", "contradictory"])("refuses %s skills before contacting either provider", async (problem) => {
    const node = base();
    if (problem === "missing") node.assignedSkills = ["does_not_exist"];
    else await repositoryManager.getSkillRepository().update("editorial_craft", { outputSchema: { type: "string" } });
    const fetcher = vi.fn();
    for (const runner of [new OpenAINodeRunner(), new AnthropicNodeRunner(fetcher)]) {
      expect(await runner.run({ node, input: {} }, context())).toMatchObject({ ok: false, code: "invalid_node_configuration" });
    }
    expect(captures.calls).toBe(0); expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads assigned skills once, deduplicates in assignment order, and grants no extra tools", async () => {
    const repo = repositoryManager.getSkillRepository();
    const all = await repo.list();
    const second = all.find(s => s.skillId !== "editorial_craft" && s.status === "active")!;
    const node = { ...base(), assignedSkills: [second.skillId, "editorial_craft", second.skillId] };
    const read = vi.spyOn(repo, "list");
    const policy = await resolveSkillsForNode(node, repo);
    expect(read).toHaveBeenCalledTimes(1);
    expect(policy.skillIds).toEqual([second.skillId, "editorial_craft"]);
    expect(policy.instructions.indexOf(`Skill ${second.skillId} v`)).toBeLessThan(policy.instructions.indexOf("Skill editorial_craft v"));
    expect(policy.effectiveTools).toEqual([]);
    read.mockClear();
    expect((await resolveNodeInstructions({ ...node, assignedSkills: [] }, repo)).skillInstructions).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
});
