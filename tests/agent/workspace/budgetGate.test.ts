import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun, updateRunStatus } from "../../../src/agent/workspace/executor.js";
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
    // Measure the deterministic accrued mock cost after one and after two nodes with an un-gated run.
    const measure = await startDryRun({ executionMode: "mock", projectId: "budget-proj", input: "Draft this" }, store);
    await runNextNode(measure.runId, { executionRepository: store });
    const oneNodeCost = (await summarizeModelUsage({ runId: measure.runId })).totalCostUsdEstimate;
    await runNextNode(measure.runId, { executionRepository: store });
    const twoNodeCost = (await summarizeModelUsage({ runId: measure.runId })).totalCostUsdEstimate;
    expect(oneNodeCost).toBeGreaterThan(0);
    expect(twoNodeCost).toBeGreaterThan(oneNodeCost);

    // Every canonical node now declares its own budgetUsd (0.1 for the early intake/strategy nodes),
    // and the gate RESERVES the next node's declared budget before dispatching it — a run must stop
    // before the dispatch that would cross the ceiling, not discover the crossing afterwards
    // (run_1785435947311_jl8hl4 landed at 138% without this). A ceiling strictly between
    // (oneNodeCost + reserve) and (twoNodeCost + reserve) lets nodes 1 and 2 dispatch and blocks
    // node 3 on its reservation.
    const reserve = 0.1;
    const ceiling = (oneNodeCost + twoNodeCost) / 2 + reserve;
    const gated = await startDryRun({ executionMode: "mock", projectId: "budget-proj", input: "Draft this", budgetUsd: ceiling }, store);
    const run = await drive(gated.runId, store);

    expect(run.status).toBe("blocked");
    expect(run.budgetBlock).toBeDefined();
    expect(run.budgetBlock!.nextNodeId).toBe("reader_insight");
    expect(run.budgetBlock!.reason).toMatch(/paused for budget/i);
    expect(run.budgetBlock!.reason).toMatch(/would cross/i);
    expect(run.currentNodeId).toBe("reader_insight");
    // Earlier nodes ran; the boundary node and everything after it did not.
    expect(run.nodes.find((node) => node.nodeId === "input_triage")!.status).toBe("completed");
    expect(run.nodes.find((node) => node.nodeId === "topic_opportunity")!.status).toBe("completed");
    expect(run.nodes.find((node) => node.nodeId === "reader_insight")!.status).toBe("queued");
    // A budget pause is NOT an approval pause: no ApprovalRequired entry is minted.
    expect(run.approvalsRequired).toEqual([]);
    // Never partially charged the un-run node (reader_insight, the boundary the gate stopped before).
    // learning_recorder also recorded usage: F4 fires it as a best-effort side effect the moment the
    // run reaches ANY terminal outcome, including this budget block, rather than waiting on
    // publication_controller (which this run never even reaches).
    const records = await repositoryManager.getUsageRepository().list({ runId: gated.runId });
    expect(records.map((record) => record.nodeId).sort()).toEqual(["input_triage", "learning_recorder", "topic_opportunity"]);

    // The ledger surfaces the budget view, reusing the same accrued cost figure (no second path).
    // overBudget is false — the RESERVATION blocked the run before accrued spend ever reached the
    // ceiling, which is exactly the point — while blocked reports the budget pause.
    const usage = await summarizeModelUsage({ runId: gated.runId });
    const ledger = summarizeRunCost(run, usage);
    expect(ledger.budget).toMatchObject({ blocked: true, overBudget: false, budgetUsd: ceiling });
    expect(ledger.budget!.spentUsdEstimate).toBe(usage.totalCostUsdEstimate);
  });

  it("blocks the very first dispatch when the ceiling cannot even cover that node's declared budget", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    // input_triage declares budgetUsd 0.1; a $0.05 run ceiling cannot cover it, so nothing runs and
    // nothing is charged — the honest outcome for a ceiling below the pipeline's smallest reserve.
    const gated = await startDryRun({ executionMode: "mock", projectId: "budget-proj", input: "Draft this", budgetUsd: 0.05 }, store);
    const run = await drive(gated.runId, store);

    expect(run.status).toBe("blocked");
    expect(run.budgetBlock!.nextNodeId).toBe("input_triage");
    expect(run.budgetBlock!.reason).toMatch(/would cross/i);
    expect(run.nodes.find((node) => node.nodeId === "input_triage")!.status).toBe("queued");
  });

  // F3 (T-2, run_1785352838155_l544ye): the budget gate's own reported remedy — "Raise budgetUsd and
  // resume" — was unreachable: workflow.resume_run took only runId, with no way to actually raise the
  // ceiling that blocked the run. updateRunStatus now accepts an optional patch (wired to
  // workflow.resume_run's optional budgetUsd field); resuming with a higher ceiling lets a
  // budget-blocked run actually continue instead of immediately re-blocking on the same ceiling.
  it("resuming with a higher budgetUsd lets a budget-blocked run actually continue", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const measure = await startDryRun({ executionMode: "mock", projectId: "budget-proj-2", input: "Draft this" }, store);
    await runNextNode(measure.runId, { executionRepository: store });
    const oneNodeCost = (await summarizeModelUsage({ runId: measure.runId })).totalCostUsdEstimate;
    await runNextNode(measure.runId, { executionRepository: store });
    const twoNodeCost = (await summarizeModelUsage({ runId: measure.runId })).totalCostUsdEstimate;

    // Between (oneNodeCost + reserve) and (twoNodeCost + reserve): two nodes dispatch, the third's
    // reservation blocks (see the halt test above for the arithmetic).
    const gated = await startDryRun({ executionMode: "mock", projectId: "budget-proj-2", input: "Draft this", budgetUsd: (oneNodeCost + twoNodeCost) / 2 + 0.1 }, store);
    const blocked = await drive(gated.runId, store);
    expect(blocked.status).toBe("blocked");
    expect(blocked.budgetBlock).toBeDefined();
    expect(blocked.nodes.find((node) => node.nodeId === "reader_insight")!.status).toBe("queued");

    // Raised well beyond anything the whole mock graph could cost, so the run runs to its natural
    // terminal (the approval gate) instead of immediately re-blocking on a still-too-low ceiling.
    const resumed = await updateRunStatus(gated.runId, "queued", store, { budgetUsd: 1000 });
    expect(resumed!.status).toBe("queued");
    expect(resumed!.budgetUsd).toBe(1000);

    const advanced = await drive(gated.runId, store);
    // Cleared the moment the run advances past the (now much higher) ceiling — not still reporting
    // "paused for budget" against a run that has since moved on.
    expect(advanced.budgetBlock).toBeUndefined();
    expect(advanced.nodes.find((node) => node.nodeId === "reader_insight")!.status).not.toBe("queued");
    expect(advanced.status).toBe("blocked");
    expect(advanced.currentNodeId).toBe("publication_controller");
  });

  it("no ceiling configured → unchanged behavior (regression guard): stops at the approval gate, not a budget gate", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "budget-proj", input: "Draft this" }, store);
    const run = await drive(started.runId, store);

    expect(run.status).toBe("blocked");
    expect(run.currentNodeId).toBe("publication_controller");
    expect(run.budgetBlock).toBeUndefined();
    expect(run.approvalsRequired).toEqual([expect.objectContaining({ nodeId: "publication_controller", type: "approval_required" })]);
    // No budget view is attached to a run without a ceiling.
    expect(summarizeRunCost(run, await summarizeModelUsage({ runId: run.runId })).budget).toBeUndefined();
  });
});
