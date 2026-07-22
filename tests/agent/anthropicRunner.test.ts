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
