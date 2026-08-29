import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// W12 — the OpenAI Agents SDK's own errorHandlers.invalidFinalOutput hook is how OpenAINodeRunner
// learns WHY a run() call threw its "Invalid output type: ..." ModelBehaviorError (see the DETECTION
// comment above providerSignalsTruncation in OpenAINodeRunner.ts): the SDK calls that handler with
// `runData.rawResponses` BEFORE throwing, and a handler returning undefined declines to override the
// outcome, so the SDK still throws exactly as it would with no handler at all. This mock plays that
// exact contract: a queued attempt that should look truncated invokes `options.errorHandlers
// .invalidFinalOutput({ runData: { rawResponses: [...] } })` and then throws the same message shape
// real SDK runs surface, instead of resolving.
type QueuedAttempt = (options: { errorHandlers?: { invalidFinalOutput?: (input: unknown) => unknown } }) =>
  { finalOutput: unknown; rawResponses: unknown[]; lastResponseId: string };

let runResults: QueuedAttempt[] = [];
const runMock = vi.fn(async (_agent: unknown, _prompt: unknown, options: any) => {
  const next = runResults.shift();
  if (!next) throw new Error("runMock called more times than results were queued");
  return next(options);
});
// Captures every Agent(...) construction's config, in order — this is how the test PROVES the SDK-
// behavior finding: OpenAINodeRunner mutates the SAME modelSettings object in place for a truncation
// retry rather than reconstructing the Agent (agents-core's agent.js:87-89 assigns modelSettings by
// REFERENCE, and run.js:1013-1031's #prepareModelCall reads `executionAgent.modelSettings` fresh on
// every run() call — see OpenAINodeRunner.ts's header comment for the full citation). If the runner
// ever regresses to reconstructing a new Agent per attempt, agentConstructions.length would grow past
// 1 in the "retries once then succeeds" case below.
const agentConstructions: Array<{ modelSettings?: { maxTokens?: number } }> = [];
vi.mock("@openai/agents", () => ({
  OpenAIProvider: class { async getModel(name?: string) { return { name, async getResponse() { return { usage: { inputTokens: 0, outputTokens: 0 }, output: [] }; }, async *getStreamedResponse() {} } as any; } },
  Agent: class { constructor(config: any) { agentConstructions.push(config); } },
  run: (...args: unknown[]) => runMock(...(args as [unknown, unknown, unknown])),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
}));

import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const validOutput = { artifact: "content_source.v1", summary: "Live OpenAI summary." };
// Generous headroom so these tests exercise ONLY the truncation-retry logic, never the (unrelated)
// per-node budget guard input_triage's canonical modelConfig also carries.
const BASE_MODEL_CONFIG = { retryCount: 0, budgetUsd: 1000 };

// allowedTools:[] short-circuits tool resolution (OpenAINodeRunner.ts), so a synthetic node id not
// present in the workspace repository can still run through the runner directly — same pattern
// openaiNodeRunnerBudgetGuard.test.ts uses, and for the same reason: it isolates the truncation-retry
// logic from every canonical node's own modelConfig (budgetUsd, retryCount, maxOutputTokens).
const PROBE_NODE: WorkspaceNode = {
  id: "truncation_probe", name: "Truncation Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object", required: ["artifact", "summary"], properties: { artifact: { const: "probe.v1" }, summary: { type: "string" } } },
  modelConfig: { maxOutputTokens: 500 }
};

const makeRun = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run-truncation-probe", workflowId: "independent_node", projectId: "workspace", status: "running",
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai", ...overrides
});

// Simulates the SDK: tap the invalidFinalOutput handler with a raw response carrying `providerData`/
// `usage`, then throw the same message shape a real truncated Responses API call produces.
const truncatedAttempt = (outputTokens: number, opts: { providerSignal?: boolean } = {}): QueuedAttempt =>
  (options) => {
    const rawResponse = {
      usage: { outputTokens },
      providerData: opts.providerSignal === false
        ? {}
        : { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
    };
    options.errorHandlers?.invalidFinalOutput?.({ runData: { rawResponses: [rawResponse] } });
    throw new Error("Invalid output type: Unterminated string in JSON at position 12345");
  };

const succeedAttempt = (): QueuedAttempt => () => ({ finalOutput: validOutput, rawResponses: [{ usage: { inputTokens: 50, outputTokens: 20 } }], lastResponseId: "resp_ok" });

describe("OpenAINodeRunner truncation retry (W12)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); runResults = []; agentConstructions.length = 0; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("provider-signaled truncation once, then success: retries exactly once at double the cap, on the SAME Agent instance, and completes", async () => {
    runResults = [truncatedAttempt(500), succeedAttempt()];
    const result: any = await executeNode({
      nodeId: "input_triage", input: {}, executionMode: "openai",
      modelConfig: { ...BASE_MODEL_CONFIG, maxOutputTokens: 500 }
    });

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(result.execution.status).toBe("completed");
    expect(result.execution.nodes[0].output).toEqual(validOutput);

    // Exactly one Agent was constructed for the whole dispatch (mutated in place for the retry, not
    // reconstructed) — see the SDK-behavior finding above agentConstructions.
    expect(agentConstructions).toHaveLength(1);
    // And by the time both run() calls have happened, that ONE Agent's modelSettings object reflects
    // the doubled cap: proof the mutation is visible to the SAME agent.modelSettings reference the SDK
    // reads fresh on each run() call (run.js's #prepareModelCall), not a stale snapshot taken at
    // construction.
    expect(agentConstructions[0].modelSettings?.maxTokens).toBe(1000);
  });

  it("provider-signaled truncation twice in a row fails with code 'truncated', not the generic 'Invalid output type' model_error", async () => {
    runResults = [truncatedAttempt(500), truncatedAttempt(1000)];
    const result: any = await executeNode({
      nodeId: "input_triage", input: {}, executionMode: "openai",
      modelConfig: { ...BASE_MODEL_CONFIG, maxOutputTokens: 500 }
    });

    expect(runMock).toHaveBeenCalledTimes(2); // one ordinary attempt + exactly one doubled-cap retry
    expect(agentConstructions).toHaveLength(1); // still the same Agent, mutated twice
    expect(result.execution.status).toBe("failed");
    const [code, message] = result.execution.nodes[0].errors as [string, string];
    expect(code).toBe("truncated");
    // Names the node, the cap tried, and tells the operator to raise modelConfig.maxOutputTokens —
    // not the SDK's generic "Invalid output type" string.
    expect(message).not.toContain("Invalid output type");
    expect(message).toContain("input_triage");
    expect(message).toContain("1000");
    expect(message).toContain("modelConfig.maxOutputTokens");
  });

  it("second truncation's returned result carries attempt, cap, and output tokens (why node_list_executions/node_get show a truncation)", async () => {
    const runner = new OpenAINodeRunner();
    runResults = [truncatedAttempt(500), truncatedAttempt(1000)];
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("truncated");
    expect(result.details).toMatchObject({
      nodeId: "truncation_probe",
      attempt: 2,
      cap: 1000,
      initialMaxOutputTokens: 500,
      outputTokens: 1000,
      retriedAtDoubledCap: true,
      providerSignal: true
    });
  });

  it("stays retryable via workflow_retry_node after a terminal truncation (not a hard-terminal outcome)", async () => {
    const { startDryRun, runNextNode, retryNode } = await import("../../../src/agent/workspace/executor.js");
    // Strip the canonical node's own $0.1 budgetUsd for this one test (its own worked example above
    // already covers the budget guard's own behavior) so the doubled-cap retry's ~$0.12 reserve is
    // never confused with the ceiling this test is actually about.
    await repositoryManager.getWorkspaceRepository().updateNode("input_triage", { modelConfig: { maxTurns: 3, toolCallLimit: 2, timeout: 90000, maxOutputTokens: 500 } }, {});

    runResults = [truncatedAttempt(500), truncatedAttempt(1000)];
    const started: any = await startDryRun({ executionMode: "openai", projectId: "trunc-proj", input: "Draft this" });
    let run: any = await runNextNode(started.runId, {});
    const failedNode = run.nodes.find((n: any) => n.status === "failed");
    expect(failedNode?.errors?.[0]).toBe("truncated");
    expect(run.status).toBe("failed");

    // An operator raising modelConfig.maxOutputTokens and retrying is exactly workflow_retry_node —
    // it must still work: the failure must not have left the run in a non-retryable terminal state.
    runResults = [succeedAttempt()];
    run = await retryNode(started.runId, failedNode!.nodeId);
    const retried = run?.nodes.find((n: any) => n.nodeId === failedNode!.nodeId);
    expect(retried?.status).not.toBe("failed");
  });

  it("a malformed-JSON response well UNDER the configured cap stays 'model_error', not 'truncated'", async () => {
    const runner = new OpenAINodeRunner();
    runResults = [
      (options) => {
        // No provider truncation signal, and output tokens (5) are nowhere near the 500-token cap —
        // the near-cap safety gate must refuse to call this truncation even though the message shape
        // matches the same JSON-parse-failure pattern a real cutoff produces.
        options.errorHandlers?.invalidFinalOutput?.({ runData: { rawResponses: [{ usage: { outputTokens: 5 }, providerData: {} }] } });
        throw new Error("Invalid output type: Unterminated string in JSON at position 10");
      }
    ];
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });

    expect(runMock).toHaveBeenCalledTimes(1); // no truncation retry granted
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("model_error");
    expect(result.code).not.toBe("truncated");
    expect(result.message).toContain("Invalid output type");
  });

  it("no modelConfig.maxOutputTokens configured: truncation is still classified, with no retry to attempt (nothing to double)", async () => {
    const runner = new OpenAINodeRunner();
    const nodeWithoutCap: WorkspaceNode = { ...PROBE_NODE, modelConfig: {} };
    runResults = [truncatedAttempt(2000)];
    const result = await runner.run({ node: nodeWithoutCap, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("truncated");
    expect(result.message).toContain("modelConfig.maxOutputTokens");
    expect((result.details as { cap?: number }).cap).toBeUndefined();
  });
});
