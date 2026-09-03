// Chat-recovery (2026-09-03 admin-chat incident). An admin chat made several `object_checkout`
// calls that failed, and from that turn on EVERY turn — including one that only said "start new
// chat" — died with `cms_agent_model_error: model_error: provider_http_400`. The transcript is
// persisted by Platform and replayed verbatim on every turn, so a single provider-invalid shape in
// it is permanent: the conversation could only be abandoned.
//
// These tests state the rule the incident violated (nothing leaves here in a shape the provider
// rejects on structure) and the rule the fix must not break (a healthy transcript is untouched).
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../../../src/agent/conversations/conversationContract.js";
import { __test__ } from "../../../src/agent/conversations/conversationProviders.js";
import { sanitizeConversationTranscript } from "../../../src/agent/conversations/transcriptSanitiser.js";

const { anthropicMessages, openAiMessages } = __test__;

type Block = { type?: string; id?: string; tool_use_id?: string; text?: string };
type WireMessage = { role: string; content: unknown };

/**
 * The Anthropic Messages API rules this incident ran into, as an assertion. Verified against the
 * documented contract and the errors the API actually returns:
 *
 *   - "`tool_use` ids were found without `tool_result` blocks immediately after: … Each `tool_use`
 *     block must have a corresponding `tool_result` block in the next message."
 *   - "Tool result blocks must immediately follow their corresponding tool use blocks in the
 *     message history", and within that message "the `tool_result` blocks must come FIRST in the
 *     content array".
 *   - an unmatched `tool_use_id` on a `tool_result` is rejected.
 *   - "all messages must have non-empty content" / "text content blocks must be non-empty".
 */
const rejectionsFromAnthropic = (messages: WireMessage[]): string[] => {
  const problems: string[] = [];
  let open: string[] = [];
  messages.forEach((message, index) => {
    const blocks: Block[] = Array.isArray(message.content) ? message.content as Block[] : [];
    if (typeof message.content === "string") {
      if (!message.content.trim()) problems.push(`messages.${index}: all messages must have non-empty content`);
    } else if (!blocks.length) {
      problems.push(`messages.${index}: all messages must have non-empty content`);
    }
    blocks.forEach((block, blockIndex) => {
      if (block.type === "text" && !block.text?.trim()) problems.push(`messages.${index}.content.${blockIndex}: text content blocks must be non-empty`);
      if (block.type === "tool_result") {
        if (!open.includes(block.tool_use_id ?? "")) problems.push(`messages.${index}.content.${blockIndex}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${block.tool_use_id}`);
        else open = open.filter((id) => id !== block.tool_use_id);
        if (blocks.slice(0, blockIndex).some((earlier) => earlier.type !== "tool_result")) problems.push(`messages.${index}: \`tool_result\` blocks must come first`);
      }
    });
    if (open.length) problems.push(`\`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${open.join(", ")}`);
    open = blocks.filter((block) => block.type === "tool_use").map((block) => block.id ?? "");
  });
  if (open.length) problems.push(`\`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${open.join(", ")}`);
  return problems;
};

const rejectionsFromOpenAi = (messages: Array<Record<string, unknown>>): string[] => {
  const problems: string[] = [];
  let open: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const id = String(message.tool_call_id ?? "");
      if (!open.includes(id)) problems.push(`Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls': ${id}`);
      continue;
    }
    if (message.role === "user" && !String(message.content ?? "").trim()) problems.push("Invalid 'messages': string too short");
    open = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<{ id: string }>).map((call) => call.id) : [];
  }
  return problems;
};

// The exact shape the incident left behind: an assistant turn that called object_checkout three
// times against ids that were not object records, where the round-trip broke — one result came
// back, two never did — plus a stray result left over from an earlier interrupted call. Then the
// editor gave up and typed "start new chat", which replayed all of it and 400'd again.
const incidentTranscript = (): ConversationMessage[] => [
  { role: "user", text: "Check out the three PDF templates so I can edit them." },
  {
    role: "assistant",
    text: "Checking those out now.",
    tool_calls: [
      { id: "toolu_a", name: "object_checkout", args: { object_id: "pdf_tpl_1" } },
      { id: "toolu_b", name: "object_checkout", args: { object_id: "pdf_tpl_2" } },
      { id: "toolu_c", name: "object_checkout", args: { object_id: "pdf_tpl_3" } }
    ]
  },
  { role: "tool", tool_call_id: "toolu_a", content: "unknown_object: pdf_tpl_1 is not an object record", is_error: true },
  { role: "tool", tool_call_id: "toolu_gone", content: "unknown_object: pdf_tpl_0 is not an object record", is_error: true },
  { role: "user", text: "start new chat" }
];

const healthyTranscript = (): ConversationMessage[] => [
  { role: "user", text: "Draft the launch note." },
  { role: "assistant", text: "Reading the object first.", tool_calls: [{ id: "toolu_1", name: "object_get", args: { id: "obj_1" } }] },
  { role: "tool", tool_call_id: "toolu_1", content: "{\"title\":\"Launch\"}" },
  { role: "assistant", text: "Here is a draft." },
  { role: "user", text: "Tighten the second paragraph." }
];

describe("transcript sanitiser — a well-formed transcript is untouched", () => {
  it("returns the very same array, and the same provider bodies, byte for byte", () => {
    const transcript = healthyTranscript();
    const before = JSON.stringify(transcript);

    const sanitised = sanitizeConversationTranscript(transcript);

    expect(sanitised.messages).toBe(transcript);
    expect(sanitised.repairs).toEqual([]);
    expect(JSON.stringify(transcript)).toBe(before);
    // The wire bodies are pinned as literals: this is the mapping that shipped before the
    // sanitiser existed, and it must survive the sanitiser unchanged.
    expect(JSON.stringify(anthropicMessages(sanitised.messages))).toBe(JSON.stringify([
      { role: "user", content: "Draft the launch note." },
      { role: "assistant", content: [{ type: "text", text: "Reading the object first." }, { type: "tool_use", id: "toolu_1", name: "object_get", input: { id: "obj_1" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"title\":\"Launch\"}" }] },
      { role: "assistant", content: [{ type: "text", text: "Here is a draft." }] },
      { role: "user", content: "Tighten the second paragraph." }
    ]));
    expect(JSON.stringify(openAiMessages("sys", sanitised.messages))).toBe(JSON.stringify(openAiMessages("sys", healthyTranscript())));
    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
  });

  it("leaves a parallel tool round-trip, an is_error result and consecutive user messages alone", () => {
    const transcript: ConversationMessage[] = [
      { role: "user", text: "one" },
      { role: "user", text: "two" },
      { role: "assistant", tool_calls: [{ id: "t1", name: "a", args: {} }, { id: "t2", name: "b", args: {} }] },
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "tool", tool_call_id: "t2", content: "failed", is_error: true }
    ];

    expect(sanitizeConversationTranscript(transcript).messages).toBe(transcript);
    expect(rejectionsFromAnthropic(anthropicMessages(transcript) as WireMessage[])).toEqual([]);
  });
});

describe("transcript sanitiser — the incident's own shape", () => {
  it("is what the provider rejected before the fix", () => {
    const problems = rejectionsFromAnthropic(anthropicMessages(incidentTranscript()) as WireMessage[]);

    expect(problems.some((problem) => problem.includes("without `tool_result` blocks"))).toBe(true);
    expect(problems.some((problem) => problem.includes("unexpected `tool_use_id`"))).toBe(true);
  });

  it("sends cleanly after sanitising, on both providers, and keeps the failure visible to the model", () => {
    const sanitised = sanitizeConversationTranscript(incidentTranscript());

    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
    expect(rejectionsFromOpenAi(openAiMessages("sys", sanitised.messages))).toEqual([]);
    expect(sanitised.repairs.map((repair) => repair.kind).sort()).toEqual(["orphan_tool_result", "unanswered_tool_call", "unanswered_tool_call"]);
    // Repaired, not deleted: the two dead calls are still in the history, now answered by a note
    // that tells the model (and so the editor) they failed and changed nothing.
    const wire = JSON.stringify(sanitised.messages);
    expect(wire).toContain("toolu_b");
    expect(wire).toContain("toolu_c");
    expect(wire).toContain("never returned a recorded result");
    expect(wire).toContain("unknown_object: pdf_tpl_0");
    expect(sanitised.messages.at(-1)).toEqual({ role: "user", text: "start new chat" });
  });
});

describe("transcript sanitiser — each rejected shape", () => {
  it("answers a tool_use nothing ever answered", () => {
    const transcript: ConversationMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", tool_calls: [{ id: "t1", name: "object_checkout", args: {} }] },
      { role: "user", text: "never mind" }
    ];

    const sanitised = sanitizeConversationTranscript(transcript);

    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
    expect(sanitised.messages[2]).toMatchObject({ role: "tool", tool_call_id: "t1", is_error: true });
    expect(sanitised.repairs[0].kind).toBe("unanswered_tool_call");
  });

  it("rescues a tool_result that answers no tool_use, as readable text", () => {
    const transcript: ConversationMessage[] = [
      { role: "user", text: "go" },
      { role: "tool", tool_call_id: "toolu_gone", content: "the answer was 41" }
    ];

    const sanitised = sanitizeConversationTranscript(transcript);

    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
    expect(rejectionsFromOpenAi(openAiMessages("sys", sanitised.messages))).toEqual([]);
    expect(JSON.stringify(sanitised.messages)).toContain("the answer was 41");
    expect(sanitised.repairs[0].kind).toBe("orphan_tool_result");
  });

  it("drops an assistant message with no content at all, and blank assistant text", () => {
    const transcript = [
      { role: "user", text: "go" },
      { role: "assistant", text: "", tool_calls: [] },
      { role: "assistant", text: "   ", tool_calls: [{ id: "t1", name: "a", args: {} }] },
      { role: "tool", tool_call_id: "t1", content: "ok" }
    ] as ConversationMessage[];

    const sanitised = sanitizeConversationTranscript(transcript);

    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
    expect(sanitised.messages).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", tool_calls: [{ id: "t1", name: "a", args: {} }] },
      { role: "tool", tool_call_id: "t1", content: "ok" }
    ]);
  });

  it("replaces empty and whitespace-only user text", () => {
    const transcript: ConversationMessage[] = [{ role: "user", text: "" }, { role: "assistant", text: "hi" }, { role: "user", text: "   " }];

    const sanitised = sanitizeConversationTranscript(transcript);

    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
    expect(rejectionsFromOpenAi(openAiMessages("sys", sanitised.messages))).toEqual([]);
    expect(sanitised.repairs.map((repair) => repair.kind)).toEqual(["empty_user_text", "empty_user_text"]);
  });

  it("drops a duplicate tool_result and a duplicate tool_use id", () => {
    const transcript: ConversationMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", tool_calls: [{ id: "t1", name: "a", args: {} }, { id: "t1", name: "a", args: {} }] },
      { role: "tool", tool_call_id: "t1", content: "one" },
      { role: "tool", tool_call_id: "t1", content: "two" }
    ];

    const sanitised = sanitizeConversationTranscript(transcript);

    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
    expect(sanitised.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(sanitised.repairs.map((repair) => repair.kind).sort()).toEqual(["duplicate_tool_call", "duplicate_tool_result"]);
  });

  it("never produces an empty request", () => {
    const sanitised = sanitizeConversationTranscript([{ role: "assistant", text: "  " }] as ConversationMessage[]);

    expect(sanitised.messages).toEqual([{ role: "user", text: "(empty message)" }]);
    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
  });
});

describe("transcript sanitiser — flatten mode (the second pass, after a provider still says no)", () => {
  it("restates the whole tool exchange as text, so no pairing rule can apply", () => {
    const sanitised = sanitizeConversationTranscript(incidentTranscript(), { mode: "flatten" });

    expect(sanitised.messages.some((message) => message.role === "tool")).toBe(false);
    expect(sanitised.messages.some((message) => message.role === "assistant" && message.tool_calls?.length)).toBe(false);
    expect(rejectionsFromAnthropic(anthropicMessages(sanitised.messages) as WireMessage[])).toEqual([]);
    // The history still says what happened.
    const wire = JSON.stringify(sanitised.messages);
    expect(wire).toContain("object_checkout");
    expect(wire).toContain("unknown_object: pdf_tpl_1");
    expect(wire).toContain("never returned a recorded result");
  });

  it("merges consecutive same-role messages, which api.anthropic.com combines but Bedrock rejects", () => {
    const sanitised = sanitizeConversationTranscript([
      { role: "user", text: "one" },
      { role: "user", text: "two" }
    ], { mode: "flatten" });

    expect(sanitised.messages).toEqual([{ role: "user", text: "one\n\ntwo" }]);
  });
});
