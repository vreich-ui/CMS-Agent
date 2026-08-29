import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalClientManagerAgent } from "../../../src/agent/conversations/agentDefinitions.js";
import { ConverseError } from "../../../src/agent/conversations/conversationContract.js";
import { createConversationProvider } from "../../../src/agent/conversations/conversationProviders.js";

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

const input = (agent = createCanonicalClientManagerAgent("2026-08-09T00:00:00.000Z")) => ({
  agent,
  systemPrompt: "canonical\nknowledge\nvoice\ncontext-data",
  messages: [{ role: "user" as const, text: "Please propose a patch." }],
  tools: [{ name: "patch", description: "Propose a patch", input_schema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false } }],
  maxTokens: 2_000,
  timeoutMs: 1_000
});

describe("one-turn conversational providers", () => {
  it("makes exactly one OpenAI request, passes tools, and returns tool calls without executing them", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "proposal", tool_calls: [{ id: "call_1", type: "function", function: { name: "patch", arguments: "{\"value\":\"new\"}" } }] } }], usage: { prompt_tokens: 25, completion_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await createConversationProvider(fetchImpl)(input());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body).toMatchObject({ max_completion_tokens: 2_000, tools: [{ type: "function", function: { name: "patch", parameters: input().tools[0].input_schema } }] });
    expect(result).toMatchObject({ assistantText: "proposal", toolCalls: [{ id: "call_1", name: "patch", args: { value: "new" } }], inputTokens: 25, outputTokens: 7, provider: "openai" });
  });

  it("makes exactly one Anthropic request with pass-through tools and no in-runner tool loop", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const agent = { ...createCanonicalClientManagerAgent("2026-08-09T00:00:00.000Z"), modelConfig: { provider: "anthropic", model: "claude-opus-4-8", timeoutMs: 90_000, maxOutputTokens: 16_000 } };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "proposal" }, { type: "tool_use", id: "toolu_1", name: "patch", input: { value: "new" } }], usage: { input_tokens: 31, output_tokens: 9 } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await createConversationProvider(fetchImpl)(input(agent));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].body).toMatchObject({ max_tokens: 2_000, system: input(agent).systemPrompt, tools: [{ name: "patch", input_schema: input(agent).tools[0].input_schema }] });
    expect(result).toMatchObject({ assistantText: "proposal", toolCalls: [{ id: "toolu_1", name: "patch", args: { value: "new" } }], inputTokens: 31, outputTokens: 9, provider: "anthropic" });
  });

  it("omits the provider tools field when the caller supplies no tools", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "plain reply" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await createConversationProvider(fetchImpl)({ ...input(), tools: [] });

    expect(body).not.toHaveProperty("tools");
  });

  it("maps provider timeout and a generic provider error", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const timeoutFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    await expect(createConversationProvider(timeoutFetch)({ ...input(), timeoutMs: 5 })).rejects.toMatchObject({ code: "model_timeout" });

    const errorFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { code: "upstream_error" } }), { status: 500, headers: { "content-type": "application/json" } });
    await expect(createConversationProvider(errorFetch)(input())).rejects.toMatchObject({ code: "model_error" });
  });

  // Provider-error-details (2026-08-29 incident): OpenAI returned 429 credit_balance_exhausted; it
  // surfaced as budget_exceeded on the run and a generic "service unavailable" in the chat. This is
  // the same real fixture, through agent_converse's own HTTP layer. budget_exceeded must NEVER be
  // produced from a provider signal again — that code is reserved for OUR OWN usd budget guard (which
  // ConversationalRunner does not even wire up), so the previous `providerCode === "budget_exceeded"`
  // special case is gone; every provider 429 is now classified by what it actually says.
  it("classifies a 429 credit_balance_exhausted as provider_quota (never budget_exceeded), and a plain 429 as provider_rate_limit", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const quotaFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "credit_balance_exhausted", message: "Your credit balance is too low" } }), { status: 429, headers: { "content-type": "application/json" } });
    await expect(createConversationProvider(quotaFetch)(input())).rejects.toEqual(expect.objectContaining<Partial<ConverseError>>({
      code: "provider_quota",
      providerStatus: 429,
      providerMessage: expect.stringContaining("credit balance"),
      operatorAction: expect.stringContaining("Top up")
    }));

    const rateLimitFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Too many requests" } }), { status: 429, headers: { "content-type": "application/json" } });
    await expect(createConversationProvider(rateLimitFetch)(input())).rejects.toEqual(expect.objectContaining<Partial<ConverseError>>({
      code: "provider_rate_limit",
      providerStatus: 429,
      operatorAction: expect.stringContaining("Wait and retry")
    }));
  });
});
