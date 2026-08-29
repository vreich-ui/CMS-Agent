import type { ConversationalAgentDefinition } from "./agentDefinitions.js";
import { ConverseError, type ConversationMessage, type ConversationTool, type ConversationToolCall } from "./conversationContract.js";
import { resolveProvider } from "../execution/providers/providerRegistry.js";
import { classifyProviderHttpError, operatorActionForProviderHttpError, truncateProviderMessage } from "../execution/runners/providerHttpErrors.js";

export type ConversationProviderResult = {
  assistantText?: string;
  toolCalls: ConversationToolCall[];
  inputTokens: number;
  outputTokens: number;
  provider: string;
};

export type ConversationProvider = (input: {
  agent: ConversationalAgentDefinition;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools: ConversationTool[];
  maxTokens: number;
  timeoutMs: number;
}) => Promise<ConversationProviderResult>;

const parseObject = (value: string | undefined): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

const openAiMessages = (systemPrompt: string, messages: ConversationMessage[]) => [
  { role: "system", content: systemPrompt },
  ...messages.map((message) => {
    if (message.role === "user") return { role: "user", content: message.text };
    if (message.role === "tool") return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
    return {
      role: "assistant",
      content: message.text ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {})
    };
  })
];

const anthropicMessages = (messages: ConversationMessage[]) => {
  const result: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "user") result.push({ role: "user", content: message.text });
    else if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      result.push({ role: "assistant", content });
    } else {
      const block = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content, ...(message.is_error ? { is_error: true } : {}) };
      const last = result.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) (last.content as Array<Record<string, unknown>>).push(block);
      else result.push({ role: "user", content: [block] });
    }
  }
  return result;
};

const errorCodeFrom = (value: unknown): string | undefined => {
  const body = value as { error?: { code?: unknown }; code?: unknown };
  return typeof body?.error?.code === "string" ? body.error.code : typeof body?.code === "string" ? body.code : undefined;
};

const errorMessageFrom = (value: unknown): string | undefined => {
  const body = value as { error?: { message?: unknown }; message?: unknown };
  const message = body?.error?.message ?? body?.message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
};

const requestJson = async (fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number, providerLabel: string): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerCode = errorCodeFrom(body);
      // Provider-error-details (2026-08-29 incident): budget_exceeded is reserved for OUR OWN usd
      // budget guard — it must never be produced from a provider-reported code again (the previous
      // `providerCode === "budget_exceeded"` special case did exactly that). A provider 429 is now
      // classified by what it actually says: out-of-credit vs. merely rate-limited.
      const classified = classifyProviderHttpError(response.status, `${providerCode ?? ""} ${JSON.stringify(body)}`);
      if (classified) {
        const providerMessage = truncateProviderMessage(errorMessageFrom(body) ?? `provider_http_${response.status}${providerCode ? `:${providerCode}` : ""}`);
        throw new ConverseError(classified, providerMessage, {
          providerStatus: response.status,
          providerMessage,
          operatorAction: operatorActionForProviderHttpError(classified, providerLabel, "retrying the turn")
        });
      }
      throw new ConverseError("model_error", `provider_http_${response.status}${providerCode ? `:${providerCode}` : ""}`);
    }
    return body;
  } catch (error) {
    if (error instanceof ConverseError) throw error;
    const name = (error as { name?: string })?.name ?? "";
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted || /abort|timeout/i.test(`${name}:${message}`)) throw new ConverseError("model_timeout", `The model did not complete within ${timeoutMs}ms.`);
    throw new ConverseError("model_error", message);
  } finally {
    clearTimeout(timer);
  }
};

export const createConversationProvider = (fetchImpl: typeof fetch = fetch): ConversationProvider => async (input) => {
  const resolved = resolveProvider(input.agent.modelConfig as unknown as Record<string, unknown>);
  const apiKey = process.env[resolved.apiKeyEnv];
  if (!apiKey) throw new ConverseError("model_error", `${resolved.apiKeyEnv} is required for ${resolved.label} conversational execution.`);

  if (resolved.kind === "anthropic") {
    const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? resolved.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const data = await requestJson(fetchImpl, `${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: input.agent.modelConfig.model,
        max_tokens: input.maxTokens,
        system: input.systemPrompt,
        messages: anthropicMessages(input.messages),
        ...(input.tools.length ? { tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })) } : {})
      })
    }, input.timeoutMs, resolved.label) as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const assistantText = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").filter(Boolean).join("\n") || undefined;
    const toolCalls = (data.content ?? []).filter((block) => block.type === "tool_use" && block.id && block.name).map((block) => ({ id: block.id!, name: block.name!, args: block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {} }));
    if (!assistantText && toolCalls.length === 0) throw new ConverseError("model_error", "Anthropic returned neither assistant text nor tool calls.");
    return { assistantText, toolCalls, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0, provider: resolved.label };
  }

  const baseUrl = (resolved.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const data = await requestJson(fetchImpl, `${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: input.agent.modelConfig.model,
      max_completion_tokens: input.maxTokens,
      messages: openAiMessages(input.systemPrompt, input.messages),
      ...(input.tools.length ? { tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {})
    })
  }, input.timeoutMs, resolved.label) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const message = data.choices?.[0]?.message;
  const assistantText = message?.content || undefined;
  const toolCalls = (message?.tool_calls ?? []).filter((call) => call.type === "function" && call.id && call.function?.name).map((call) => ({ id: call.id!, name: call.function!.name!, args: parseObject(call.function?.arguments) }));
  if (!assistantText && toolCalls.length === 0) throw new ConverseError("model_error", "OpenAI returned neither assistant text nor tool calls.");
  return { assistantText, toolCalls, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, provider: resolved.label };
};

export const __test__ = { openAiMessages, anthropicMessages };
