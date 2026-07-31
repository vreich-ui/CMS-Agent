import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// G4 (T-2 re-run, run_1785405350649_9u5mjz), carried into the model-wrapper guard: accrued spend
// alone only accounts for turns ALREADY completed, so on its own the guard can only ever stop the
// turn AFTER the one that crossed the ceiling. The gate must therefore also reserve for the request
// it is about to send — estimated from that request's own input plus the node's configured
// maxOutputTokens — and refuse when accrued + prospective would cross, BEFORE the request reaches
// the provider. This is what stops a node whose conversation has ballooned (re-sent whole on every
// turn) from paying for one more giant turn that the ledger only notices afterwards.
const { runMock, innerModelCalls } = vi.hoisted(() => {
  const innerCalls: Array<{ inputChars: number }> = [];
  return {
    innerModelCalls: innerCalls,
    runMock: vi.fn(async (agent: any, prompt: string) => {
      const model = agent.config.model;
      if (typeof model !== "string") {
        // Turn 1: small request, tiny actual usage — accrued spend stays far under the ceiling.
        await model.getResponse({ input: prompt });
        // Turn 2: the conversation has ballooned; this request ALONE would cross the ceiling.
        // The guard must refuse it here, not after it runs.
        await model.getResponse({ input: "x".repeat(2_000_000) });
      }
      return { finalOutput: { artifact: "probe.v1", summary: "should never be reached" }, rawResponses: [], lastResponseId: "resp_never" };
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
          return { usage: { inputTokens: 100, outputTokens: 50 }, output: [] };
        },
        async *getStreamedResponse() {}
      } as any;
    }
  }
}));

import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const PROBE_NODE: WorkspaceNode = {
  id: "prospective_probe", name: "Prospective Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object", required: ["artifact", "summary"], properties: { artifact: { const: "probe.v1" }, summary: { type: "string" } } },
  modelConfig: {}
};

const makeRun = (): WorkflowExecutionRecord => ({
  runId: "run-prospective-probe", workflowId: "independent_node", projectId: "workspace", status: "running",
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai", budgetUsd: 1
});

describe("in-loop budget circuit breaker reserves against the UPCOMING turn's own size (G4)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); innerModelCalls.length = 0; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("aborts BEFORE the turn whose own prospective size would cross the ceiling, not just the turn after it", async () => {
    const runner = new OpenAINodeRunner();
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("budget_exceeded");
    // Accrued spend after turn 1 is ~150 tokens (≈ $0.001) — nowhere near the $1 ceiling. Only the
    // PROSPECTIVE size of turn 2's own request (~500K input tokens ≈ $2.50) crosses it, so refusing
    // proves the reservation, not the accrual. Exactly one request reached the provider.
    expect(innerModelCalls).toHaveLength(1);
    const details = result.details as { prospectiveTurnUsd: number; spentUsdEstimate: number };
    expect(details.prospectiveTurnUsd).toBeGreaterThan(1);
    expect(details.spentUsdEstimate).toBeLessThan(0.1);
  });
});
