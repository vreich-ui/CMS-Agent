import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The in-loop budget guard, third generation. B3 checked the budget once before the loop; #95 H4
// listened to the SDK's agent_start hook — whose usage object stays empty while a node's own loop is
// running, so the accrued-spend term never grew and artifact_plan carried a $3 run ceiling to 138%
// in one dispatch (run_1785435947311_jl8hl4, $1.95 / 386K input tokens for one node). The guard now
// wraps the Model itself: every model request is gated BEFORE it is sent, using the request's own
// prospective size plus ACTUAL usage accumulated from prior responses, and a failed node's real
// spend is recorded instead of vanishing from the ledger.
//
// The fake run() below simulates the SDK's loop faithfully at the only layer that matters to the
// guard: it calls agent.model.getResponse(...) once per turn with a growing conversation, exactly
// where the wrapper intercepts. Turn 1 is cheap; turn 2 returns expensive actual usage; turn 3's
// gate must then refuse before the request is sent.
const { runMock, innerModelCalls } = vi.hoisted(() => {
  const innerCalls: Array<{ inputChars: number }> = [];
  return {
    innerModelCalls: innerCalls,
    runMock: vi.fn(async (agent: any, prompt: string) => {
      const model = agent.config.model;
      // No budget => the runner leaves the default provider's plain model-name STRING in place and
      // the SDK would resolve it internally; this fake only walks the turn loop through a wrapped
      // Model object.
      if (typeof model !== "string") {
        // Turn 1: the initial prompt.
        await model.getResponse({ input: prompt });
        // Turn 2: conversation grew (a big tool result entered it).
        await model.getResponse({ input: prompt + "x".repeat(20_000) });
        // Turn 3: the guard should refuse this request before it spends anything.
        await model.getResponse({ input: prompt + "x".repeat(40_000) });
      }
      return { finalOutput: { artifact: "probe.v1", summary: "reached only without a budget ceiling" }, rawResponses: [{ usage: { inputTokens: 100, outputTokens: 50 } }], lastResponseId: "resp_final" };
    })
  };
});
vi.mock("@openai/agents", () => ({
  Agent: class { config: unknown; constructor(config: unknown) { this.config = config; } },
  run: (...args: unknown[]) => runMock(...(args as [any, string])),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} },
  OpenAIProvider: class {
    async getModel(name?: string) {
      return {
        name,
        async getResponse(request: { input: string }) {
          innerModelCalls.push({ inputChars: JSON.stringify(request.input ?? "").length });
          // Actual usage reported by the provider: turn 2 is the expensive one (100K in / 50K out
          // at gpt-5.5 placeholder pricing ≈ $1.25 — far past the ceilings used below).
          const expensive = innerModelCalls.length === 2;
          return { usage: { inputTokens: expensive ? 100_000 : 100, outputTokens: expensive ? 50_000 : 50 }, output: [] };
        },
        async *getStreamedResponse() {}
      } as any;
    }
  }
}));

import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const RESEARCH_DEPENDENCIES = { reader_insight: { artifact: "reader_insight.v1", summary: "Upstream reader insight." } };

// allowedTools:[] short-circuits tool resolution (OpenAINodeRunner.ts), so a synthetic node id not
// present in the workspace repository can still run through the runner directly.
const PROBE_NODE: WorkspaceNode = {
  id: "budget_probe", name: "Budget Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object", required: ["artifact", "summary"], properties: { artifact: { const: "probe.v1" }, summary: { type: "string" } } },
  modelConfig: {}
};

const makeRun = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run-budget-probe", workflowId: "independent_node", projectId: "workspace", status: "running",
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai", ...overrides
});

describe("in-loop budget circuit breaker (B3)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); innerModelCalls.length = 0; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("aborts mid-node with a distinct budget_exceeded, not discovered only after the node finishes", async () => {
    const result: any = await executeNode({ nodeId: "research", input: {}, dependencyOutputs: RESEARCH_DEPENDENCIES, executionMode: "openai", modelConfig: { budgetUsd: 0.2 } });

    expect(result.execution.status).toBe("failed");
    const [code, message] = result.execution.nodes[0].errors as [string, string];
    expect(code).toBe("budget_exceeded");
    expect(message).toMatch(/before the model turn that would cross/i);
    // The guard refused turn 3's request BEFORE it reached the provider: turn 2's actual usage
    // ($1.25-ish) had already crossed the $0.2 ceiling, so only two inner model calls exist.
    expect(innerModelCalls).toHaveLength(2);
  });

  it("aborts mid-node on the RUN's budgetUsd even when the node has no budgetUsd of its own", async () => {
    const runner = new OpenAINodeRunner();
    const result = await runner.run(
      { node: PROBE_NODE, input: {} },
      { run: makeRun({ budgetUsd: 0.5 }), executionRepository: repositoryManager.getExecutionRepository() }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("budget_exceeded");
    expect((result.details as { stage?: string }).stage).toBe("mid_loop");
    expect(innerModelCalls).toHaveLength(2);
  });

  it("records the aborted node's REAL spend in the usage ledger instead of losing it", async () => {
    const runner = new OpenAINodeRunner();
    const run = makeRun({ budgetUsd: 0.5 });
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    const records = await repositoryManager.getUsageRepository().list({ runId: run.runId });
    // One partial "actual" record carrying the two completed turns' usage — previously a failed
    // node recorded NOTHING, which is how a 138% overshoot could hide from the run ledger.
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("actual");
    expect(records[0].inputTokens).toBe(100_100);
    expect(records[0].outputTokens).toBe(50_050);
    expect(records[0].metadata).toMatchObject({ partial: true, failureCode: "budget_exceeded" });
  });

  it("does not engage the guard when no budget is configured anywhere", async () => {
    const runner = new OpenAINodeRunner();
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });
    // Without a ceiling the node completes, the default provider path keeps the plain model-name
    // string (never resolved into a wrapped Model), and no gated calls were recorded.
    expect(result.ok).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(innerModelCalls).toHaveLength(0);
  });
});
