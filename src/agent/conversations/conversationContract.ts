import { z } from "zod";

export const CLIENT_MANAGER_TURN_CONTRACT = "client_manager.turn.v1";
export const MAX_TRANSCRIPT_MESSAGES = 200;
export const MAX_TRANSCRIPT_CHARS = 256_000;
export const MAX_CONTEXT_CHARS = 64_000;
/**
 * W19 (2026-08-23, coordinated with Platform's `CMS_AGENT_BOUNDS.maxTools`):
 * raised from 64.
 *
 * This was never a provider limit — Anthropic and OpenAI both accept far more
 * — it was this contract's own guard against an unbounded wire. Platform's
 * chat registry had grown to exactly 63 tools plus its learning-mode
 * `present_candidates`: the old ceiling with ZERO headroom, so adding a single
 * capability silently truncated the tool list at the caller.
 *
 * The bound that actually protects cost is `MAX_TOOLS_CHARS`, which is
 * unchanged — a caller cannot use the extra slots to send a larger payload.
 * Raising the count is backward compatible: every request that was valid at 64
 * is still valid.
 */
export const MAX_CONVERSATION_TOOLS = 96;
export const MAX_TOOLS_CHARS = 256_000;

export const converseErrorCodes = [
  "unknown_project",
  "project_disabled",
  "agent_unresolved",
  "transcript_too_large",
  "model_timeout",
  "model_error",
  "budget_exceeded",
  "invalid_turn_request",
  // Provider-error-details (2026-08-29 incident): a provider's own 429 is now split by WHY, so the
  // chat shows the real cause instead of a generic model_error/"service unavailable". budget_exceeded
  // stays reserved for OUR OWN usd budget guard — it is never produced from a provider signal.
  "provider_quota",
  "provider_rate_limit"
] as const;
export type ConverseErrorCode = typeof converseErrorCodes[number];

// Provider-error-details fields, present when the failure came from an identifiable provider HTTP
// response (provider_quota/provider_rate_limit) or from our own budget guard (budget_exceeded);
// absent for every other code. Own properties (not nested under a generic `details` bag) so callers
// that merely spread an Error's own keys — see toolKit.ts's toolError() — pick them up automatically.
export type ConverseErrorDetails = { providerStatus?: number; providerMessage?: string; operatorAction?: string };

export class ConverseError extends Error {
  readonly providerStatus?: number;
  readonly providerMessage?: string;
  readonly operatorAction?: string;

  constructor(public readonly code: ConverseErrorCode, message: string, details: ConverseErrorDetails = {}) {
    super(`${code}: ${message}`);
    this.name = "ConverseError";
    this.providerStatus = details.providerStatus;
    this.providerMessage = details.providerMessage;
    this.operatorAction = details.operatorAction;
  }
}

const id = z.string().min(1).max(256);
const toolCallSchema = z.object({
  id,
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  args: z.record(z.string(), z.unknown())
}).strict();

export const conversationMessageSchema = z.union([
  z.object({ role: z.literal("user"), text: z.string() }).strict(),
  z.object({ role: z.literal("assistant"), text: z.string().optional(), tool_calls: z.array(toolCallSchema).max(64).optional() }).strict()
    .refine((message) => Boolean(message.text) || Boolean(message.tool_calls?.length), { message: "assistant message requires text and/or tool_calls" }),
  z.object({ role: z.literal("tool"), tool_call_id: id, content: z.string(), is_error: z.boolean().optional() }).strict()
]);

export const conversationToolSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string().min(1).max(16_000),
  input_schema: z.record(z.string(), z.unknown())
}).strict();

export const conversationContextSchema = z.object({
  site_id: z.string().min(1).max(128),
  object_type: z.string().min(1).max(128).optional(),
  object_id: z.string().min(1).max(256).optional(),
  focus: z.string().min(1).max(500).optional(),
  learning_mode: z.boolean().optional(),
  // CA6, additive: the caller asserts an Owner explicitly asked for technical detail on this run.
  // The prompt's editor-facing-language default is relaxed for that run only. Absent means false.
  // This is a caller assertion for tone, never an authorization signal.
  diagnostics_requested: z.boolean().optional(),
  approval_note: z.string().min(1).max(1_000).optional()
}).strict().refine((context) => Boolean(context.object_type) === Boolean(context.object_id), {
  message: "object_type and object_id must be supplied together"
});

export const agentConverseInputSchema = z.object({
  agent_ref: z.string().min(1).max(256),
  project_id: z.string().min(1).max(63),
  conversation_id: id,
  turn_id: id,
  actor: z.object({ kind: z.literal("human"), id: id }).strict(),
  context: conversationContextSchema,
  messages: z.array(conversationMessageSchema).min(1),
  tools: z.array(conversationToolSchema),
  constraints: z.object({
    max_tokens: z.number().int().positive().max(32_000),
    timeout_ms: z.number().int().min(1_000).max(120_000)
  }).strict()
}).strict();

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationTool = z.infer<typeof conversationToolSchema>;
export type AgentConverseInput = z.infer<typeof agentConverseInputSchema>;
export type ConversationToolCall = z.infer<typeof toolCallSchema>;

export type AgentConverseResponse = {
  assistant_text?: string;
  tool_calls?: ConversationToolCall[];
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  agent_rev: number;
  model: string;
};

const serializedLength = (value: unknown): number => JSON.stringify(value).length;

export function parseAgentConverseInput(input: unknown): AgentConverseInput {
  const parsed = agentConverseInputSchema.safeParse(input);
  if (!parsed.success) throw new ConverseError("invalid_turn_request", parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "));
  if (/\S+@\S+\.\S+/.test(parsed.data.actor.id)) throw new ConverseError("invalid_turn_request", "actor.id must be a stable identifier, never an email address.");
  if (parsed.data.messages.length > MAX_TRANSCRIPT_MESSAGES || serializedLength(parsed.data.messages) > MAX_TRANSCRIPT_CHARS) {
    throw new ConverseError("transcript_too_large", `messages must contain at most ${MAX_TRANSCRIPT_MESSAGES} entries and ${MAX_TRANSCRIPT_CHARS} serialized characters; trim oldest messages and retry.`);
  }
  if (serializedLength(parsed.data.context) > MAX_CONTEXT_CHARS) throw new ConverseError("invalid_turn_request", `context exceeds ${MAX_CONTEXT_CHARS} serialized characters.`);
  if (parsed.data.tools.length > MAX_CONVERSATION_TOOLS || serializedLength(parsed.data.tools) > MAX_TOOLS_CHARS) {
    throw new ConverseError("invalid_turn_request", `tools must contain at most ${MAX_CONVERSATION_TOOLS} entries and ${MAX_TOOLS_CHARS} serialized characters.`);
  }
  validateTranscriptSequence(parsed.data.messages);
  return parsed.data;
}

function validateTranscriptSequence(messages: ConversationMessage[]): void {
  let openToolCalls: Set<string> | undefined;
  for (const message of messages) {
    if (message.role === "assistant") {
      openToolCalls = message.tool_calls?.length ? new Set(message.tool_calls.map((call) => call.id)) : undefined;
      continue;
    }
    if (message.role === "tool") {
      if (!openToolCalls?.delete(message.tool_call_id)) throw new ConverseError("invalid_turn_request", `tool result ${JSON.stringify(message.tool_call_id)} does not answer a tool call in the immediately preceding assistant turn.`);
      continue;
    }
    openToolCalls = undefined;
  }
}

export const agentConverseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agent_ref", "project_id", "conversation_id", "turn_id", "actor", "context", "messages", "tools", "constraints"],
  properties: {
    agent_ref: { type: "string", minLength: 1, maxLength: 256 },
    project_id: { type: "string", minLength: 1, maxLength: 63 },
    conversation_id: { type: "string", minLength: 1, maxLength: 256 },
    turn_id: { type: "string", minLength: 1, maxLength: 256 },
    actor: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { type: "string", const: "human" }, id: { type: "string", minLength: 1, maxLength: 256 } } },
    context: { type: "object", additionalProperties: false, required: ["site_id"], properties: { site_id: { type: "string", minLength: 1, maxLength: 128 }, object_type: { type: "string", minLength: 1, maxLength: 128 }, object_id: { type: "string", minLength: 1, maxLength: 256 }, focus: { type: "string", minLength: 1, maxLength: 500 }, learning_mode: { type: "boolean" }, diagnostics_requested: { type: "boolean" }, approval_note: { type: "string", minLength: 1, maxLength: 1000 } } },
    messages: { type: "array", minItems: 1, maxItems: MAX_TRANSCRIPT_MESSAGES, items: { oneOf: [
      { type: "object", additionalProperties: false, required: ["role", "text"], properties: { role: { type: "string", const: "user" }, text: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["role"], properties: { role: { type: "string", const: "assistant" }, text: { type: "string" }, tool_calls: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "args"], properties: { id: { type: "string" }, name: { type: "string" }, args: { type: "object" } } } } } },
      { type: "object", additionalProperties: false, required: ["role", "tool_call_id", "content"], properties: { role: { type: "string", const: "tool" }, tool_call_id: { type: "string" }, content: { type: "string" }, is_error: { type: "boolean" } } }
    ] } },
    tools: { type: "array", maxItems: MAX_CONVERSATION_TOOLS, items: { type: "object", additionalProperties: false, required: ["name", "description", "input_schema"], properties: { name: { type: "string" }, description: { type: "string" }, input_schema: { type: "object" } } } },
    constraints: { type: "object", additionalProperties: false, required: ["max_tokens", "timeout_ms"], properties: { max_tokens: { type: "integer", minimum: 1, maximum: 32000 }, timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 } } }
  }
} as const;
