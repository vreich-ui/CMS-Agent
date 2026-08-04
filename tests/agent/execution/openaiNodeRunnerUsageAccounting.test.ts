import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Session E: the OpenAI Agents SDK mocked the same way as the existing openaiNodeRunner.test.ts, but
// with a controllable sequence of run() results so a validation-failure-then-retry-then-succeed
// dispatch can be exercised deterministically.
let runResults: Array<() => { finalOutput: unknown; rawResponses: unknown[]; lastResponseId: string }> = [];
const runMock = vi.fn(async () => {
  const next = runResults.shift();
  if (!next) throw new Error("runMock called more times than results were queued");
  return next();
});
vi.mock("@openai/agents", () => ({
  OpenAIProvider: class { async getModel(name?: string) { return { name, async getResponse() { return { usage: { inputTokens: 0, outputTokens: 0 }, output: [] }; }, async *getStreamedResponse() {} } as any; } },
  Agent: class { constructor(_config: unknown) {} },
  run: (...args: unknown[]) => runMock(...(args as [])),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
}));

import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import { startDryRun, runNextNode, __test__ } from "../../../src/agent/workspace/executor.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { MODEL_PRICING_CATALOG_ASOF, MODEL_PRICING_CATALOG_VERSION } from "../../../src/agent/observability/modelUsage.js";

const validOutput = { artifact: "content_source.v1", summary: "Live OpenAI summary." };

describe("R-9: requestId is a per-run join key", () => {
  it("buildInitialRun mints a requestId, and resetRun preserves the SAME one across a rebuild", () => {
    const runA = __test__.buildInitialRun({ projectId: "proj-a", input: "x" }, []);
    expect(runA.requestId).toMatch(/^req_/);
    const runB = __test__.buildInitialRun({ projectId: "proj-a", input: "x" }, []);
    expect(runB.requestId).not.toBe(runA.requestId); // two different runs never share one

    // Same run, rebuilt (the resetRun path): passing the existing requestId through must keep it,
    // proving a reset restarts the SAME request rather than minting a new join key mid-flight.
    const rebuilt = __test__.buildInitialRun({ projectId: "proj-a", input: "x" }, [], runA.runId, runA.requestId);
    expect(rebuilt.requestId).toBe(runA.requestId);
    expect(rebuilt.runId).toBe(runA.runId);
  });

  it("every usage record a mock-mode conductor run produces carries the SAME requestId as the run", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "usage-proj", input: "Draft this" }, store);
    expect(started.requestId).toMatch(/^req_/);
    await runNextNode(started.runId, { executionRepository: store });
    await runNextNode(started.runId, { executionRepository: store });

    const records = await repositoryManager.getUsageRepository().list({ runId: started.runId });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.requestId === started.requestId)).toBe(true);
  });
});

describe("OpenAINodeRunner usage accounting (Session E)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); runResults = []; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("captures cachedInputTokens from the Responses API's input_tokens_details.cached_tokens shape", async () => {
    runResults = [() => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 500, outputTokens: 40, input_tokens_details: { cached_tokens: 300 } } }], lastResponseId: "resp_1" })];
    await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });

    const records = await repositoryManager.getUsageRepository().list({ nodeId: "input_triage" });
    expect(records).toHaveLength(1);
    expect(records[0].cachedInputTokens).toBe(300);
    expect(records[0].inputTokens).toBe(500);
  });

  it("stamps pricingAsOf and pricingCatalogVersion on every recorded usage record", async () => {
    runResults = [() => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 100, outputTokens: 20 } }], lastResponseId: "resp_1" })];
    await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });

    const [record] = await repositoryManager.getUsageRepository().list({ nodeId: "input_triage" });
    expect(record.pricingAsOf).toBe(MODEL_PRICING_CATALOG_ASOF);
    expect(record.pricingCatalogVersion).toBe(MODEL_PRICING_CATALOG_VERSION);
  });

  it("a validation-failure-then-retry-then-succeed dispatch records TOTAL tokens across both attempts, exactly once", async () => {
    // Attempt 1: schema-invalid finalOutput (missing required `artifact`), real tokens spent anyway.
    // Attempt 2: valid, real tokens spent again. Pre-fix this recorded ONLY attempt 2's 50 tokens,
    // silently dropping attempt 1's real 200.
    runResults = [
      () => ({ finalOutput: { summary: "missing the required artifact const" }, rawResponses: [{ usage: { inputTokens: 200, outputTokens: 30 } }], lastResponseId: "resp_1" }),
      () => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 50, outputTokens: 20 } }], lastResponseId: "resp_2" })
    ];
    // input_triage's canonical retryCount is whatever nodes.ts declares; force at least one retry so
    // this test does not depend on that value drifting. Use node.execute's modelConfig override.
    await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai", modelConfig: { retryCount: 1 } });

    const records = await repositoryManager.getUsageRepository().list({ nodeId: "input_triage" });
    // Exactly one record — not double-counted (one per attempt would be two records).
    expect(records).toHaveLength(1);
    // Exactly the sum of both attempts — not under-counted (attempt 1's real spend is not dropped).
    expect(records[0].inputTokens).toBe(250);
    expect(records[0].outputTokens).toBe(50);
    expect(records[0].status).toBe("actual");
    expect(records[0].metadata?.attempt).toBe(2);
    expect(records[0].metadata?.attemptsTotal).toBe(2);
    expect(records[0].metadata?.turnCount).toBe(2);
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("a dispatch that succeeds on the first attempt records exactly that attempt's tokens (no accidental inflation)", async () => {
    runResults = [() => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 100, outputTokens: 20 } }], lastResponseId: "resp_1" })];
    await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });

    const records = await repositoryManager.getUsageRepository().list({ nodeId: "input_triage" });
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(100);
    expect(records[0].outputTokens).toBe(20);
    expect(records[0].metadata?.attempt).toBe(1);
    expect(records[0].metadata?.attemptsTotal).toBe(1);
  });
});

describe("Tracing policy: env-controlled, default OFF, safe metadata only (Session E)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); runResults = []; delete process.env.AGENT_TRACING_ENABLED; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; delete process.env.AGENT_TRACING_ENABLED; resetRepositoryManager(); });

  it("defaults to tracing disabled and carries no trace metadata when the env var is unset", async () => {
    runResults = [() => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 10, outputTokens: 5 } }], lastResponseId: "resp_1" })];
    await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });

    const [, , options] = runMock.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
    expect(options.tracingDisabled).toBe(true);
    expect(options).not.toHaveProperty("traceMetadata");
    expect(options).not.toHaveProperty("workflowName");
  });

  it("when explicitly enabled, carries only the five named safe fields — never the node's own input/output", async () => {
    process.env.AGENT_TRACING_ENABLED = "true";
    runResults = [() => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 10, outputTokens: 5 } }], lastResponseId: "resp_1" })];
    const result: any = await executeNode({ nodeId: "input_triage", input: { secretLookingField: "not actually a secret, just content" }, executionMode: "openai" });
    expect(result.execution.status).toBe("completed");

    const [, , options] = runMock.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
    expect(options.tracingDisabled).toBe(false);
    expect(typeof options.workflowName).toBe("string");
    const metadata = options.traceMetadata as Record<string, string>;
    expect(Object.keys(metadata).sort()).toEqual(["attempt", "executionMode", "nodeId", "projectId", "runId"]);
    expect(JSON.stringify(metadata)).not.toContain("secretLookingField");
  });

  it("any non-'true' value keeps tracing off (fail closed, not fail open, on a misconfigured env var)", async () => {
    process.env.AGENT_TRACING_ENABLED = "1";
    runResults = [() => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 10, outputTokens: 5 } }], lastResponseId: "resp_1" })];
    await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });

    const [, , options] = runMock.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
    expect(options.tracingDisabled).toBe(true);
  });
});
