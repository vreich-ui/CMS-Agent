import { describe, expect, it } from "vitest";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { estimateRunCostFromHistory, MIN_RUN_COST_HISTORY_SAMPLES } from "../../../src/agent/workspace/runCostHistory.js";
import type { NodeTimingRecord } from "../../../src/agent/workspace/nodeTimings.js";

const ROUTES = { research: "model", publish_executor: "publishExecutorDeterministic:execute" } as const;

const run = (runId: string, over: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId, workflowId: "publishing", projectId: "dr-lurie", status: "completed", executionMode: "openai",
  nodes: [{ nodeId: "research", status: "completed" }, { nodeId: "publish_executor", status: "skipped" }],
  startedAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:10:00.000Z", artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true,
  ...over
}) as WorkflowExecutionRecord;

const timing = (runId: string, timingId: string, costUsd: number, over: Partial<NodeTimingRecord> = {}): NodeTimingRecord => ({
  timingId, runId, workflowId: "publishing", nodeId: "research", durationMs: 1000, costUsd,
  outcome: "completed", recordedAt: "2026-09-10T00:01:00.000Z", projectId: "dr-lurie", executionMode: "openai", routeEra: "model",
  ...over
});

describe("qualified run cost history", () => {
  it("never treats aborted prefixes as completed cost samples", () => {
    const complete = run("run_complete");
    const failedA = run("run_prefix_a", { status: "failed" });
    const failedB = run("run_prefix_b", { status: "cancelled" });
    const estimate = estimateRunCostFromHistory({
      candidates: [failedA, failedB, complete], currentRouteEras: ROUTES, minSamples: 1,
      records: [
        timing("run_prefix_a", "t_a", 0.1), timing("run_prefix_b", "t_b", 0.2),
        timing("run_complete", "t_complete", 5),
        timing("run_complete", "t_complete_deterministic", 0, { nodeId: "publish_executor", routeEra: ROUTES.publish_executor })
      ]
    });

    expect(estimate.estimatedRunCostUsd).toBe(5);
    expect(estimate.observedRunCostsUsd).toEqual([5]);
    expect(estimate.exclusionReasons.not_completed).toBe(2);
    expect(estimate.candidateRuns).toBe(3);
    expect(estimate.coverageRuns).toBe(1);
  });

  it("counts every real retry attempt once, dedupes timingId, and keeps zero-cost deterministic coverage", () => {
    const complete = run("run_retried");
    const estimate = estimateRunCostFromHistory({
      candidates: [complete], currentRouteEras: ROUTES, minSamples: 1,
      records: [
        timing("run_retried", "attempt_1", 0.4, { outcome: "failed", attempt: 1 }),
        timing("run_retried", "attempt_2", 1.1, { attempt: 2 }),
        timing("run_retried", "attempt_2", 1.1, { attempt: 2, recordedAt: "2026-09-10T00:02:00.000Z" }),
        timing("run_retried", "deterministic", 0, { nodeId: "publish_executor", routeEra: ROUTES.publish_executor })
      ]
    });

    expect(estimate.observedRunCostsUsd).toEqual([1.5]);
    expect(estimate.sampleRecords).toBe(3);
    expect(estimate.coverageRuns).toBe(1);
  });

  it("rejects current, incomplete, mock, unattributed and foreign-era candidates explicitly", () => {
    const current = run("run_now");
    const incomplete = run("run_incomplete", { nodes: [{ nodeId: "research", status: "completed" }] });
    const mock = run("run_mock", { executionMode: "mock" });
    const foreignEra = run("run_old_route");
    const missingAttribution = run("run_missing_attribution");
    const estimate = estimateRunCostFromHistory({
      excludeRunId: "run_now", candidates: [current, incomplete, mock, foreignEra, missingAttribution], currentRouteEras: ROUTES,
      records: [
        timing("run_old_route", "old", 5, { routeEra: "old-model" }),
        timing("run_missing_attribution", "unattributed", 5, { projectId: undefined })
      ]
    });

    expect(estimate.basis).toBe("no_history");
    expect(estimate.exclusionReasons).toMatchObject({ current_run: 1, incomplete_stage_coverage: 1, mock_execution: 1, foreign_route_era: 1, missing_timing_attribution: 1 });
    expect(estimate.sampleRuns).toBe(0);
  });

  it("rejects a completed current-route run when a stage has no attributed timing row", () => {
    const completeButUntimed = run("run_missing_stage_timing");
    const estimate = estimateRunCostFromHistory({
      candidates: [completeButUntimed], currentRouteEras: ROUTES, minSamples: 1,
      records: [timing("run_missing_stage_timing", "research_only", 5)]
    });

    expect(estimate).toMatchObject({ basis: "no_history", coverageRuns: 0, sampleRuns: 0 });
    expect(estimate.exclusionReasons).toMatchObject({ missing_stage_timing: 1 });
  });

  it("uses qualifying project history before a separately labeled attributed pool", () => {
    const ownA = run("own_a");
    const ownB = run("own_b");
    const otherA = run("other_a", { projectId: "zilberman" });
    const otherB = run("other_b", { projectId: "zilberman" });
    const records = [
      timing("own_a", "own_a", 4), timing("own_a", "own_a_deterministic", 0, { nodeId: "publish_executor", routeEra: ROUTES.publish_executor }),
      timing("own_b", "own_b", 4.4), timing("own_b", "own_b_deterministic", 0, { nodeId: "publish_executor", routeEra: ROUTES.publish_executor }),
      timing("other_a", "other_a", 0.3, { projectId: "zilberman" }), timing("other_a", "other_a_deterministic", 0, { projectId: "zilberman", nodeId: "publish_executor", routeEra: ROUTES.publish_executor }),
      timing("other_b", "other_b", 0.5, { projectId: "zilberman" }), timing("other_b", "other_b_deterministic", 0, { projectId: "zilberman", nodeId: "publish_executor", routeEra: ROUTES.publish_executor })
    ];
    const own = estimateRunCostFromHistory({ candidates: [ownA, ownB, otherA, otherB], records, currentRouteEras: ROUTES, projectId: "dr-lurie" });
    const pooled = estimateRunCostFromHistory({ candidates: [otherA, otherB], records, currentRouteEras: ROUTES, projectId: "dr-lurie" });

    expect(own).toMatchObject({ scope: "project", estimatedRunCostUsd: 4, sampleRuns: 2 });
    expect(pooled).toMatchObject({ scope: "pooled", estimatedRunCostUsd: 0.3, sampleRuns: 2 });
    expect(pooled.rationale).toContain("POOLED ACROSS ATTRIBUTED TENANTS");
  });

  it("returns the existing safe no-history outcome when evidence is absent or too thin", () => {
    const estimate = estimateRunCostFromHistory({ records: [timing("orphan", "orphan", 5)] });
    expect(MIN_RUN_COST_HISTORY_SAMPLES).toBe(2);
    expect(estimate).toMatchObject({ artifact: "run_cost_estimate.v1", basis: "no_history", scope: "none", estimatedRunCostUsd: 0, candidateRuns: 0, coverageRuns: 0 });
    expect(estimate.rationale).toContain("blocks nothing");
  });
});
