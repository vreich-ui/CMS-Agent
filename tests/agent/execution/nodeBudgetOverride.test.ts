import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// budget-override-and-ui-save — the budget guard (budgetGuard.ts, wrapped by OpenAINodeRunner.ts)
// must read a per-run override (run.nodeBudgetOverrides[nodeId], set by
// workflow.set_node_budget_override / executor.setNodeBudgetOverride) in PREFERENCE to the node's
// own stored modelConfig.budgetUsd, for THAT RUN ONLY — the node's stored config is never mutated,
// so a different run (or the same run with no override for this node) still sees the node's normal
// ceiling. Mock shape and two-turn setup reused verbatim from
// openaiNodeRunnerProspectiveBudget.test.ts's G4 test: turn 1 is small (actual usage far under any
// ceiling used here), turn 2's OWN prospective size (~500K input tokens, ~$2.50) is what a low
// ceiling must refuse — proving the guard reserves against the upcoming turn, not just accrued spend.
const { runMock, innerModelCalls } = vi.hoisted(() => {
  const innerCalls: Array<{ inputChars: number }> = [];
  return {
    innerModelCalls: innerCalls,
    runMock: vi.fn(async (agent: any, prompt: string) => {
      const model = agent.config.model;
      if (typeof model !== "string") {
        await model.getResponse({ input: prompt });
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

// A generous node-level ceiling ($100) — large enough that neither the pre-flight "own budgetUsd
// can't cover one turn" check nor turn 2's own ~$2.50 prospective size could ever trip it alone.
// Any refusal in these tests can only come from a per-run override.
const PROBE_NODE: WorkspaceNode = {
  id: "override_probe", name: "Override Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object", required: ["artifact", "summary"], properties: { artifact: { const: "probe.v1" }, summary: { type: "string" } } },
  modelConfig: { budgetUsd: 100 }
};

const makeRun = (nodeBudgetOverrides?: Record<string, number>): WorkflowExecutionRecord => ({
  runId: "run-override-probe", workflowId: "independent_node", projectId: "workspace", status: "running",
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai",
  ...(nodeBudgetOverrides ? { nodeBudgetOverrides } : {})
});

describe("per-run node budget override read by the budget guard", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); innerModelCalls.length = 0; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("a tiny override refuses the node before the first turn, even though its own modelConfig.budgetUsd is generous", async () => {
    const runner = new OpenAINodeRunner();
    const run = makeRun({ [PROBE_NODE.id]: 0.00001 });
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("budget_exceeded");
    // Refused by the pre-flight "own budgetUsd can't cover even one turn's reserve" check
    // (OpenAINodeRunner.ts) — before the model was ever called — tripped on the OVERRIDE figure,
    // not the node's stored 100.
    expect(innerModelCalls).toHaveLength(0);
    const details = result.details as { nodeBudgetUsd?: number };
    expect(details.nodeBudgetUsd).toBe(0.00001);
  });

  it("without an override, the same node's generous modelConfig.budgetUsd lets both turns through unchanged", async () => {
    const runner = new OpenAINodeRunner();
    const run = makeRun(); // no nodeBudgetOverrides at all
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(true);
    expect(innerModelCalls).toHaveLength(2);
  });

  it("an override for a DIFFERENT node in the same run leaves this node's own budgetUsd untouched", async () => {
    const runner = new OpenAINodeRunner();
    const run = makeRun({ some_other_node: 0.00001 });
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(true);
    expect(innerModelCalls).toHaveLength(2);
  });

  it("the mid-loop guard itself (not just the pre-flight check) enforces the override — the SAME node whose $100 stored budgetUsd would never trip stops at the override's $1", async () => {
    const runner = new OpenAINodeRunner();
    // $1 is well above the pre-flight reserve (~$0.065, turn 1 passes) but well below turn 2's own
    // ~$2.50 prospective size — mirroring openaiNodeRunnerProspectiveBudget.test.ts's G4 test
    // exactly, except the ceiling comes from a per-run OVERRIDE instead of run.budgetUsd, against a
    // node whose OWN modelConfig.budgetUsd ($100) would never have refused turn 2 on its own.
    const run = makeRun({ [PROBE_NODE.id]: 1 });
    const result = await runner.run({ node: PROBE_NODE, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("budget_exceeded");
    // Exactly one request reached the provider (turn 1) — turn 2 was refused before it was sent.
    expect(innerModelCalls).toHaveLength(1);
    const details = result.details as { ceiling?: string; budgetUsd?: number; nodeId?: string };
    expect(details.ceiling).toBe("node");
    expect(details.budgetUsd).toBe(1);
    expect(details.nodeId).toBe(PROBE_NODE.id);
  });
});
