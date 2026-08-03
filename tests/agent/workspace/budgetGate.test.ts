import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun, updateRunStatus } from "../../../src/agent/workspace/executor.js";
import { summarizeRunCost } from "../../../src/agent/workspace/conductor.js";
import { evaluateRunBudget, recordModelUsage, summarizeModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// Advance a run until it reaches a terminal (blocked/completed/failed/cancelled) state.
const drive = async (runId: string, store: ExecutionRepository, max = 30) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max && !(["blocked", "completed", "failed", "cancelled"].includes(run.status)); i++) {
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
    // Every canonical node declares its own budgetUsd (0.1 for the early intake/strategy nodes), and
    // the gate RESERVES the next node's declared budget before dispatching it — a run must stop
    // before the dispatch that would cross the ceiling, not discover the crossing afterwards
    // (run_1785435947311_jl8hl4 landed at 138% without this).
    //
    // R-20 posture: the gate meters ACTUAL spend only — a mock run's own deterministic estimates no
    // longer accrue (T-2 F-5), so this test injects a measured (status:"actual") record mid-run, the
    // way live model spend actually arrives, sized so the third node's reservation crosses the
    // ceiling: $2.95 accrued + reader_insight's $0.1 reserve > $3.
    const ceiling = 3;
    const gated = await startDryRun({ executionMode: "mock", projectId: "budget-proj", input: "Draft this", budgetUsd: ceiling }, store);
    await runNextNode(gated.runId, { executionRepository: store }); // input_triage
    await runNextNode(gated.runId, { executionRepository: store }); // topic_opportunity
    await recordModelUsage({ runId: gated.runId, nodeId: "topic_opportunity", model: "gpt-5.5", provider: "openai", inputTokens: 0, outputTokens: 0, costUsdEstimate: 2.95, status: "actual" });
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
    expect(records.filter((record) => record.status === "estimated").map((record) => record.nodeId).sort()).toEqual(["input_triage", "learning_recorder", "topic_opportunity"]);
    expect(records.filter((record) => record.status === "actual")).toHaveLength(1);

    // The ledger surfaces the budget view, reusing the same accrued cost figure (no second path).
    // R-20: that figure is the ACTUAL population only — the mock estimates above are visible in the
    // summary but never consume the ceiling. overBudget is false — the RESERVATION blocked the run
    // before accrued spend ever reached the ceiling, which is exactly the point.
    const usage = await summarizeModelUsage({ runId: gated.runId });
    const ledger = summarizeRunCost(run, usage);
    expect(ledger.budget).toMatchObject({ blocked: true, overBudget: false, budgetUsd: ceiling });
    expect(ledger.budget!.spentUsdEstimate).toBe(usage.actualCostUsdEstimate);
    expect(usage.actualCostUsdEstimate).toBe(2.95);
    expect(usage.estimatedCostUsdEstimate).toBeGreaterThan(0);
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
    // R-20 posture: inject measured (actual) spend mid-run so the third node's reservation crosses
    // the $3 ceiling — the same arithmetic as the halt test above.
    const gated = await startDryRun({ executionMode: "mock", projectId: "budget-proj-2", input: "Draft this", budgetUsd: 3 }, store);
    await runNextNode(gated.runId, { executionRepository: store }); // input_triage
    await runNextNode(gated.runId, { executionRepository: store }); // topic_opportunity
    await recordModelUsage({ runId: gated.runId, nodeId: "topic_opportunity", model: "gpt-5.5", provider: "openai", inputTokens: 0, outputTokens: 0, costUsdEstimate: 2.95, status: "actual" });
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
