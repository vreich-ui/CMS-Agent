import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Provider-error-details (2026-08-29 incident): OpenAI returned 429 credit_balance_exhausted; it
// surfaced as budget_exceeded on the run and a generic "service unavailable" in the chat — an hour
// was lost hunting a code bug that was actually an empty provider wallet. These tests pin the fixture
// from that incident against both model node runners: a 429 whose body names insufficient_quota /
// credit_balance_exhausted / billing must classify as provider_quota (never budget_exceeded, which is
// reserved for OUR OWN usd budget guard), any other 429 as provider_rate_limit, and every other status
// must keep behaving exactly as before.
const runMock = vi.fn();
vi.mock("@openai/agents", () => ({
  OpenAIProvider: class { async getModel(name?: string) { return { name, async getResponse() { return { usage: { inputTokens: 0, outputTokens: 0 }, output: [] }; }, async *getStreamedResponse() {} } as any; } },
  Agent: class { constructor(_config: any) {} },
  run: (...args: unknown[]) => runMock(...args),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
}));

import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import { AnthropicNodeRunner } from "../../../src/agent/execution/runners/AnthropicNodeRunner.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { NodeRunnerContext } from "../../../src/agent/execution/executionContext.js";

// The real fixture from the incident (an OpenAI-shaped 429 body — Anthropic's own shape is
// identical for this purpose: `{error:{type,code,message}}`).
const CREDIT_BALANCE_BODY = { type: "invalid_request_error", code: "credit_balance_exhausted", message: "Your credit balance is too low" };
const RATE_LIMIT_BODY = { type: "rate_limit_error", message: "Too many requests, please slow down" };

const OUTPUT_SCHEMA = { type: "object", required: ["summary"], additionalProperties: true, properties: { summary: { type: "string" } } };

// allowedTools:[] short-circuits tool resolution (see OpenAINodeRunner.ts), matching every other
// runner test that dispatches a synthetic, non-persisted node directly.
const PROBE_NODE: WorkspaceNode = {
  id: "provider_error_probe", name: "Provider Error Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: OUTPUT_SCHEMA, modelConfig: { retryCount: 0 }
};

const makeRun = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run-provider-error-probe", workflowId: "independent_node", projectId: "workspace", status: "running",
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai", ...overrides
});

// Mirrors the real openai SDK's RateLimitError shape (node_modules/openai/src/core/error.ts): a
// `status` and an `error` carrying the response body's UNWRAPPED `error` object — this is exactly
// what reaches OpenAINodeRunner's catch block, since agents-core's getResponseWithRetry re-throws it
// unmodified once it declines to retry.
class FakeProviderApiError extends Error {
  readonly status: number;
  readonly error: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "RateLimitError";
    this.status = status;
    this.error = body;
  }
}

describe("OpenAINodeRunner — provider HTTP error details", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockReset(); });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("classifies a 429 credit_balance_exhausted as provider_quota, never budget_exceeded", async () => {
    runMock.mockRejectedValue(new FakeProviderApiError(429, CREDIT_BALANCE_BODY, "429 Your credit balance is too low"));
    const runner = new OpenAINodeRunner();
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("provider_quota");
    expect(result.code).not.toBe("budget_exceeded");
    expect(result.providerStatus).toBe(429);
    expect(result.providerMessage).toContain("credit balance");
    expect(result.operatorAction).toContain("Top up");
  });

  it("classifies a plain 429 (no quota signal) as provider_rate_limit", async () => {
    runMock.mockRejectedValue(new FakeProviderApiError(429, RATE_LIMIT_BODY, "429 Too many requests, please slow down"));
    const runner = new OpenAINodeRunner();
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("provider_rate_limit");
    expect(result.providerStatus).toBe(429);
    expect(result.operatorAction).toContain("Wait and retry");
  });

  it("leaves a non-429 provider error exactly as model_error (leave every other code as is)", async () => {
    runMock.mockRejectedValue(new FakeProviderApiError(500, { message: "internal error" }, "500 internal error"));
    const runner = new OpenAINodeRunner();
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("model_error");
    expect(result.operatorAction).toBeUndefined();
  });

  it("still reports our OWN budget guard as budget_exceeded, with an operatorAction naming the ceiling", async () => {
    const runner = new OpenAINodeRunner();
    const result = await runner.run(
      { node: { ...PROBE_NODE, modelConfig: { retryCount: 0, budgetUsd: 0.0000001 } }, input: {} },
      { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("budget_exceeded");
    expect(result.operatorAction).toContain("Raise the budget or stop");
    expect(result.providerStatus).toBeUndefined();
  });
});

describe("AnthropicNodeRunner — provider HTTP error details", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.ANTHROPIC_API_KEY = "sk-test"; });
  afterEach(() => { delete process.env.ANTHROPIC_API_KEY; resetRepositoryManager(); });

  const node = (): WorkspaceNode => ({
    id: "anthropic_provider_error_probe", name: "Anthropic Provider Error Probe", description: "test", prompt: "Do the thing.",
    outputSchema: OUTPUT_SCHEMA, dependsOn: [], modelConfig: { provider: "anthropic", model: "claude-opus-4-8" }
  } as unknown as WorkspaceNode);
  const context: NodeRunnerContext = { run: { runId: "run_anthropic_probe", workflowId: "wf", projectId: "p", stageOutputs: {} } as never, executionRepository: {} as never };

  const fetchStub = (status: number, bodyObj: unknown) => (async () => ({
    ok: status >= 200 && status < 300, status,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj)
  })) as unknown as typeof fetch;

  it("classifies the same 429 credit_balance_exhausted fixture as provider_quota", async () => {
    const runner = new AnthropicNodeRunner(fetchStub(429, { error: CREDIT_BALANCE_BODY }));
    const result = await runner.run({ node: node(), input: {} }, context);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("provider_quota");
    expect(result.code).not.toBe("budget_exceeded");
    expect(result.providerStatus).toBe(429);
    expect(result.providerMessage).toContain("credit balance");
    expect(result.operatorAction).toContain("Top up");
  });

  it("classifies a plain 429 as provider_rate_limit", async () => {
    const runner = new AnthropicNodeRunner(fetchStub(429, { error: RATE_LIMIT_BODY }));
    const result = await runner.run({ node: node(), input: {} }, context);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("provider_rate_limit");
    expect(result.operatorAction).toContain("Wait and retry");
  });

  it("leaves a 500 exactly as model_error (unchanged, per the existing anthropicRunner.test.ts case)", async () => {
    const runner = new AnthropicNodeRunner(fetchStub(500, { error: { message: "server boom" } }));
    const result = await runner.run({ node: node(), input: {} }, context);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("model_error");
    expect(result.operatorAction).toBeUndefined();
  });
});
