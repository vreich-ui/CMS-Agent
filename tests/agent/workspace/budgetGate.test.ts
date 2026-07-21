import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { summarizeRunCost } from "../../../src/agent/workspace/conductor.js";
import { evaluateRunBudget, summarizeModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// Advance a run until it reaches a terminal (blocked/completed/failed/cancelled) state.
const drive = async (runId: string, store: ExecutionRepository, max = 30) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max && !["blocked", "completed", "failed", "cancelled"].includes(run.status); i++) {
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

describe("evaluateRunBudget (pure cost gate math)", () => {
  it("returns undefined when no ceiling is configured (Default OFF)", () => {
    expect(evaluateRunBudget(undefined, 5)).toBeUndefined();
  });

  it("flags overBudget with >= semantics and grades ok/warning/exceeded", () => {
    expect(evaluateRunBudget(1, 0.5)).toMatchObject({ overBudget: false, status: "ok" });
    expect(evaluateRunBudget(1, 0.85)).toMatchObject({ overBudget: false, status: "warning" });
    expect(evaluateRunBudget(1, 1)).toMatchObject({ overBudget: true, status: "exceeded" }); // reached == blocked
    expect(evaluateRunBudget(1, 2)).toMatchObject({ overBudget: true, remainingUsdEstimate: 0 });
  });
});

describe("conductor budget gate", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("halts before the node that would cross the ceiling; earlier nodes ran, later did not", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    // Measure the deterministic accrued mock cost after two nodes with an un-gated run.
    const measure = await startDryRun({ projectId: "budget-proj", input: "Draft this" }, store);
    await runNextNode(measure.runId, { executionRepository: store });
    await runNextNode(measure.runId, { executionRepository: store });
    const twoNodeCost = (await summarizeModelUsage({ runId: measure.runId })).totalCostUsdEstimate;
    expect(twoNodeCost).toBeGreaterThan(0);

    // Ceiling == cost-after-two-nodes: nodes 1 and 2 run (accrued < ceiling before each), and the
    // gate halts before node 3 the instant accrued reaches the ceiling.
    const gated = await startDryRun({ projectId: "budget-proj", input: "Draft this", budgetUsd: twoNodeCost }, store);
    const run = await drive(gated.runId, store);

    expect(run.status).toBe("blocked");
    expect(run.budgetBlock).toBeDefined();
    expect(run.budgetBlock!.nextNodeId).toBe("reader_insight");
    expect(run.budgetBlock!.reason).toMatch(/paused for budget/i);
    expect(run.currentNodeId).toBe("reader_insight");
    // Earlier nodes ran; the boundary node and everything after it did not.
    expect(run.nodes.find((node) => node.nodeId === "input_triage")!.status).toBe("completed");
    expect(run.nodes.find((node) => node.nodeId === "topic_opportunity")!.status).toBe("completed");
    expect(run.nodes.find((node) => node.nodeId === "reader_insight")!.status).toBe("queued");
    // A budget pause is NOT an approval pause: no ApprovalRequired entry is minted.
    expect(run.approvalsRequired).toEqual([]);
    // Never partially charged the un-run node: only the two executed nodes recorded usage.
    const records = await repositoryManager.getUsageRepository().list({ runId: gated.runId });
    expect(records.map((record) => record.nodeId).sort()).toEqual(["input_triage", "topic_opportunity"]);

    // The ledger surfaces the budget view, reusing the same accrued cost figure (no second path).
    const usage = await summarizeModelUsage({ runId: gated.runId });
    const ledger = summarizeRunCost(run, usage);
    expect(ledger.budget).toMatchObject({ blocked: true, overBudget: true, budgetUsd: twoNodeCost });
    expect(ledger.budget!.spentUsdEstimate).toBe(usage.totalCostUsdEstimate);
  });

  it("no ceiling configured → unchanged behavior (regression guard): stops at the approval gate, not a budget gate", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ projectId: "budget-proj", input: "Draft this" }, store);
    const run = await drive(started.runId, store);

    expect(run.status).toBe("blocked");
    expect(run.currentNodeId).toBe("publication_controller");
    expect(run.budgetBlock).toBeUndefined();
    expect(run.approvalsRequired).toEqual([expect.objectContaining({ nodeId: "publication_controller", type: "approval_required" })]);
    // No budget view is attached to a run without a ceiling.
    expect(summarizeRunCost(run, await summarizeModelUsage({ runId: run.runId })).budget).toBeUndefined();
  });
});
