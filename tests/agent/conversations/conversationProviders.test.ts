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

  // Chat-recovery (2026-09-03 admin-chat incident). Several object_checkout calls failed; from that
  // turn on, EVERY turn — including one that only said "start new chat" — died with
  // `model_error: provider_http_400`, because the persisted transcript carrying the unanswered
  // tool_use blocks was replayed verbatim each time. Two rules now hold: what we send is sanitised
  // first, and a shape rejection ends in a named, actionable failure instead of a permanent brick.
  const brokenTranscript = [
    { role: "user" as const, text: "Check out the three PDF templates." },
    { role: "assistant" as const, text: "On it.", tool_calls: [
      { id: "toolu_a", name: "object_checkout", args: { object_id: "pdf_tpl_1" } },
      { id: "toolu_b", name: "object_checkout", args: { object_id: "pdf_tpl_2" } }
    ] },
    { role: "tool" as const, tool_call_id: "toolu_a", content: "unknown_object", is_error: true },
    { role: "user" as const, text: "start new chat" }
  ];

  const shapeRejection = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_b. Each `tool_use` block must have a corresponding `tool_result` block in the next message." } }), { status: 400, headers: { "content-type": "application/json" } });

  const anthropicAgent = () => ({ ...createCanonicalClientManagerAgent("2026-08-09T00:00:00.000Z"), modelConfig: { provider: "anthropic", model: "claude-opus-4-8", timeoutMs: 90_000, maxOutputTokens: 16_000 } });

  it("sanitises the incident's transcript before it is sent, so the provider never sees the 400 at all", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Those are PDF templates, not objects." }], usage: { input_tokens: 4, output_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await createConversationProvider(fetchImpl)({ ...input(anthropicAgent()), messages: brokenTranscript });

    expect(bodies).toHaveLength(1);
    const blocks = (bodies[0].messages as Array<{ content: unknown }>).flatMap((message) => Array.isArray(message.content) ? message.content as Array<{ type?: string; id?: string; tool_use_id?: string }> : []);
    const used = blocks.filter((block) => block.type === "tool_use").map((block) => block.id);
    const answered = blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
    expect(used).toEqual(["toolu_a", "toolu_b"]);
    expect(answered).toEqual(["toolu_a", "toolu_b"]);
  });

  it("retries a request-shape 400 exactly once, with the tool exchange flattened, and succeeds", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return shapeRejection();
      return new Response(JSON.stringify({ content: [{ type: "text", text: "recovered" }], usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await createConversationProvider(fetchImpl)({ ...input(anthropicAgent()), messages: brokenTranscript });

    expect(result.assistantText).toBe("recovered");
    expect(bodies).toHaveLength(2);
    const retryBlocks = JSON.stringify(bodies[1].messages);
    expect(retryBlocks).not.toContain("tool_use");
    expect(retryBlocks).not.toContain("tool_result");
    expect(retryBlocks).toContain("object_checkout");
  });

  it("turns a shape rejection that survives the retry into conversation_needs_reset, not a permanent model_error", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return shapeRejection(); };

    await expect(createConversationProvider(fetchImpl)({ ...input(anthropicAgent()), messages: brokenTranscript })).rejects.toEqual(expect.objectContaining<Partial<ConverseError>>({
      code: "conversation_needs_reset",
      providerStatus: 400,
      providerMessage: expect.stringContaining("tool_result"),
      operatorAction: expect.stringContaining("Start a new conversation")
    }));
    expect(calls).toBe(2);
    await expect(createConversationProvider(fetchImpl)({ ...input(anthropicAgent()), messages: brokenTranscript })).rejects.toMatchObject({ message: expect.stringContaining("Start a new chat") });
  });

  it("does not spend the retry on a 400 that is not about request shape", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400, headers: { "content-type": "application/json" } });
    };

    await expect(createConversationProvider(fetchImpl)({ ...input(anthropicAgent()), messages: brokenTranscript })).rejects.toMatchObject({ code: "model_error" });
    expect(calls).toBe(1);
  });

  it("recovers the same way on the OpenAI path", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await createConversationProvider(fetchImpl)({ ...input(), messages: brokenTranscript });

    expect(result.assistantText).toBe("recovered");
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1].messages)).not.toContain("tool_call_id");
  });

  // The incident report could only say `provider_http_400`: the fall-through threw that bare string
  // and discarded the provider's own explanation, so nobody could tell what was wrong.
  it("carries the provider's own message on the unclassified-status path", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: { code: "upstream_error", message: "The upstream model pool is unavailable in this region." } }), { status: 500, headers: { "content-type": "application/json" } });

    await expect(createConversationProvider(fetchImpl)(input())).rejects.toEqual(expect.objectContaining<Partial<ConverseError>>({
      code: "model_error",
      providerStatus: 500,
      providerMessage: "The upstream model pool is unavailable in this region.",
      message: expect.stringContaining("The upstream model pool is unavailable in this region.")
    }));
  });
});
