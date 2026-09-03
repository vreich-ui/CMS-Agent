// Send-time transcript sanitiser (2026-09-03 admin-chat incident).
//
// WHAT HAPPENED. An admin chat made several `object_checkout` calls that failed (the ids were
// pdf-tool PDF templates, not platform objects). The transcript that Platform persisted came back
// on the next turn carrying `tool_use` blocks that no `tool_result` ever answered. The Anthropic
// Messages API rejects that with a 400 — "`tool_use` ids were found without `tool_result` blocks
// immediately after ... Each `tool_use` block must have a corresponding `tool_result` block in the
// next message". Because the whole transcript is replayed verbatim on EVERY subsequent turn, that
// one bad shape bricked the conversation permanently: even a turn whose new user text was "start
// new chat" replayed the same broken history and 400'd again. The chat could only be abandoned.
//
// WHAT THIS DOES. Nothing may leave CMS-Agent for a provider in a shape the provider rejects on
// structure. This runs over the stored transcript immediately before it is mapped onto a provider
// wire format, and guarantees:
//
//   * every `tool_use` is answered by a `tool_result` with the same id, in the very next message;
//   * every `tool_result` answers a `tool_use` that is actually there;
//   * no message carries empty or whitespace-only content.
//
// REPAIR, NOT DELETION. A turn the editor can still see explained is better than a hole in the
// history, so an unanswered tool call gains a synthetic, visibly-worded error result rather than
// having the call erased, and an unmatchable tool result becomes a visible note rather than
// vanishing. Only content that carries nothing at all (an assistant message with neither text nor
// tool calls) is dropped, because there is nothing there to preserve.
//
// A WELL-FORMED TRANSCRIPT IS RETURNED UNTOUCHED — the same array, by reference. That is pinned by
// test, because a sanitiser that quietly rewrites healthy history is a worse bug than the one it
// fixes.
import type { ConversationMessage, ConversationToolCall } from "./conversationContract.js";

export type TranscriptRepairKind =
  | "unanswered_tool_call"
  | "orphan_tool_result"
  | "duplicate_tool_result"
  | "duplicate_tool_call"
  | "empty_user_text"
  | "blank_assistant_text"
  | "empty_assistant_message"
  | "tool_exchange_flattened"
  | "same_role_merged";

export type TranscriptRepair = { kind: TranscriptRepairKind; detail: string };

export type SanitizedTranscript = {
  messages: ConversationMessage[];
  repairs: TranscriptRepair[];
};

/**
 * `repair` keeps the tool round-trips and completes them. `flatten` is the harder pass used after a
 * provider has already rejected the repaired transcript on shape: it removes tool blocks from the
 * wire altogether, restating them as plain text, so no pairing rule can be violated at all.
 */
export type TranscriptSanitiserMode = "repair" | "flatten";

// Deliberately editor-readable: these strings are replayed to the model and can end up quoted back
// into the chat, so they must explain themselves without leaking internals.
export const UNANSWERED_TOOL_RESULT_NOTE =
  "This tool call never returned a recorded result — the tool run failed or was interrupted. Treat it as failed, assume nothing was changed, and say so before trying again.";
const ORPHAN_TOOL_RESULT_NOTE = (id: string, content: string) =>
  `[Recovered tool result for ${id}, which no longer matches a tool call in this conversation]\n${content}`;
const EMPTY_USER_NOTE = "(empty message)";
const FLATTENED_CALL_NOTE = (call: ConversationToolCall) => `[tool call ${call.name} (${call.id})]`;
const FLATTENED_RESULT_NOTE = (id: string, isError: boolean, content: string) =>
  `[${isError ? "failed " : ""}tool result for ${id}]\n${content}`;

const isBlank = (text: string | undefined): boolean => !text || !text.trim();

const toolCallsOf = (message: ConversationMessage): ConversationToolCall[] =>
  message.role === "assistant" ? message.tool_calls ?? [] : [];

/**
 * The single entry point. Returns the original array (identity-equal) when the transcript is already
 * valid, so a healthy conversation serialises byte for byte as it did before this existed.
 */
export function sanitizeConversationTranscript(
  messages: ConversationMessage[],
  options: { mode?: TranscriptSanitiserMode } = {}
): SanitizedTranscript {
  const mode = options.mode ?? "repair";
  const repairs: TranscriptRepair[] = [];
  const output: ConversationMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === "user") {
      if (isBlank(message.text)) {
        repairs.push({ kind: "empty_user_text", detail: `message ${index} carried no text` });
        pushMessage(output, mode, { role: "user", text: EMPTY_USER_NOTE }, repairs);
      } else pushMessage(output, mode, message, repairs);
      continue;
    }

    if (message.role === "tool") {
      // Reached only when a tool result did not follow an assistant message that called for it —
      // the run below consumes every well-placed one. Keep the text, drop the impossible block.
      repairs.push({ kind: "orphan_tool_result", detail: `tool result ${message.tool_call_id} answers no tool call` });
      pushMessage(output, mode, { role: "user", text: ORPHAN_TOOL_RESULT_NOTE(message.tool_call_id, message.content) }, repairs);
      continue;
    }

    // ---- assistant: the message and the run of tool results that answers it are one unit.
    const calls: ConversationToolCall[] = [];
    for (const call of toolCallsOf(message)) {
      if (calls.some((kept) => kept.id === call.id)) {
        repairs.push({ kind: "duplicate_tool_call", detail: `tool call id ${call.id} appeared twice in message ${index}` });
        continue;
      }
      calls.push(call);
    }
    const blankText = isBlank(message.text);
    if (blankText && message.text !== undefined) {
      repairs.push({ kind: "blank_assistant_text", detail: `assistant message ${index} carried blank text` });
    }
    if (blankText && calls.length === 0) {
      repairs.push({ kind: "empty_assistant_message", detail: `assistant message ${index} carried neither text nor tool calls` });
      continue;
    }

    // Consume the answering run of tool results, splitting them into the ones that answer a call
    // in THIS assistant message and the ones that answer nothing at all.
    type ToolMessage = Extract<ConversationMessage, { role: "tool" }>;
    const validAnswers: ToolMessage[] = [];
    const orphanAnswers: ToolMessage[] = [];
    const answered = new Set<string>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === "tool") {
      const result = messages[cursor] as ToolMessage;
      cursor += 1;
      if (!calls.some((call) => call.id === result.tool_call_id)) {
        repairs.push({ kind: "orphan_tool_result", detail: `tool result ${result.tool_call_id} answers no tool call` });
        orphanAnswers.push(result);
        continue;
      }
      if (answered.has(result.tool_call_id)) {
        repairs.push({ kind: "duplicate_tool_result", detail: `tool call ${result.tool_call_id} was answered twice` });
        continue;
      }
      answered.add(result.tool_call_id);
      validAnswers.push(result);
    }
    const missing = calls.filter((call) => !answered.has(call.id));
    for (const call of missing) {
      repairs.push({ kind: "unanswered_tool_call", detail: `tool call ${call.id} (${call.name}) was never answered` });
    }

    if (mode === "flatten" && calls.length) {
      repairs.push({ kind: "tool_exchange_flattened", detail: `tool exchange at message ${index} was restated as text` });
      const text = [message.text?.trim(), ...calls.map(FLATTENED_CALL_NOTE)].filter(Boolean).join("\n");
      pushMessage(output, mode, { role: "assistant", text }, repairs);
      const resultText = [
        ...validAnswers.map((answer) => FLATTENED_RESULT_NOTE(answer.tool_call_id, Boolean(answer.is_error), answer.content)),
        ...orphanAnswers.map((answer) => ORPHAN_TOOL_RESULT_NOTE(answer.tool_call_id, answer.content)),
        ...missing.map((call) => FLATTENED_RESULT_NOTE(call.id, true, UNANSWERED_TOOL_RESULT_NOTE))
      ].join("\n\n");
      if (resultText) pushMessage(output, mode, { role: "user", text: resultText }, repairs);
      index = cursor - 1;
      continue;
    }

    const assistant: ConversationMessage = {
      role: "assistant",
      ...(blankText ? {} : { text: message.text }),
      ...(calls.length ? { tool_calls: calls } : {})
    };
    pushMessage(output, mode, assistant, repairs);
    for (const answer of validAnswers) output.push(answer);
    // Synthesised results go last, so real results keep their original order, and every open id is
    // closed before the next message — exactly what the provider requires.
    for (const call of missing) {
      output.push({ role: "tool", tool_call_id: call.id, content: UNANSWERED_TOOL_RESULT_NOTE, is_error: true });
    }
    for (const answer of orphanAnswers) {
      pushMessage(output, mode, { role: "user", text: ORPHAN_TOOL_RESULT_NOTE(answer.tool_call_id, answer.content) }, repairs);
    }
    index = cursor - 1;
  }

  if (!output.length) {
    // A transcript that sanitises down to nothing is still a request the provider must accept.
    repairs.push({ kind: "empty_user_text", detail: "transcript held no sendable content" });
    output.push({ role: "user", text: EMPTY_USER_NOTE });
  }
  return repairs.length ? { messages: output, repairs } : { messages, repairs };
}

/**
 * In `flatten` mode consecutive same-role messages are merged. api.anthropic.com combines them
 * server-side, but Bedrock and Vertex reject them ("roles must alternate"), and flatten mode exists
 * precisely because the normal shape has already been refused — so it gives up nothing to be strict.
 */
function pushMessage(
  output: ConversationMessage[],
  mode: TranscriptSanitiserMode,
  message: ConversationMessage,
  repairs: TranscriptRepair[]
): void {
  const previous = output.at(-1);
  if (
    mode === "flatten" &&
    previous &&
    previous.role === message.role &&
    (previous.role === "user" || (previous.role === "assistant" && !previous.tool_calls?.length)) &&
    message.role !== "tool" &&
    !toolCallsOf(message).length
  ) {
    const merged = [previous.role === "user" ? previous.text : previous.text ?? "", message.role === "user" ? message.text : message.text ?? ""]
      .filter((part) => part.trim())
      .join("\n\n");
    output[output.length - 1] = previous.role === "user"
      ? { role: "user", text: merged }
      : { role: "assistant", text: merged };
    repairs.push({ kind: "same_role_merged", detail: `merged consecutive ${previous.role} messages` });
    return;
  }
  output.push(message);
}
