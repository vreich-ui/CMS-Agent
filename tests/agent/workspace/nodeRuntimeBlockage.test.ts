import { beforeEach, describe, expect, it, vi } from "vitest";

// F2 — the flattening this pins shut. `node.execute` (nodeRuntime.executeNode) used to persist a
// failed node as `state.errors = [code, message]` and NOTHING else, while the conductor path kept
// the runner's structured error. Every caller of node.execute therefore had two strings where the
// engine had a computed remedy. These tests run a REAL executeNode against a stub runner that
// returns exactly what OpenAINodeRunner returns on a budget trip, and assert that both halves —
// output.error (the shape the conductor already wrote) and blockage (the shape a button can use) —
// come back on the persisted run.

const runnerResult = vi.hoisted(() => ({
  current: {
    ok: false as const,
    code: "budget_exceeded",
    message: 'Node "probe" stopped before the model turn that would cross the node budget.',
    details: { nodeId: "probe", budgetUsd: 0.25, ceiling: "node", spentUsdEstimate: 0.42, prospectiveTurnUsd: 0.36, suggestedBudgetUsd: 1.5, stage: "mid_loop" },
    operatorAction: "Raise probe budget to $1.5 (this run or default) and retry the node."
  } as Record<string, unknown>
}));

// The registry, not the provider SDK: this test is about what nodeRuntime does with a runner result,
// so the cheapest honest double is a runner that returns one.
vi.mock("../../../src/agent/execution/runnerRegistry.js", () => ({
  getNodeRunner: () => ({
    run: async () => runnerResult.current,
    validateConfiguration: () => ({ ok: true }),
    supports: () => true
  }),
  listNodeRunners: () => []
}));

import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { Blockage } from "../../../src/agent/execution/blockage.js";

const PROBE: WorkspaceNode = {
  id: "probe", name: "Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object", required: ["artifact"], properties: { artifact: { const: "probe.v1" } } },
  modelConfig: { budgetUsd: 0.25 }
};

const failedState = async () => {
  const result = await executeNode({ nodeId: "probe", input: {} }) as { execution: { nodes: Array<{ status: string; errors?: string[]; output?: unknown; blockage?: Blockage }> } };
  return result.execution.nodes[0];
};

describe("node.execute — a failed node carries its blockage", () => {
  beforeEach(async () => {
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
    await repositoryManager.getWorkspaceRepository().createNode(PROBE, { actor: "test" });
  });

  it("keeps the runner's structured error AND the actionable blockage, not just two strings", async () => {
    const state = await failedState();

    expect(state.status).toBe("failed");
    // Unchanged for every existing reader — this wave adds, it does not move.
    expect(state.errors).toEqual(["budget_exceeded", runnerResult.current.message]);
    // The shape executor.ts has always written on ITS failure path. Parity is the point: one reader
    // should not have to know which of the two paths produced the run it is looking at.
    expect(state.output).toMatchObject({ error: { code: "budget_exceeded", operatorAction: runnerResult.current.operatorAction, details: { suggestedBudgetUsd: 1.5 } } });

    const blockage = state.blockage!;
    expect(blockage.kind).toBe("budget");
    expect(blockage.scope.node_id).toBe("probe");
    // "sync" surface: this run is synthetic ("independent_node"), so the offered raise is the
    // one-shot attempt override — the only one that can actually address it (F4).
    expect(blockage.remedies.map((remedy) => remedy.id)).toEqual(["raise_budget_attempt", "raise_budget_default", "cancel"]);
    expect(blockage.remedies[0].args).toMatchObject({ scope: "attempt", budgetUsd: 1.5 });
  });

  it("classifies a non-budget failure through the same table", async () => {
    runnerResult.current = { ok: false, code: "model_timeout", message: "provider timed out" };
    const state = await failedState();
    expect(state.blockage?.kind).toBe("other");
    expect(state.blockage?.remedies.map((remedy) => remedy.type)).toEqual(["retry", "cancel"]);
  });

  it("refuses an input the node's schema rejects with a typed code, not a bare tool_error", async () => {
    // W0 T0.5 — this used to be `throw new Error("input_validation_failed: …")`, which reached the
    // wire as `tool_error` with the reason buried in prose.
    await repositoryManager.getWorkspaceRepository().createNode({ ...PROBE, id: "strict", inputSchema: { type: "object", required: ["brief"], properties: { brief: { type: "string" } } } }, { actor: "test" });
    await expect(executeNode({ nodeId: "strict", input: {} })).rejects.toMatchObject({
      code: "input_validation_failed",
      details: { nodeId: "strict" }
    });
  });
});
