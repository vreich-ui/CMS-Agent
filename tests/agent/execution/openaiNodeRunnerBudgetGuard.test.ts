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
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const RESEARCH_DEPENDENCIES = { reader_insight: { artifact: "reader_insight.v1", summary: "Upstream reader insight." } };

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
    const result: any = await executeNode({ nodeId: "research", input: {}, dependencyOutputs: RESEARCH_DEPENDENCIES, executionMode: "openai" });

    expect(result.execution.status).toBe("completed");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(fakeRunnerInstances).toHaveLength(0);
  });
});
