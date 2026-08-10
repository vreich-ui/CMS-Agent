import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun, updateRunStatus } from "../../../src/agent/workspace/executor.js";
import { summarizeRunCost } from "../../../src/agent/workspace/conductor.js";
import { evaluateRunBudget, recordModelUsage, summarizeModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

const TERMINAL = ["blocked", "completed", "failed", "cancelled"];

// Advance a run until it reaches a terminal (blocked/completed/failed/cancelled) state.
const drive = async (runId: string, store: ExecutionRepository, max = 30) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max && !TERMINAL.includes(run.status); i++) {
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
    // ceiling: $2.95 accrued + topic_opportunity's $0.1 reserve > $3. (§2.16 inserted
    // placement_resolver between input_triage and topic_opportunity, so the second advance runs it
    // and the boundary node the gate stops before is now topic_opportunity.)
    const ceiling = 3;
    const gated = await startDryRun({ executionMode: "mock", projectId: "budget-proj", input: "Draft this", budgetUsd: ceiling }, store);
    await runNextNode(gated.runId, { executionRepository: store }); // input_triage
    await runNextNode(gated.runId, { executionRepository: store }); // placement_resolver
    await recordModelUsage({ runId: gated.runId, nodeId: "placement_resolver", model: "gpt-5.5", provider: "openai", inputTokens: 0, outputTokens: 0, costUsdEstimate: 2.95, status: "actual" });
    const run = await drive(gated.runId, store);

    expect(run.status).toBe("blocked");
    expect(run.budgetBlock).toBeDefined();
    expect(run.budgetBlock!.nextNodeId).toBe("topic_opportunity");
    expect(run.budgetBlock!.reason).toMatch(/paused for budget/i);
    expect(run.budgetBlock!.reason).toMatch(/would cross/i);
    expect(run.currentNodeId).toBe("topic_opportunity");
    // Earlier nodes ran; the boundary node and everything after it did not.
    expect(run.nodes.find((node) => node.nodeId === "input_triage")!.status).toBe("completed");
    expect(run.nodes.find((node) => node.nodeId === "placement_resolver")!.status).toBe("completed");
    expect(run.nodes.find((node) => node.nodeId === "topic_opportunity")!.status).toBe("queued");
    // A budget pause is NOT an approval pause: no ApprovalRequired entry is minted.
    expect(run.approvalsRequired).toEqual([]);
    // Never partially charged the un-run node (topic_opportunity, the boundary the gate stopped before).
    // 2.4: learning_recorder does NOT record usage here. F4's best-effort dispatch still fires on this
    // budget-block terminal transition, but 2.4 additionally requires learning_recorder's own declared
    // dependency (publication_controller) to have been REACHED at least once first — and this run
    // blocked at reader_insight, so publication_controller was never touched (still "queued"). Firing
    // here is exactly the run-start-bypass bug 2.4 fixed (learning_recorder recording 23 seconds into
    // a run that continued for another hour).
    const records = await repositoryManager.getUsageRepository().list({ runId: gated.runId });
    expect(records.filter((record) => record.status === "estimated").map((record) => record.nodeId).sort()).toEqual(["input_triage", "placement_resolver"]);
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
    // 2.4: the run died at the very first node — learning_recorder's dependency (publication_controller)
    // was never reached, so the best-effort dispatch skips it entirely rather than firing early.
    expect(run.nodes.find((node) => node.nodeId === "learning_recorder")!.status).toBe("queued");
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

// 2.4 (handoff 2026-08-10, run_1785842430906_tqjk1o): learning_recorder used to be dispatched directly
// by recordTerminationObservations at ANY terminal transition, bypassing dependsOn entirely — so a run
// that died at its very first node still fired learning_recorder, long before its declared dependency
// (publication_controller) had ever been touched. Fixed by requiring every declared dependency to have
// been REACHED (moved off "queued") at least once before the best-effort dispatch fires.
describe("learning_recorder does not fire before its dependencies are reached (2.4)", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("a run that fails at the very first node never dispatches learning_recorder", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    // An empty projectId makes the very first node fail immediately with client_project_unresolved —
    // the run reaches a terminal "failed" status 0 nodes in, with publication_controller (and every
    // other node) still "queued".
    const started = await startDryRun({ executionMode: "mock", projectId: "", input: "Draft this" }, store);
    const run = await runNextNode(started.runId, { executionRepository: store });

    expect(run.status).toBe("failed");
    expect(run.nodes.find((node) => node.nodeId === "input_triage")!.status).toBe("failed");
    expect(run.nodes.find((node) => node.nodeId === "publication_controller")!.status).toBe("queued");
    // The dependency (publication_controller) was never reached, so learning_recorder is skipped
    // silently rather than dispatched early — it stays queued, and no usage is recorded for it.
    expect(run.nodes.find((node) => node.nodeId === "learning_recorder")!.status).toBe("queued");
    const records = await repositoryManager.getUsageRepository().list({ runId: started.runId });
    expect(records.map((record) => record.nodeId)).not.toContain("learning_recorder");
  });

  it("regression guard: learning_recorder still fires once its dependency is reached (even only as far as blocked)", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "budget-proj", input: "Draft this" }, store);
    let run = await getRun(started.runId, store);
    for (let i = 0; run && i < 30 && !TERMINAL.includes(run.status); i++) {
      run = await runNextNode(started.runId, { executionRepository: store });
    }
    // publication_controller is publish-risk and this run was never approved, so it is attempted and
    // refused ("blocked") rather than "completed" — F4's whole reason for existing: that dependency
    // almost never literally completes. Reaching "blocked" still counts as reached. §2.15:
    // learning_recorder's OTHER dependency, publish_executor, never left "queued" here (the run
    // terminal-blocked at the controller, one node upstream of it) — it counts as SEALED, not
    // reached: its own sole dependency was attempted and refused, so it can never run in this run's
    // state, and treating that as unresolved would strand learning_recorder on the most common path.
    expect(run!.nodes.find((node) => node.nodeId === "publication_controller")!.status).toBe("blocked");
    expect(run!.nodes.find((node) => node.nodeId === "publish_executor")!.status).toBe("queued");
    expect(run!.nodes.find((node) => node.nodeId === "learning_recorder")!.status).toBe("completed");
  });
});
