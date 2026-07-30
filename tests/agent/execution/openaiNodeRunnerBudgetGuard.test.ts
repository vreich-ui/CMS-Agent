import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// B3 (T-2, run_1785340011864_qpyjr0): budgetUsd was only ever checked ONCE, before a node's agent
// loop started. The run set budgetUsd: 5 and finished at $5.26 (105.25% of budget, blocked: false)
// because nothing looked again until the run's between-node gate noticed afterward — one node had
// already spent the whole budget and overrun it by then. A Runner instance's `agent_start` hook
// fires once per model turn with the run's cumulative token usage so far, which is what lets the
// runner check the ceiling INSIDE the loop instead of only between nodes. This fake models exactly
// that: usage accrues across three simulated turns, cheap for the first two turns and then a large
// jump, so the circuit breaker can only ever trip at a turn BOUNDARY (it cannot preempt an in-flight
// turn) — at the start of turn 3, after turn 2's expensive usage has already accumulated.
const { fakeRunnerInstances, FakeRunnerClass, runMock } = vi.hoisted(() => {
  const instances: any[] = [];
  class FakeRunner {
    listeners: Record<string, Array<(...args: any[]) => void>> = {};
    on(event: string, cb: (...args: any[]) => void) { (this.listeners[event] ??= []).push(cb); return this; }
    async run(_agent: unknown, _prompt: unknown, options: any) {
      const usage = { inputTokens: 0, outputTokens: 0 };
      const emitStart = () => this.listeners.agent_start?.forEach((cb) => cb({ usage: { ...usage } }));
      const checkAborted = () => { if (options?.signal?.aborted) { const e = new Error("This operation was aborted."); e.name = "AbortError"; throw e; } };

      emitStart(); checkAborted();
      usage.inputTokens += 100; usage.outputTokens += 50; // turn 1: cheap

      emitStart(); checkAborted();
      usage.inputTokens += 100_000; usage.outputTokens += 50_000; // turn 2: the expensive one

      emitStart(); checkAborted(); // turn 3 start: cumulative usage now blows the budget — aborts here

      return { finalOutput: { artifact: "reader_insight.v1", summary: "should never be reached" }, rawResponses: [{ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }], lastResponseId: "resp_never" };
    }
  }
  return {
    fakeRunnerInstances: instances,
    FakeRunnerClass: FakeRunner,
    runMock: vi.fn(async (): Promise<any> => { throw new Error("plain run() should not be called when budgetUsd is configured"); })
  };
});
vi.mock("@openai/agents", () => ({
  Agent: class { constructor(_config: unknown) {} },
  run: (...args: unknown[]) => runMock(...(args as [])),
  Runner: class extends FakeRunnerClass { constructor() { super(); fakeRunnerInstances.push(this); } },
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
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
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); fakeRunnerInstances.length = 0; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("aborts mid-node with a distinct budget_exceeded, not discovered only after the node finishes", async () => {
    const result: any = await executeNode({ nodeId: "research", input: {}, dependencyOutputs: RESEARCH_DEPENDENCIES, executionMode: "openai", modelConfig: { budgetUsd: 0.05 } });

    expect(result.execution.status).toBe("failed");
    const [code, message] = result.execution.nodes[0].errors as [string, string];
    expect(code).toBe("budget_exceeded");
    expect(code).not.toBe("model_error");
    expect(code).not.toBe("cancelled");
    expect(message).toContain("research");
    expect(message).toContain("0.05");
    // A Runner instance (not the bare run() function) was used once budgetUsd was configured.
    expect(fakeRunnerInstances).toHaveLength(1);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("does not touch the Runner path at all when no budgetUsd is configured (byte-for-byte unchanged)", async () => {
    runMock.mockResolvedValueOnce({ finalOutput: { artifact: "research_brief.v1", summary: "ok" }, rawResponses: [{ usage: { inputTokens: 10, outputTokens: 10 } }], lastResponseId: "resp_ok" });
    // research now carries its own modelConfig.budgetUsd by default (F5); explicitly clear it here so
    // this test still exercises the genuinely-no-budget code path it's named for.
    const result: any = await executeNode({ nodeId: "research", input: {}, dependencyOutputs: RESEARCH_DEPENDENCIES, executionMode: "openai", modelConfig: { budgetUsd: undefined } });

    expect(result.execution.status).toBe("completed");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(fakeRunnerInstances).toHaveLength(0);
  });

  // F2b (T-2, run_1785352838155_l544ye): the run's OWN budgetUsd — the ceiling advanceRun's
  // between-node gate reads via summarizeModelUsage(runId) — was never watched INSIDE a node's own
  // loop, only the node's rare, separate modelConfig.budgetUsd was. contract_intelligence carried a
  // $3 run ceiling from $1.60 to $4.17 in one dispatch because of exactly this gap. Calls the runner
  // directly (bypassing executeNode's narrower fixture, which has no way to set run.budgetUsd) with a
  // node that has NO modelConfig.budgetUsd of its own, only a run carrying one, to isolate that the
  // run-level ceiling alone is what the guard now watches.
  it("aborts mid-node on the RUN's budgetUsd even when the node has no budgetUsd of its own", async () => {
    const run = makeRun({ budgetUsd: 0.05 });
    const result = await new OpenAINodeRunner().run({ node: PROBE_NODE, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("budget_exceeded");
      expect(result.message).toContain("budget_probe");
      expect(result.message).toContain("0.05");
    }
    expect(fakeRunnerInstances).toHaveLength(1);
    expect(runMock).not.toHaveBeenCalled();
  });
});
