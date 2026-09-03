import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// C4 — node runner image support (BRIEF 3.9). Runner-level integration: each runner (Anthropic,
// OpenAI, Mock) builds `content: [...imageBlocks, <text block>]` from a node's input.imageRefs, and
// imageRefs is stripped out of the JSON text carrying the rest of the input. The hard requirement —
// the outgoing request body is byte-identical to today's when no imageRefs are present — is pinned
// with a literal deep-equal against a fixed baseline captured from the pre-C4 runner behavior, so a
// future shape change to either runner trips this test.

const OUTPUT_SCHEMA = { type: "object", required: ["summary"], additionalProperties: true, properties: { summary: { type: "string" } } };
const PNG_A = { base64: "QQ==", mediaType: "image/png" as const, label: "before" };
const PNG_B = { base64: "Qg==", mediaType: "image/png" as const, label: "after" };

// ---------------------------------------------------------------------------------------------
// AnthropicNodeRunner
// ---------------------------------------------------------------------------------------------
import { AnthropicNodeRunner } from "../../../src/agent/execution/runners/AnthropicNodeRunner.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { NodeRunnerContext } from "../../../src/agent/execution/executionContext.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const anthropicNode = (): WorkspaceNode => ({
  id: "anthropic_node", name: "Anthropic Node", description: "test", prompt: "Do the thing.",
  outputSchema: OUTPUT_SCHEMA, dependsOn: [], modelConfig: { provider: "anthropic", model: "claude-opus-4-8" }
} as unknown as WorkspaceNode);
const anthropicContext = (): NodeRunnerContext => ({ run: { runId: "run_anthropic", workflowId: "wf", projectId: "p", stageOutputs: {} } as never, executionRepository: {} as never });

type Captured = { url: string; init: RequestInit };
// Distinguishes the Messages API call (JSON body) from an image fetch (no JSON body) so a single
// fetchImpl double can serve both without the image fetch being mistaken for the model call.
const anthropicFetchStub = (opts: { imageBytes?: Record<string, Uint8Array>; imageStatus?: Record<string, number> } = {}, captured: Captured[] = []) =>
  (async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    if (url === "https://api.anthropic.com/v1/messages") {
      return {
        ok: true, status: 200,
        json: async () => ({ id: "msg_1", stop_reason: "tool_use", content: [{ type: "tool_use", name: "emit_output", input: { summary: "done" } }], usage: { input_tokens: 12, output_tokens: 7 } }),
        text: async () => ""
      };
    }
    // Image fetch.
    const status = opts.imageStatus?.[url] ?? 200;
    const bytes = opts.imageBytes?.[url] ?? new Uint8Array([9, 9]);
    return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.buffer, text: async () => "" };
  }) as unknown as typeof fetch;

describe("AnthropicNodeRunner — imageRefs", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.ANTHROPIC_API_KEY = "sk-test"; });
  afterEach(() => { resetRepositoryManager(); delete process.env.ANTHROPIC_API_KEY; });

  it("HARD REQUIREMENT: no imageRefs -> the request body is byte-identical to the pre-C4 baseline", async () => {
    const captured: Captured[] = [];
    const runner = new AnthropicNodeRunner(anthropicFetchStub({}, captured));
    await runner.run({ node: anthropicNode(), input: { question: "hi" } }, anthropicContext());

    const body = JSON.parse(captured[0]!.init.body as string);
    // Captured verbatim (via a throwaway instrumented run) from AnthropicNodeRunner.ts BEFORE the C4
    // imageRefs change was applied. Any change to this shape for a no-imageRefs dispatch fails here.
    expect(body).toEqual({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      system: "You are the CMS-Agent node runner running natively on Claude.\nNode: Anthropic Node (anthropic_node)\nDescription: test\nNode prompt:\nDo the thing.\nAssigned dependencies and memory are provided in the user message. Never reveal secrets.\nReturn your result by calling the emit_output tool exactly once with a value matching its schema.",
      messages: [{ role: "user", content: "{\"input\":{\"question\":\"hi\"},\"dependencyOutputs\":{},\"outputSchema\":{\"type\":\"object\",\"required\":[\"summary\"],\"additionalProperties\":true,\"properties\":{\"summary\":{\"type\":\"string\"}}}}" }],
      tools: [{ name: "emit_output", description: "Emit this node's structured output. Call exactly once with the full result matching the schema.", input_schema: OUTPUT_SCHEMA }],
      tool_choice: { type: "tool", name: "emit_output" }
    });
    // content stayed a plain STRING, not an array — the no-refs path never wraps it.
    expect(typeof body.messages[0].content).toBe("string");
  });

  it("2 refs -> 2 image blocks + 1 text block, in that order, and no imageRefs key inside the text JSON", async () => {
    const captured: Captured[] = [];
    const runner = new AnthropicNodeRunner(anthropicFetchStub({}, captured));
    const result = await runner.run({ node: anthropicNode(), input: { question: "hi", imageRefs: [PNG_A, PNG_B] } }, anthropicContext());

    expect(result.ok).toBe(true);
    const body = JSON.parse(captured[0]!.init.body as string);
    const content = body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "Qg==" } });
    expect(content[2].type).toBe("text");
    const textJson = JSON.parse(content[2].text);
    expect(textJson.input).toEqual({ question: "hi" }); // imageRefs stripped
    expect(textJson.input).not.toHaveProperty("imageRefs");
    expect(JSON.stringify(textJson)).not.toContain("imageRefs");
  });

  it("an oversize ref is dropped with a warning and the call still succeeds", async () => {
    const oversizeUrl = "https://example.com/huge.png";
    const fetchImpl = anthropicFetchStub({ imageBytes: { [oversizeUrl]: new Uint8Array(1572864 + 10) } });
    const runner = new AnthropicNodeRunner(fetchImpl);
    const result: any = await runner.run({ node: anthropicNode(), input: { question: "hi", imageRefs: [{ url: oversizeUrl, mediaType: "image/png", label: "huge" }] } }, anthropicContext());

    expect(result.ok).toBe(true);
    expect(result.trace.imageRefs).toMatchObject({ included: 0, dropped: 1 });
    expect(result.trace.imageRefs.warnings[0].reason).toContain("oversize");
  });

  it("a fetch that times out is dropped with a warning, node still succeeds", async () => {
    vi.useFakeTimers();
    try {
      const captured: Captured[] = [];
      const slowUrl = "https://example.com/slow.png";
      const fetchImpl = (async (url: string, init: RequestInit) => {
        captured.push({ url, init });
        if (url === "https://api.anthropic.com/v1/messages") {
          return { ok: true, status: 200, json: async () => ({ id: "msg_1", stop_reason: "tool_use", content: [{ type: "tool_use", name: "emit_output", input: { summary: "done" } }], usage: { input_tokens: 1, output_tokens: 1 } }), text: async () => "" };
        }
        return new Promise((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted"))); });
      }) as unknown as typeof fetch;
      const runner = new AnthropicNodeRunner(fetchImpl);

      const pending = runner.run({ node: anthropicNode(), input: { question: "hi", imageRefs: [{ url: slowUrl, mediaType: "image/png", label: "slow" }] } }, anthropicContext());
      await vi.advanceTimersByTimeAsync(10000);
      const result: any = await pending;

      expect(result.ok).toBe(true);
      expect(result.trace.imageRefs).toMatchObject({ included: 0, dropped: 1 });
      expect(result.trace.imageRefs.warnings[0].reason).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("9 refs -> truncated to 8 (not rejected): the node still runs with the first 8", async () => {
    const refs = Array.from({ length: 9 }, (_, i) => ({ base64: "QQ==", mediaType: "image/png" as const, label: `r${i}` }));
    const runner = new AnthropicNodeRunner(anthropicFetchStub());
    const result: any = await runner.run({ node: anthropicNode(), input: { imageRefs: refs } }, anthropicContext());

    expect(result.ok).toBe(true);
    expect(result.trace.imageRefs.included).toBe(8);
    expect(result.trace.imageRefs.dropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// OpenAINodeRunner
// ---------------------------------------------------------------------------------------------
describe("OpenAINodeRunner — imageRefs", () => {
  let runMock: ReturnType<typeof vi.fn>;
  let OpenAINodeRunner: typeof import("../../../src/agent/execution/runners/OpenAINodeRunner.js").OpenAINodeRunner;

  beforeEach(async () => {
    vi.resetModules();
    resetRepositoryManager();
    process.env.OPENAI_API_KEY = "test-key";
    runMock = vi.fn(async () => ({
      finalOutput: { artifact: "content_source.v1", summary: "ok" },
      rawResponses: [{ usage: { inputTokens: 10, outputTokens: 5 } }],
      lastResponseId: "resp_test"
    }));
    vi.doMock("@openai/agents", () => ({
      OpenAIProvider: class { async getModel(name?: string) { return { name, async getResponse() { return { usage: { inputTokens: 0, outputTokens: 0 }, output: [] }; }, async *getStreamedResponse() {} } as any; } },
      Agent: class { constructor(_config: unknown) {} },
      run: (...args: unknown[]) => runMock(...(args as [])),
      tool: (definition: unknown) => definition,
      OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
    }));
    ({ OpenAINodeRunner } = await import("../../../src/agent/execution/runners/OpenAINodeRunner.js"));
  });
  afterEach(() => { resetRepositoryManager(); delete process.env.OPENAI_API_KEY; vi.doUnmock("@openai/agents"); });

  const node = (): WorkspaceNode => ({
    id: "input_triage", name: "Triage", description: "test", prompt: "Do the thing.",
    outputSchema: { type: "object", required: ["artifact", "summary"], additionalProperties: true, properties: { artifact: { const: "content_source.v1" }, summary: { type: "string", minLength: 1 } } },
    dependsOn: [], modelConfig: {}, allowedTools: []
  } as unknown as WorkspaceNode);
  const context = (): NodeRunnerContext => ({ run: { runId: "run_openai", workflowId: "wf", projectId: "p", stageOutputs: {} } as never, executionRepository: {} as never });

  it("HARD REQUIREMENT: no imageRefs -> the run() prompt argument is byte-identical to the pre-C4 baseline (a plain string)", async () => {
    const runner = new OpenAINodeRunner();
    await runner.run({ node: node(), input: { question: "hi" } }, context());

    const promptArg = runMock.mock.calls[0]![1];
    // Captured verbatim from OpenAINodeRunner.ts BEFORE the C4 imageRefs change.
    expect(promptArg).toBe("{\"input\":{\"question\":\"hi\"},\"dependencyOutputs\":{},\"outputSchema\":{\"type\":\"object\",\"required\":[\"artifact\",\"summary\"],\"additionalProperties\":true,\"properties\":{\"artifact\":{\"const\":\"content_source.v1\"},\"summary\":{\"type\":\"string\",\"minLength\":1}}}}");
    expect(typeof promptArg).toBe("string");
  });

  it("2 refs -> run() receives a message array with 2 image blocks + 1 text block, in that order, and no imageRefs key inside the text JSON", async () => {
    const runner = new OpenAINodeRunner(anthropicFetchStubForOpenAI());
    const result = await runner.run({ node: node(), input: { question: "hi", imageRefs: [PNG_A, PNG_B] } }, context());

    expect(result.ok).toBe(true);
    const promptArg = runMock.mock.calls[0]![1] as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(Array.isArray(promptArg)).toBe(true);
    const content = promptArg[0]!.content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "input_image", image: "data:image/png;base64,QQ==" });
    expect(content[1]).toEqual({ type: "input_image", image: "data:image/png;base64,Qg==" });
    expect(content[2]!.type).toBe("input_text");
    const textJson = JSON.parse(content[2]!.text!);
    expect(textJson.input).toEqual({ question: "hi" });
    expect(JSON.stringify(textJson)).not.toContain("imageRefs");
  });

  it("an oversize ref is dropped with a warning and the node still succeeds", async () => {
    const url = "https://example.com/huge.png";
    const fetchImpl = (async (u: string) => {
      if (u === url) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1572864 + 10) };
      throw new Error("unexpected fetch: " + u);
    }) as unknown as typeof fetch;
    const runner = new OpenAINodeRunner(fetchImpl);
    const result: any = await runner.run({ node: node(), input: { question: "hi", imageRefs: [{ url, mediaType: "image/png", label: "huge" }] } }, context());

    expect(result.ok).toBe(true);
    expect(result.trace.imageRefs).toMatchObject({ included: 0, dropped: 1 });
    expect(result.trace.imageRefs.warnings[0].reason).toContain("oversize");
    // The image fetch failure never reaches run() as an image block.
    const promptArg = runMock.mock.calls[0]![1];
    expect(promptArg).toBe(JSON.stringify({ input: { question: "hi" }, dependencyOutputs: {}, outputSchema: node().outputSchema }));
  });

  it("a fetch that times out is dropped with a warning", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (async (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      })) as unknown as typeof fetch;
      const runner = new OpenAINodeRunner(fetchImpl);

      const pending = runner.run({ node: node(), input: { imageRefs: [{ url: "https://example.com/slow.png", mediaType: "image/png", label: "slow" }] } }, context());
      await vi.advanceTimersByTimeAsync(10000);
      const result: any = await pending;

      expect(result.ok).toBe(true);
      expect(result.trace.imageRefs).toMatchObject({ included: 0, dropped: 1 });
      expect(result.trace.imageRefs.warnings[0].reason).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("9 refs -> truncated to 8, node still runs", async () => {
    const refs = Array.from({ length: 9 }, (_, i) => ({ base64: "QQ==", mediaType: "image/png" as const, label: `r${i}` }));
    const runner = new OpenAINodeRunner();
    const result: any = await runner.run({ node: node(), input: { imageRefs: refs } }, context());

    expect(result.ok).toBe(true);
    expect(result.trace.imageRefs).toMatchObject({ included: 8, dropped: 1 });
  });

  function anthropicFetchStubForOpenAI(): typeof fetch {
    return (async () => { throw new Error("should not be called for inline base64 refs"); }) as unknown as typeof fetch;
  }
});

// ---------------------------------------------------------------------------------------------
// MockNodeRunner
// ---------------------------------------------------------------------------------------------
import { MockNodeRunner } from "../../../src/agent/execution/runners/MockNodeRunner.js";

describe("MockNodeRunner — imageRefs", () => {
  const mockNode: WorkspaceNode = { id: "n", name: "N", kind: "test", description: "", prompt: "", inputSchema: {}, outputSchema: { type: "object", properties: { summary: { type: "string" } } }, allowedTools: [], requiredInputs: [], produces: ["x"], riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: new Date().toISOString() } as unknown as WorkspaceNode;
  const mockContext: NodeRunnerContext = { run: { runId: "r", workflowId: "w", projectId: "p", status: "running", startedAt: "", updatedAt: "", nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true } as never, executionRepository: {} as never };

  it("HARD REQUIREMENT: no imageRefs -> output unchanged and no trace.content added (identical to today's mock output)", async () => {
    const runner = new MockNodeRunner();
    const withoutFeature: any = await runner.run({ node: mockNode, input: { question: "hi" } }, mockContext);
    const bareResult: any = await runner.run({ node: mockNode, input: { question: "hi" } }, mockContext);
    expect(withoutFeature.ok).toBe(true);
    expect(withoutFeature.output).toEqual(bareResult.output);
    expect(withoutFeature.trace).toBeUndefined();
  });

  it("2 refs -> trace.content has 2 image blocks + 1 text block, in that order, no imageRefs key in text JSON; output untouched", async () => {
    const runner = new MockNodeRunner();
    const result: any = await runner.run({ node: mockNode, input: { question: "hi", imageRefs: [PNG_A, PNG_B] } }, mockContext);

    expect(result.ok).toBe(true);
    expect(result.trace.content).toHaveLength(3);
    expect(result.trace.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } });
    expect(result.trace.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "Qg==" } });
    expect(result.trace.content[2].type).toBe("text");
    const textJson = JSON.parse(result.trace.content[2].text);
    expect(textJson).toEqual({ question: "hi" });
  });

  it("an oversize ref is dropped with a warning; the node still succeeds with its normal mock output", async () => {
    const runner = new MockNodeRunner();
    const oversizeBase64 = Buffer.alloc(1572864 + 10).toString("base64");
    const result: any = await runner.run({ node: mockNode, input: { imageRefs: [{ base64: oversizeBase64, mediaType: "image/png", label: "huge" }] } }, mockContext);

    expect(result.ok).toBe(true);
    expect(result.trace.imageRefs).toMatchObject({ included: 0, dropped: 1 });
  });

  it("a fetch that times out is dropped with a warning", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (async (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      })) as unknown as typeof fetch;
      const runner = new MockNodeRunner(fetchImpl);
      const pending = runner.run({ node: mockNode, input: { imageRefs: [{ url: "https://example.com/slow.png", mediaType: "image/png" }] } }, mockContext);
      await vi.advanceTimersByTimeAsync(10000);
      const result: any = await pending;

      expect(result.ok).toBe(true);
      expect(result.trace.imageRefs).toMatchObject({ included: 0, dropped: 1 });
      expect(result.trace.imageRefs.warnings[0].reason).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("9 refs -> truncated to 8", async () => {
    const refs = Array.from({ length: 9 }, (_, i) => ({ base64: "QQ==", mediaType: "image/png" as const, label: `r${i}` }));
    const runner = new MockNodeRunner();
    const result: any = await runner.run({ node: mockNode, input: { imageRefs: refs } }, mockContext);

    expect(result.ok).toBe(true);
    expect(result.trace.imageRefs).toMatchObject({ included: 8, dropped: 1 });
  });
});
