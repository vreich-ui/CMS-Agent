import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// G4 (T-2 re-run, run_1785405350649_9u5mjz): contract_intelligence blew a $4 ceiling by 118% even
// though the in-loop budget guard (B3/F2b) was fully engaged for it — the guard checks CUMULATIVE
// usage from turns already completed, at the START of the next turn, so it can only ever stop the
// turn AFTER the one whose own cost is what crosses the ceiling. Reduced to its simplest shape: turn 1
// is cheap and completes; turn 2's OWN prospective input (the conversation the SDK is about to send —
// exactly what balloons when a node falls back to raw self-discovery and every turn re-sends a
// growing history) is, by itself, large enough to blow the remaining budget. The OLD guard would let
// turn 2 run to completion and only abort before turn 3 — after the overshoot already happened. The
// FIXED guard reserves against turn 2's own prospective size and aborts BEFORE turn 2 runs.
const { fakeRunnerInstances, FakeRunnerClass, runMock, turn2Started } = vi.hoisted(() => {
  const instances: any[] = [];
  const started = { turn2: false };
  class FakeRunner {
    listeners: Record<string, Array<(...args: any[]) => void>> = {};
    on(event: string, cb: (...args: any[]) => void) { (this.listeners[event] ??= []).push(cb); return this; }
    async run(_agent: unknown, _prompt: unknown, options: any) {
      const usage = { inputTokens: 0, outputTokens: 0 };
      const emitStart = (turnInput?: unknown) => this.listeners.agent_start?.forEach((cb) => cb({ usage: { ...usage } }, undefined, turnInput));
      const checkAborted = () => { if (options?.signal?.aborted) { const e = new Error("This operation was aborted."); e.name = "AbortError"; throw e; } };

      emitStart([{ role: "user", content: "short turn 1 prompt" }]);
      checkAborted();
      usage.inputTokens += 200; usage.outputTokens += 50; // turn 1: cheap, completes normally

      // Turn 2's OWN prospective input is huge — a long tool-call history the node accumulated by
      // falling back to raw self-discovery (F1's gap). Cumulative usage-so-far (from turn 1 alone)
      // is still tiny, so the OLD (usage-only) guard would wave this turn through.
      emitStart(Array.from({ length: 4000 }, (_, i) => ({ role: "tool", content: `contract fragment ${i} `.repeat(20) })));
      checkAborted(); // the FIXED guard aborts here, before turn 2's cost accrues
      turn2Started.turn2 = true;
      usage.inputTokens += 150_000; usage.outputTokens += 20_000; // turn 2: the expensive one — must never be reached

      emitStart([{ role: "user", content: "turn 3" }]);
      checkAborted();

      return { finalOutput: { artifact: "probe.v1", summary: "should never be reached" }, rawResponses: [{ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }], lastResponseId: "resp_never" };
    }
  }
  return { fakeRunnerInstances: instances, FakeRunnerClass: FakeRunner, runMock: vi.fn(), turn2Started: started };
});
vi.mock("@openai/agents", () => ({
  Agent: class { constructor(_config: unknown) {} },
  run: (...args: unknown[]) => runMock(...(args as [])),
  Runner: class extends FakeRunnerClass { constructor() { super(); fakeRunnerInstances.push(this); } },
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
}));

import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const PROBE_NODE: WorkspaceNode = {
  id: "budget_probe", name: "Budget Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object", required: ["artifact", "summary"], properties: { artifact: { const: "probe.v1" }, summary: { type: "string" } } },
  modelConfig: {}
};

const makeRun = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run-prospective-probe", workflowId: "independent_node", projectId: "workspace", status: "running",
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai", ...overrides
});

describe("in-loop budget circuit breaker reserves against the UPCOMING turn's own size (G4)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); fakeRunnerInstances.length = 0; turn2Started.turn2 = false; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("aborts BEFORE the turn whose own prospective size would cross the ceiling, not just the turn after it", async () => {
    // Generous enough that turn 1 (cheap) plus a plausible turn 3 would fit, but turn 2's own huge
    // prospective input does not.
    const run = makeRun({ budgetUsd: 0.05 });
    const result = await new OpenAINodeRunner().run({ node: PROBE_NODE, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("budget_exceeded");
      expect(result.message).toContain("budget_probe");
    }
    // The expensive turn's usage was never allowed to accrue — proof the abort landed BEFORE it,
    // not merely before the turn after it (the old guard's best case).
    expect(turn2Started.turn2).toBe(false);
  });
});
