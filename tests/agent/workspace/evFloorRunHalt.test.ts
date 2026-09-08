import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { computeEvFloor } from "../../../src/agent/workspace/evFloor.js";
import { buildNodeTimingRecord } from "../../../src/agent/workspace/nodeTimings.js";

// ACCEPTANCE 3 and 4, at the CONDUCTOR level. skipPredicates decides; this proves what the executor
// does with the decision — and specifically that an earned block STOPS THE RUN rather than skipping
// brief_architect and leaving the publish tail alive to write and publish against no brief.

const advanceUntil = async (runId: string, store: ExecutionRepository, done: (run: WorkflowExecutionRecord) => boolean) => {
  let run = (await getRun(runId, store))!;
  for (let i = 0; i < 40 && !done(run) && !["completed", "failed", "blocked", "cancelled"].includes(run.status); i++) {
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run;
};

const statusOf = (run: WorkflowExecutionRecord, nodeId: string) => run.nodes.find((node) => node.nodeId === nodeId)?.status;
const reached = (nodeId: string) => (run: WorkflowExecutionRecord) => ["completed", "blocked", "failed", "skipped"].includes(statusOf(run, nodeId) ?? "queued");

// Replace the mock fixture monetization_strategy produced with a real, non-placeholder artifact
// carrying the EV floor. (A dryRun fixture is deliberately never evidence — see evFloorBlocked.test.)
const withEvFloor = async (runId: string, store: ExecutionRepository, evFloor: unknown) => {
  const run = (await getRun(runId, store))!;
  run.stageOutputs.monetization_strategy = { artifact: "monetization_strategy.v1", summary: "s", selectedOffer: null, offerRationale: "r", commercialIntent: "commercial", evFloor };
  await store.saveRun(run);
};

const startToMonetization = async () => {
  const store = new RepositoryManager().getExecutionRepository();
  const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: { contentClass: "money", topic: "Retinoid tolerance" } }, store);
  await advanceUntil(started.runId, store, reached("monetization_strategy"));
  return { runId: started.runId, store };
};

describe("an EARNED EV block halts the run at brief_architect", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("stops the run — status blocked, brief_architect never dispatched, and the publish tail never reached", async () => {
    const { runId, store } = await startToMonetization();
    await withEvFloor(runId, store, computeEvFloor({ runCostUsd: 3.86, floorMultiplier: 1.25, payoutUsd: 20, conversionRate: 0.001, estimatedVolume: 100, runCostBasis: "workflow_history", revenueBasis: "monetizer_data" }));

    const run = await advanceUntil(runId, store, reached("brief_architect"));

    expect(run.status).toBe("blocked");
    expect(statusOf(run, "brief_architect")).toBe("blocked");
    // NOT "skipped": a skipped brief reads as satisfied-with-absent downstream, which is exactly how a
    // half-run publishes an article nobody wrote a brief for.
    expect(statusOf(run, "brief_architect")).not.toBe("skipped");
    // Auditable, per rule 2: the predicate that decided and the facts it decided on, on the node.
    const brief = run.nodes.find((node) => node.nodeId === "brief_architect")!;
    expect(brief.skip?.predicate).toMatchObject({ when: "ev_floor_blocked" });
    expect(brief.skip?.basis).toContain("evFloor.estimateBasis: monetizer_data");
    expect(brief.warnings).toContain("run_halted:ev_floor_blocked");
    expect(brief.warnings).toContain("no_publication_performed");
    // Nothing downstream ran.
    for (const nodeId of ["contract_intelligence", "article_body", "publish_payload", "publication_controller", "publish_executor"]) {
      expect(statusOf(run, nodeId), `${nodeId} must not have run`).toBe("queued");
    }
    expect(run.stageOutputs.brief_architect).toBeUndefined();
  });

  it("does NOT stop the run on an advisory block — the Monetizer-down case, which is every money run today", async () => {
    const { runId, store } = await startToMonetization();
    // Cost measured, revenue assumed: estimateBasis "mixed", verdict "block".
    await withEvFloor(runId, store, computeEvFloor({ runCostUsd: 3.86, floorMultiplier: 1.25, payoutUsd: 20, conversionRate: 0.0001, estimatedVolume: 400, runCostBasis: "workflow_history" }));

    const run = await advanceUntil(runId, store, reached("brief_architect"));

    expect(run.status).not.toBe("blocked");
    expect(statusOf(run, "brief_architect")).toBe("completed");
  });

  it("does NOT stop the run when no EV floor was computed at all — fail-open", async () => {
    const { runId, store } = await startToMonetization();
    await withEvFloor(runId, store, undefined);

    const run = await advanceUntil(runId, store, reached("brief_architect"));

    expect(run.status).not.toBe("blocked");
    expect(statusOf(run, "brief_architect")).toBe("completed");
  });
});

describe("the run-cost prefetch delivers a measured figure to monetization_strategy", () => {
  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    repositoryManager.getNodeTimingRepository().clear();
  });

  it("puts the workflow's measured p50 run cost in the node's input, so the model has nothing to invent", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: { contentClass: "money", topic: "Retinoid tolerance" } }, store);
    const seeded = (await getRun(started.runId, store))!;
    const timings = repositoryManager.getNodeTimingRepository();
    for (const [runId, costUsd] of [["run_hist_a", 2.0], ["run_hist_b", 3.86], ["run_hist_c", 9.0]] as const) {
      await timings.record(buildNodeTimingRecord({ runId, workflowId: seeded.workflowId, nodeId: "article_body", durationMs: 1000, costUsd, outcome: "completed" }));
    }

    const run = await advanceUntil(started.runId, store, reached("monetization_strategy"));
    const node = run.nodes.find((entry) => entry.nodeId === "monetization_strategy")!;
    const estimate = (node.input as Record<string, unknown>).runCostEstimate as Record<string, unknown>;

    expect(estimate).toMatchObject({ artifact: "run_cost_estimate.v1", basis: "workflow_history", estimatedRunCostUsd: 3.86, sampleRuns: 3 });
    expect(node.warnings ?? []).not.toContain("cost_prefetch_degraded:cost_history_insufficient");
  });

  it("degrades loudly, never fatally, when there is no history: a $0 floor and a named run-visible warning", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: { contentClass: "money", topic: "Retinoid tolerance" } }, store);

    const run = await advanceUntil(started.runId, store, reached("monetization_strategy"));
    const node = run.nodes.find((entry) => entry.nodeId === "monetization_strategy")!;

    expect(node.status).toBe("completed");
    expect((node.input as Record<string, unknown>).runCostEstimate).toMatchObject({ basis: "no_history", estimatedRunCostUsd: 0 });
    expect(node.warnings).toContain("cost_prefetch_degraded:cost_history_insufficient");
  });
});
