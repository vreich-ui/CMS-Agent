import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProvider, buildAgentModel } from "../../src/agent/execution/providers/providerRegistry.js";
import { getNodeRunner } from "../../src/agent/execution/runnerRegistry.js";
import { AnthropicNodeRunner } from "../../src/agent/execution/runners/AnthropicNodeRunner.js";
import { OpenAINodeRunner } from "../../src/agent/execution/runners/OpenAINodeRunner.js";
import { MockNodeRunner } from "../../src/agent/execution/runners/MockNodeRunner.js";
import type { WorkspaceNode } from "../../src/agent/workspace/nodeTypes.js";
import type { NodeRunnerContext } from "../../src/agent/execution/executionContext.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

// Phase 6 (docs/platform/DIRECTION.md §6): native Anthropic runner + cross-family judges. These tests
// pin the provider entry, provider-aware runner selection, the runner's config validation, and its
// Messages-API request/response handling against an injected fetch (no network).

describe("resolveProvider — anthropic entry", () => {
  it("resolves the native anthropic provider with the default key env", () => {
    expect(resolveProvider({ provider: "anthropic" })).toEqual({ label: "anthropic", kind: "anthropic", baseURL: undefined, apiKeyEnv: "ANTHROPIC_API_KEY" });
  });
  it("honors custom apiKeyEnv and baseURL", () => {
    expect(resolveProvider({ provider: "anthropic", apiKeyEnv: "ALT_KEY", baseURL: "https://proxy.example" }))
      .toEqual({ label: "anthropic", kind: "anthropic", baseURL: "https://proxy.example", apiKeyEnv: "ALT_KEY" });
  });
  it("buildAgentModel refuses the anthropic kind (it runs on the native runner)", () => {
    expect(() => buildAgentModel(resolveProvider({ provider: "anthropic" }), "claude-opus-4-8")).toThrow(/native AnthropicNodeRunner/);
  });
});

describe("getNodeRunner — provider-aware selection", () => {
  it("routes an anthropic-provider node to the native runner in live mode only", () => {
    expect(getNodeRunner("openai", { provider: "anthropic" })).toBeInstanceOf(AnthropicNodeRunner);
    expect(getNodeRunner("openai", { provider: "ANTHROPIC" })).toBeInstanceOf(AnthropicNodeRunner); // case-insensitive
    expect(getNodeRunner("mock", { provider: "anthropic" })).toBeInstanceOf(MockNodeRunner); // mock always wins
  });
  it("keeps every other provider on the OpenAI(-compatible) path", () => {
    expect(getNodeRunner("openai", { provider: "openai" })).toBeInstanceOf(OpenAINodeRunner);
    expect(getNodeRunner("openai", { provider: "google" })).toBeInstanceOf(OpenAINodeRunner);
    expect(getNodeRunner("openai")).toBeInstanceOf(OpenAINodeRunner);
    expect(getNodeRunner("mock")).toBeInstanceOf(MockNodeRunner);
  });
});

const OUTPUT_SCHEMA = { type: "object", required: ["summary"], additionalProperties: true, properties: { summary: { type: "string" } } };
const node = (over: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id: "anthropic_node", name: "Anthropic Node", description: "test", prompt: "Do the thing.",
  outputSchema: OUTPUT_SCHEMA, dependsOn: [], modelConfig: { provider: "anthropic", model: "claude-opus-4-8" },
  ...over
} as unknown as WorkspaceNode);
const context = (signal?: AbortSignal): NodeRunnerContext => ({ run: { runId: "run_anthropic", workflowId: "wf", projectId: "p", stageOutputs: {} } as never, executionRepository: {} as never, signal });

// A minimal fetch double returning the given status + JSON body, capturing the request for assertions.
type Captured = { url: string; init: RequestInit };
const fetchStub = (opts: { status?: number; json?: unknown; text?: string; throwErr?: Error }, captured?: Captured[]) =>
  (async (url: string, init: RequestInit) => {
    captured?.push({ url, init });
    if (opts.throwErr) throw opts.throwErr;
    const status = opts.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => opts.json, text: async () => opts.text ?? "" };
  }) as unknown as typeof fetch;
const messagesResponse = (over: Record<string, unknown> = {}) => ({ id: "msg_1", stop_reason: "tool_use", content: [{ type: "tool_use", name: "emit_output", input: { summary: "done" } }], usage: { input_tokens: 12, output_tokens: 7 }, ...over });

describe("AnthropicNodeRunner.validateConfiguration", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it("says the missing key is a plane gap, not a defect in the node it is reporting on", () => {
    // K-A12. The error surfaces as per-node validation, so whoever reads it is looking at a node
    // and will start editing one. Nothing about the node is wrong: `anthropic-api-key` is in Secret
    // Manager and bound to no Cloud Run plane, and the deploy that "caused" the failure is clean.
    delete process.env.ANTHROPIC_API_KEY;
    const result = new AnthropicNodeRunner().validateConfiguration({ id: "writer", outputSchema: { type: "object" }, modelConfig: { provider: "anthropic" } } as never);
    const message = (result as { errors: string[] }).errors.join(" ");
    expect(message).toContain("DEPLOY gap");
    expect(message).toContain("K-A12");
    expect(message).toContain("--update-secrets");
    expect(message).toContain('node "writer"');
  });

  it("requires ANTHROPIC_API_KEY and an outputSchema", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const missingKey = new AnthropicNodeRunner().validateConfiguration(node());
    expect(missingKey.ok).toBe(false);
    expect((missingKey as { errors: string[] }).errors.join(" ")).toContain("ANTHROPIC_API_KEY");

    process.env.ANTHROPIC_API_KEY = "sk-test";
    const noSchema = new AnthropicNodeRunner().validateConfiguration(node({ outputSchema: undefined }));
    expect((noSchema as { errors: string[] }).errors.join(" ")).toContain("outputSchema");
    expect(new AnthropicNodeRunner().validateConfiguration(node()).ok).toBe(true);
  });

  it("refuses a tool-using node by name (no Messages-API tool loop yet)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    // A provider switch on a tool-granted node (article_body, artifact_plan, publish_payload) must
    // fail at configuration time — running it here would silently strip the granted tools.
    const result = new AnthropicNodeRunner().validateConfiguration(node({ allowedTools: ["project.call_read_tool", "stage.get_output"] } as Partial<WorkspaceNode>));
    expect(result.ok).toBe(false);
    const joined = (result as { errors: string[] }).errors.join(" ");
    expect(joined).toContain("cannot execute tool-using nodes");
    expect(joined).toContain("project.call_read_tool");
  });
});

describe("AnthropicNodeRunner.run (injected fetch)", () => {
  const saved = { ...process.env };
  beforeEach(() => { resetRepositoryManager(); process.env.ANTHROPIC_API_KEY = "sk-test"; });
  afterEach(() => { process.env = { ...saved }; resetRepositoryManager(); });

  it("issues a forced-tool Messages request and returns the validated tool_use output", async () => {
    const captured: Captured[] = [];
    const runner = new AnthropicNodeRunner(fetchStub({ json: messagesResponse() }, captured));
    const result = await runner.run({ node: node(), input: { question: "hi" } }, context());

    expect(result.ok).toBe(true);
    expect((result as { output: unknown }).output).toEqual({ summary: "done" });
    // Request shape: correct endpoint, auth + version headers, and the emit_output forced tool.
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(captured[0]!.init.body as string);
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.tools[0].name).toBe("emit_output");
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_output" });
    expect(body.temperature).toBeUndefined(); // sampling params omitted for current Claude models
    // Usage is recorded under the anthropic provider.
    const usage = await repositoryManager.getUsageRepository().list({ runId: "run_anthropic" });
    expect(usage.find((record) => record.nodeId === "anthropic_node")?.provider).toBe("anthropic");
  });

  it("delivers dependencies once, bounded under dependencyOutputs rather than duplicating them inside input", async () => {
    const captured: Captured[] = [];
    const runner = new AnthropicNodeRunner(fetchStub({ json: messagesResponse() }, captured));
    await runner.run({
      node: node({ dependsOn: ["upstream"] } as Partial<WorkspaceNode>),
      input: { brief: "keep", dependencies: { upstream: { artifact: "upstream.v1", summary: "delivered" } } }
    }, context());

    const body = JSON.parse(captured[0]!.init.body as string);
    const payload = JSON.parse(body.messages[0].content as string);
    expect(payload.input).toEqual({ brief: "keep" });
    expect(payload.input).not.toHaveProperty("dependencies");
    expect(payload.dependencyOutputs).toEqual({ upstream: { artifact: "upstream.v1", summary: "delivered" } });
  });

  it("honors a custom base URL", async () => {
    const captured: Captured[] = [];
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example/";
    const runner = new AnthropicNodeRunner(fetchStub({ json: messagesResponse() }, captured));
    await runner.run({ node: node(), input: {} }, context());
    expect(captured[0]!.url).toBe("https://proxy.example/v1/messages");
  });

  it("surfaces an HTTP error as model_error", async () => {
    const runner = new AnthropicNodeRunner(fetchStub({ status: 500, text: "server boom" }));
    const result = await runner.run({ node: node(), input: {} }, context());
    expect(result).toMatchObject({ ok: false, code: "model_error" });
    expect((result as { message: string }).message).toContain("anthropic_http_500");
  });

  it("maps a safety refusal to model_error", async () => {
    const runner = new AnthropicNodeRunner(fetchStub({ json: messagesResponse({ stop_reason: "refusal", content: [] }) }));
    const result = await runner.run({ node: node(), input: {} }, context());
    expect(result).toMatchObject({ ok: false, code: "model_error" });
    expect((result as { message: string }).message).toContain("refusal");
  });

  it("fails validation when the model returns no emit_output tool call", async () => {
    const runner = new AnthropicNodeRunner(fetchStub({ json: messagesResponse({ content: [{ type: "text", text: "no tool" }] }) }));
    expect(await runner.run({ node: node(), input: {} }, context())).toMatchObject({ ok: false, code: "output_validation_failed" });
  });

  it("fails validation when tool output does not match the schema", async () => {
    const runner = new AnthropicNodeRunner(fetchStub({ json: messagesResponse({ content: [{ type: "tool_use", name: "emit_output", input: { wrong: 1 } }] }) }));
    expect(await runner.run({ node: node(), input: {} }, context())).toMatchObject({ ok: false, code: "output_validation_failed" });
  });

  it("reports cancellation when the request is aborted", async () => {
    const runner = new AnthropicNodeRunner(fetchStub({ throwErr: new Error("The operation was aborted") }));
    const result = await runner.run({ node: node(), input: {} }, context({ aborted: true } as AbortSignal));
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
  });
});

// A fetch double that returns a DIFFERENT queued response on each successive call (fetchStub above
// always returns the same one) — needed to exercise a truncated-then-retried-then-succeeded sequence.
const sequentialFetchStub = (responses: Array<{ status?: number; json?: unknown; text?: string }>, captured?: Captured[]) => {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    captured?.push({ url, init });
    const opts = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = opts.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => opts.json, text: async () => opts.text ?? "" };
  }) as unknown as typeof fetch;
};

describe("AnthropicNodeRunner truncation retry (W12)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.ANTHROPIC_API_KEY = "sk-test"; });
  afterEach(() => { resetRepositoryManager(); delete process.env.ANTHROPIC_API_KEY; });

  const truncatedNode = () => node({ modelConfig: { provider: "anthropic", model: "claude-opus-4-8", maxOutputTokens: 500 } } as Partial<WorkspaceNode>);

  it("provider-signaled truncation (stop_reason=max_tokens) once, then success: retries exactly once at double the cap and completes", async () => {
    const captured: Captured[] = [];
    const runner = new AnthropicNodeRunner(sequentialFetchStub([
      { json: messagesResponse({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 12, output_tokens: 500 } }) },
      { json: messagesResponse() }
    ], captured));
    const result = await runner.run({ node: truncatedNode(), input: {} }, context());

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    const secondBody = JSON.parse(captured[1]!.init.body as string);
    expect(secondBody.max_tokens).toBe(1000); // doubled from the node's configured 500
    // Both provider attempts were real charges. A retry must not hide its first, truncated attempt.
    const [usage] = await repositoryManager.getUsageRepository().list({ runId: "run_anthropic" });
    expect(usage).toMatchObject({ inputTokens: 24, outputTokens: 507, metadata: { attempt: 2, attemptsTotal: 2 } });
  });

  it("provider-signaled truncation twice in a row fails with code 'truncated', naming the node, the cap, and the operator remedy", async () => {
    const runner = new AnthropicNodeRunner(sequentialFetchStub([
      { json: messagesResponse({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 12, output_tokens: 500 } }) },
      { json: messagesResponse({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 12, output_tokens: 1000 } }) }
    ]));
    const result = await runner.run({ node: truncatedNode(), input: {} }, context());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("truncated");
    expect(result.message).toContain("anthropic_node");
    expect(result.message).toContain("1000");
    expect(result.message).toContain("modelConfig.maxOutputTokens");
    expect(result.details).toMatchObject({ nodeId: "anthropic_node", attempt: 2, cap: 1000, initialMaxOutputTokens: 500, outputTokens: 1000, retriedAtDoubledCap: true, providerSignal: true });
    // The terminal failure retains both paid attempts, not merely the final truncated response.
    const [usage] = await repositoryManager.getUsageRepository().list({ runId: "run_anthropic" });
    expect(usage).toMatchObject({ inputTokens: 24, outputTokens: 1500, status: "actual", metadata: { partial: true, failureCode: "truncated", attemptsTotal: 2 } });
  });

  it("fallback: no stop_reason=max_tokens, but no tool call and output at/near the cap — still classified as truncated (and still retried once)", async () => {
    const captured: Captured[] = [];
    const runner = new AnthropicNodeRunner(sequentialFetchStub([
      // stop_reason "end_turn" (not max_tokens) but no emit_output call and 480/500 tokens spent —
      // the fallback near-cap signal, mirroring the OpenAI runner's parse-failure-shape fallback with
      // the closest evidence THIS API actually exposes (Anthropic parses tool args server-side, so
      // there is no client-visible JSON.parse failure to key off).
      { json: messagesResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "ran out of room" }], usage: { input_tokens: 12, output_tokens: 480 } }) },
      { json: messagesResponse() }
    ], captured));
    const result = await runner.run({ node: truncatedNode(), input: {} }, context());

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    const secondBody = JSON.parse(captured[1]!.init.body as string);
    expect(secondBody.max_tokens).toBe(1000);
  });

  it("no tool call and output well UNDER the cap stays 'output_validation_failed', not 'truncated' (the near-cap safety gate)", async () => {
    const runner = new AnthropicNodeRunner(sequentialFetchStub([
      { json: messagesResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "short answer" }], usage: { input_tokens: 12, output_tokens: 5 } }) }
    ]));
    const result = await runner.run({ node: truncatedNode(), input: {} }, context());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("output_validation_failed");
    expect(result.code).not.toBe("truncated");
  });

  it("no modelConfig.maxOutputTokens configured: truncation is still classified against the runner's 4096-token default cap", async () => {
    const runner = new AnthropicNodeRunner(sequentialFetchStub([
      { json: messagesResponse({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 12, output_tokens: 4096 } }) },
      { json: messagesResponse({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 12, output_tokens: 8192 } }) }
    ]));
    const result = await runner.run({ node: node(), input: {} }, context()); // node() carries no maxOutputTokens

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("truncated");
    expect(result.details).toMatchObject({ initialMaxOutputTokens: 4096, cap: 8192, retriedAtDoubledCap: true });
  });
});

describe("AnthropicNodeRunner W6a budget reservations and attempt accounting", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.ANTHROPIC_API_KEY = "sk-test"; });
  afterEach(() => { resetRepositoryManager(); delete process.env.ANTHROPIC_API_KEY; });

  const budgetContext = (runId: string, budgetUsd: number): NodeRunnerContext => ({
    run: { runId, workflowId: "wf", projectId: "p", stageOutputs: {}, budgetUsd } as never,
    executionRepository: {} as never
  });
  const budgetedNode = (over: Partial<WorkspaceNode> = {}) => node({
    modelConfig: { provider: "anthropic", model: "claude-opus-4-8", maxOutputTokens: 500 },
    ...over
  } as Partial<WorkspaceNode>);

  it("refuses a doubled-cap truncation retry when the first attempt has already consumed the remaining run budget", async () => {
    const captured: Captured[] = [];
    const runner = new AnthropicNodeRunner(sequentialFetchStub([
      { json: messagesResponse({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 12, output_tokens: 500 } }) },
      { json: messagesResponse() }
    ], captured));
    const result = await runner.run({ node: budgetedNode(), input: {} }, budgetContext("run-budget-retry", 0.02));

    expect(result).toMatchObject({ ok: false, code: "budget_exceeded", details: { ceiling: "run" } });
    expect(captured).toHaveLength(1); // the unaffordable doubled-cap request never reached Anthropic
    const [usage] = await repositoryManager.getUsageRepository().list({ runId: "run-budget-retry" });
    expect(usage).toMatchObject({ inputTokens: 12, outputTokens: 500, status: "actual", metadata: { partial: true, failureCode: "budget_exceeded" } });
  });

  it("keeps known usage from a schema-invalid retry attempt when the later attempt succeeds", async () => {
    const runner = new AnthropicNodeRunner(sequentialFetchStub([
      { json: messagesResponse({ content: [{ type: "tool_use", name: "emit_output", input: { wrong: true } }], usage: { input_tokens: 100, output_tokens: 20 } }) },
      { json: messagesResponse({ usage: { input_tokens: 30, output_tokens: 8 } }) }
    ]));
    const result = await runner.run({ node: budgetedNode({ modelConfig: { provider: "anthropic", model: "claude-opus-4-8", maxOutputTokens: 500, retryCount: 1 } } as Partial<WorkspaceNode>), input: {} }, context());

    expect(result.ok).toBe(true);
    const [usage] = await repositoryManager.getUsageRepository().list({ runId: "run_anthropic" });
    expect(usage).toMatchObject({ inputTokens: 130, outputTokens: 28, status: "actual", metadata: { attempt: 2, attemptsTotal: 2 } });
  });

  it("does not let two concurrent Anthropic attempts reserve the same run-budget remainder", async () => {
    let resolveFirst: ((response: unknown) => void) | undefined;
    let startedFirst: (() => void) | undefined;
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        startedFirst?.();
        const response = await new Promise<unknown>((resolve) => { resolveFirst = resolve; });
        return response;
      }
      return { ok: true, status: 200, json: async () => messagesResponse(), text: async () => "" };
    }) as unknown as typeof fetch;
    const runner = new AnthropicNodeRunner(fetchImpl);
    const shared = budgetContext("run-budget-concurrent", 0.02);
    const first = runner.run({ node: budgetedNode(), input: {} }, shared);
    await new Promise<void>((resolve) => { startedFirst = resolve; });
    const second = await runner.run({ node: budgetedNode({ id: "anthropic_node_two" } as Partial<WorkspaceNode>), input: {} }, shared);

    expect(second).toMatchObject({ ok: false, code: "budget_exceeded", details: { ceiling: "run" } });
    expect(fetchCalls).toBe(1);
    resolveFirst?.({ ok: true, status: 200, json: async () => messagesResponse(), text: async () => "" });
    expect((await first).ok).toBe(true);
  });
});
