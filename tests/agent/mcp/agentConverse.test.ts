import { describe, expect, it, vi } from "vitest";
import { createAgentTools } from "../../../src/agent/mcp/workspace/agentTools.js";
import { ConversationalRunner } from "../../../src/agent/conversations/conversationalRunner.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";

const input = {
  agent_ref: "agt_client_manager@1",
  project_id: "platform",
  conversation_id: "chat_wire",
  turn_id: "turn_wire",
  actor: { kind: "human" as const, id: "usr_wire" },
  context: { site_id: "site_platform" },
  messages: [{ role: "user" as const, text: "Hello" }],
  tools: [],
  constraints: { max_tokens: 1000, timeout_ms: 5000 }
};

describe("agent_converse MCP tool", () => {
  it("advertises the frozen strict schema and returns the v1 response in the standard tool envelope", async () => {
    const manager = new RepositoryManager();
    const provider = vi.fn(async () => ({ assistantText: "Hello", toolCalls: [], inputTokens: 3, outputTokens: 1, provider: "openai" }));
    const runner = new ConversationalRunner({
      workspaceRepository: manager.getWorkspaceRepository(), projectRepository: manager.getProjectRepository(),
      conversationTurnRepository: manager.getConversationTurnRepository(), usageRepository: manager.getUsageRepository(), provider
    });
    const converse = createAgentTools({
      workspaceRepository: manager.getWorkspaceRepository(), projectRepository: manager.getProjectRepository(),
      conversationTurnRepository: manager.getConversationTurnRepository(), usageRepository: manager.getUsageRepository(), conversationalRunner: runner
    }).find((tool) => tool.name === "agent.converse")!;

    expect(converse.inputSchema).toMatchObject({ additionalProperties: false, required: ["agent_ref", "project_id", "conversation_id", "turn_id", "actor", "context", "messages", "tools", "constraints"] });
    await expect(converse.execute(input)).resolves.toMatchObject({ ok: true, data: { assistant_text: "Hello", usage: { input_tokens: 3, output_tokens: 1 }, agent_rev: 1, model: "gpt-4.1" } });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown top-level and nested fields with invalid_turn_request", async () => {
    const manager = new RepositoryManager();
    const runner = new ConversationalRunner({
      workspaceRepository: manager.getWorkspaceRepository(), projectRepository: manager.getProjectRepository(),
      conversationTurnRepository: manager.getConversationTurnRepository(), usageRepository: manager.getUsageRepository(),
      provider: async () => ({ assistantText: "unused", toolCalls: [], inputTokens: 0, outputTokens: 0, provider: "openai" })
    });
    const converse = createAgentTools({
      workspaceRepository: manager.getWorkspaceRepository(), projectRepository: manager.getProjectRepository(),
      conversationTurnRepository: manager.getConversationTurnRepository(), usageRepository: manager.getUsageRepository(), conversationalRunner: runner
    }).find((tool) => tool.name === "agent.converse")!;

    await expect(converse.execute({ ...input, unknown: true })).rejects.toMatchObject({ code: "invalid_turn_request" });
    await expect(converse.execute({ ...input, turn_id: "nested", actor: { ...input.actor, email: "editor@example.com" } })).rejects.toMatchObject({ code: "invalid_turn_request" });
  });
});
