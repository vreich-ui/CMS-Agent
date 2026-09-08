import { describe, expect, it } from "vitest";
import { estimateRunCostFromHistory, MIN_RUN_COST_HISTORY_SAMPLES } from "../../../src/agent/workspace/runCostHistory.js";
import { aggregateNodeTimingsByNode, type NodeTimingRecord } from "../../../src/agent/workspace/nodeTimings.js";

// ACCEPTANCE 1 and 2 (EV-floor brief, 2026-09-08). The defect: monetization_strategy emitted
// estimatedRunCost: 800 against a measured $3.86 run and demanded $1,000 of expected value. These
// tests pin that the figure is DERIVED FROM MEASURED HISTORY, and that its absence is honest rather
// than a large round number that silently blocks everything.

const record = (runId: string, nodeId: string, costUsd: number, recordedAt = "2026-09-01T00:00:00.000Z"): NodeTimingRecord => ({
  timingId: `t_${runId}_${nodeId}`,
  runId,
  workflowId: "publishing",
  nodeId,
  durationMs: 1000,
  costUsd,
  outcome: "completed",
  recordedAt
});

describe("estimateRunCostFromHistory — the run cost comes from the ledger, never from a guess", () => {
  it("derives estimatedRunCostUsd as the p50 of prior run totals and names the basis", () => {
    const records = [
      record("run_a", "article_body", 1.51), record("run_a", "brief_architect", 2.35),
      record("run_b", "article_body", 1.4), record("run_b", "brief_architect", 2.2),
      record("run_c", "article_body", 1.9), record("run_c", "brief_architect", 3.1)
    ];

    const estimate = estimateRunCostFromHistory({ records });

    // Run totals: 3.86, 3.60, 5.00 -> sorted [3.6, 3.86, 5] -> nearest-rank p50 = 3.86.
    expect(estimate.estimatedRunCostUsd).toBe(3.86);
    expect(estimate.basis).toBe("workflow_history");
    expect(estimate.sampleRuns).toBe(3);
    expect(estimate.observedRunCostsUsd).toEqual([3.6, 3.86, 5]);
    expect(estimate.rationale).toContain("p50");
    // The regression guard: nothing anywhere near the fabricated figure.
    expect(estimate.estimatedRunCostUsd).toBeLessThan(10);
  });

  it("excludes the run being estimated — a run at node 4 must not floor itself on its own partial spend", () => {
    const records = [
      record("run_a", "input_triage", 4), record("run_b", "input_triage", 4),
      record("run_now", "input_triage", 0.02)
    ];

    const estimate = estimateRunCostFromHistory({ records, excludeRunId: "run_now" });

    expect(estimate.observedRunCostsUsd).toEqual([4, 4]);
    expect(estimate.estimatedRunCostUsd).toBe(4);
  });

  it("falls back honestly with no history: a $0 floor, the fallback named in the rationale, and NOT a round number that blocks everything", () => {
    const estimate = estimateRunCostFromHistory({ records: [] });

    expect(estimate.basis).toBe("no_history");
    expect(estimate.estimatedRunCostUsd).toBe(0);
    expect(estimate.rationale).toMatch(/No usable run-cost history/);
    expect(estimate.rationale).toMatch(/blocks nothing/);
  });

  it("refuses to estimate from a single run — one sample is noise, the same discipline the timing ledger states for its own consumers", () => {
    const estimate = estimateRunCostFromHistory({ records: [record("run_a", "article_body", 3.86)] });

    expect(MIN_RUN_COST_HISTORY_SAMPLES).toBe(2);
    expect(estimate.basis).toBe("no_history");
    expect(estimate.estimatedRunCostUsd).toBe(0);
  });

  it("ignores zero-cost runs as evidence about model spend, but never throws on them", () => {
    const estimate = estimateRunCostFromHistory({ records: [record("run_a", "publish_executor", 0), record("run_b", "publish_executor", 0)] });

    expect(estimate.sampleRuns).toBe(0);
    expect(estimate.basis).toBe("no_history");
  });
});

describe("the node timing aggregate now carries cost alongside duration", () => {
  it("folds emaCostUsd / p50CostUsd / p95CostUsd / totalCostUsd per node", () => {
    const aggregate = aggregateNodeTimingsByNode([
      record("run_a", "article_body", 1.5, "2026-09-01T00:00:00.000Z"),
      record("run_b", "article_body", 2.5, "2026-09-02T00:00:00.000Z")
    ]).article_body;

    expect(aggregate.count).toBe(2);
    expect(aggregate.totalCostUsd).toBe(4);
    // Nearest-rank on [1.5, 2.5]: p50 -> the smaller, p95 -> the larger (the definition nodeTimings.ts states).
    expect(aggregate.p50CostUsd).toBe(1.5);
    expect(aggregate.p95CostUsd).toBe(2.5);
    // EMA with alpha 0.3, seeded on the first sample: 0.3*2.5 + 0.7*1.5 = 1.8.
    expect(aggregate.emaCostUsd).toBeCloseTo(1.8, 6);
  });
});
