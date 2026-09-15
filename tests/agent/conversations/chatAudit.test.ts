import { describe, expect, it } from "vitest";
import { auditConversation } from "../../../scripts/chatAudit.js";
import type { ConversationTurnRecord } from "../../../src/agent/conversations/conversationTurnTypes.js";

// CMP-W0.1 baseline audit — these tests own the pure metric computation only. Store access, argv
// parsing and text/JSON formatting live outside auditConversation() and are exercised by hand
// (npm run chat:audit), not here.

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsdEstimate: 0 };

// Every turn below shares a conversation/project/agent identity so each test can vary just the
// fields it is about (createdAt, assistantText, toolCalls) without repeating boilerplate.
const turn = (overrides: Partial<ConversationTurnRecord> & { createdAt: string }): ConversationTurnRecord => ({
  recordType: "turn",
  turnId: `turn-${overrides.createdAt}`,
  conversationId: "conv-1",
  projectId: "site-a",
  agentRef: "client_manager",
  agentRev: "1",
  actor: { kind: "human", id: "editor-1" },
  requestPreview: { messageCount: 1 },
  usage,
  ...overrides
});

const toolCall = (name: string, args: Record<string, unknown> = {}, id = `${name}-1`) => ({ id, name, args });

describe("auditConversation", () => {
  it("answers immediately: zero tool calls before the first (and only) answer", () => {
    const turns = [turn({ createdAt: "2026-09-01T00:00:00.000Z", assistantText: "Here is the summary you asked for." })];

    const audit = auditConversation(turns);

    expect(audit.toolCallsBeforeFirstAnswer).toBe(0);
    expect(audit.turnsToFirstAction).toBe(0);
    expect(audit.questionsAsked).toBe(0);
    expect(audit.turnCount).toBe(1);
  });

  it("counts three catalog reads across leading turns, then an answer", () => {
    const turns = [
      turn({ createdAt: "2026-09-01T00:00:00.000Z", toolCalls: [toolCall("operation_list"), toolCall("operation_preflight")] }),
      turn({ createdAt: "2026-09-01T00:01:00.000Z", toolCalls: [toolCall("operation_get")] }),
      turn({ createdAt: "2026-09-01T00:02:00.000Z", assistantText: "Done — three operations checked." })
    ];

    const audit = auditConversation(turns);

    expect(audit.catalogReads).toBe(3);
    expect(audit.toolCallsBeforeFirstAnswer).toBe(3);
    expect(audit.turnsToFirstAction).toBe(1);
  });

  it("counts a question mark on every turn, once each, trailing whitespace trimmed", () => {
    const turns = [
      turn({ createdAt: "2026-09-01T00:00:00.000Z", assistantText: "Should I publish this now?" }),
      turn({ createdAt: "2026-09-01T00:01:00.000Z", assistantText: "Do you want the short or long version?  \n" }),
      turn({ createdAt: "2026-09-01T00:02:00.000Z", assistantText: "Ready when you are — go ahead?" })
    ];

    const audit = auditConversation(turns);

    expect(audit.questionsAsked).toBe(3);
    // The first turn answers with no tool calls, so it is the first-answer boundary.
    expect(audit.toolCallsBeforeFirstAnswer).toBe(0);
  });

  it("skips a malformed toolCalls entry and tallies it instead of dropping it silently", () => {
    const turns = [
      turn({
        createdAt: "2026-09-01T00:00:00.000Z",
        // valid, plus a string, plus an object missing `name`, plus one whose args isn't an object.
        toolCalls: [toolCall("operation_list"), "not-a-tool-call", { id: "x", args: {} }, { id: "y", name: "operation_get", args: "nope" }]
      }),
      turn({ createdAt: "2026-09-01T00:01:00.000Z", assistantText: "Checked the catalog." })
    ];

    const audit = auditConversation(turns);

    expect(audit.skippedToolCalls).toBe(3);
    expect(audit.catalogReads).toBe(1);
    expect(audit.toolCallsBeforeFirstAnswer).toBe(1);
  });

  it("sorts out-of-order createdAt before computing metrics", () => {
    // Passed in reverse of actual time order — the real first turn (00:00) carries the tool call,
    // the real second turn (00:01) answers. If the function trusted array order instead of
    // createdAt, it would see the answer first and report toolCallsBeforeFirstAnswer as 0.
    const turns = [
      turn({ createdAt: "2026-09-01T00:01:00.000Z", assistantText: "Found it." }),
      turn({ createdAt: "2026-09-01T00:00:00.000Z", toolCalls: [toolCall("operation_get")] })
    ];

    const audit = auditConversation(turns);

    expect(audit.turnsToFirstAction).toBe(1);
    expect(audit.toolCallsBeforeFirstAnswer).toBe(1);
  });

  it("attributes object_get to the bound object when exactly one object_id is seen", () => {
    const turns = [
      turn({
        createdAt: "2026-09-01T00:00:00.000Z",
        toolCalls: [
          toolCall("object_get", { object_id: "obj-1" }, "call-1"),
          toolCall("object_get", { object_id: "obj-1" }, "call-2"),
          toolCall("object_contract", {}, "call-3")
        ]
      }),
      turn({ createdAt: "2026-09-01T00:01:00.000Z", assistantText: "Here is the object." })
    ];

    const audit = auditConversation(turns);

    expect(audit.contractReadRule).toBe("bound_object_id_matched");
    // object_contract (1) + object_get calls matching obj-1 (2).
    expect(audit.contractReads).toBe(3);
  });

  it("falls back to counting every object_get when no single bound object is discoverable", () => {
    const turns = [
      turn({
        createdAt: "2026-09-01T00:00:00.000Z",
        toolCalls: [
          toolCall("object_get", { object_id: "obj-1" }, "call-1"),
          toolCall("object_get", { object_id: "obj-2" }, "call-2")
        ]
      }),
      turn({ createdAt: "2026-09-01T00:01:00.000Z", assistantText: "Compared both objects." })
    ];

    const audit = auditConversation(turns);

    expect(audit.contractReadRule).toBe("no_single_bound_object_id_counted_all_object_get");
    expect(audit.contractReads).toBe(2);
  });

  it("returns all zeros for an empty conversation", () => {
    const audit = auditConversation([]);

    expect(audit).toEqual({
      turnCount: 0,
      toolCallsBeforeFirstAnswer: 0,
      questionsAsked: 0,
      turnsToFirstAction: 0,
      catalogReads: 0,
      contractReads: 0,
      contractReadRule: "no_single_bound_object_id_counted_all_object_get",
      skippedToolCalls: 0
    });
  });
});
