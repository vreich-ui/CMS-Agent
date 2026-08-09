import { describe, expect, it } from "vitest";
import { MAX_CONVERSATION_TURNS, type ConversationTurnRecord } from "../../src/agent/conversations/conversationTurnTypes.js";
import { MemoryConversationTurnRepository } from "../../src/agent/repository/memory/MemoryConversationTurnRepository.js";

const record = (index: number, actorId = "usr_123"): ConversationTurnRecord => ({
  recordType: "turn",
  turnId: `turn_${index}`,
  conversationId: "conversation_1",
  projectId: "platform",
  agentRef: "agt_client_manager",
  agentRev: "rev_1",
  actor: { kind: "human", id: actorId },
  requestPreview: { messageCount: 2, latestMessagePreview: `request ${index}`, toolNames: ["patch"] },
  assistantText: `response ${index}`,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsdEstimate: 0.001 },
  createdAt: `2026-08-09T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`
});

describe("conversation turn repository", () => {
  it("keeps the newest bounded turn mirror and records the trim", async () => {
    const repository = new MemoryConversationTurnRepository();
    for (let index = 0; index <= MAX_CONVERSATION_TURNS; index++) await repository.record(record(index));

    const entries = await repository.list("conversation_1");
    expect(entries).toHaveLength(MAX_CONVERSATION_TURNS + 1);
    expect(entries[0]).toMatchObject({ recordType: "trim_marker", trimmedTurnCount: 1, conversationId: "conversation_1" });
    expect(entries[1]).toMatchObject({ recordType: "turn", turnId: "turn_1" });
    expect(entries.at(-1)).toMatchObject({ recordType: "turn", turnId: `turn_${MAX_CONVERSATION_TURNS}` });
  });

  it("stores stable actor ids only and documents attribution without authorization", async () => {
    const repository = new MemoryConversationTurnRepository();
    await repository.record(record(1, "user_opaque_id"));
    await expect(repository.record(record(2, "editor@example.com"))).rejects.toThrow(/stable_id_not_email/);
    expect(JSON.stringify(await repository.list("conversation_1"))).not.toContain("@");
  });
});
