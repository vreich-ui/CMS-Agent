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

// ACCEPTANCE — W0.5 (static-guesses brief, 2026-09-09). Four tenants share every workflowId, so
// "this workflow's prior run totals" meant "every tenant's, pooled". A live consumer that can BLOCK
// a run was charging each site the average of four sites' economics.
const tenantRecord = (runId: string, projectId: string | undefined, costUsd: number, recordedAt: string): NodeTimingRecord => ({
  timingId: `t_${runId}`,
  runId,
  workflowId: "publishing",
  nodeId: "article_body",
  durationMs: 1000,
  costUsd,
  outcome: "completed",
  recordedAt,
  ...(projectId ? { projectId } : {})
});

describe("estimateRunCostFromHistory — one tenant's history, not four tenants' average", () => {
  // dr-lurie runs expensive articles; zilberman runs cheap structure batches. Pooled, both get the
  // same floor and both are wrong.
  const records = [
    tenantRecord("run_dl1", "dr-lurie", 4.0, "2026-09-01T00:00:00.000Z"),
    tenantRecord("run_dl2", "dr-lurie", 4.4, "2026-09-02T00:00:00.000Z"),
    tenantRecord("run_zb1", "zilberman", 0.3, "2026-09-03T00:00:00.000Z"),
    tenantRecord("run_zb2", "zilberman", 0.5, "2026-09-04T00:00:00.000Z")
  ];

  it("gives zilberman a different floor from dr-lurie, each from its own runs", () => {
    const drLurie = estimateRunCostFromHistory({ records, projectId: "dr-lurie" });
    const zilberman = estimateRunCostFromHistory({ records, projectId: "zilberman" });

    expect(drLurie.scope).toBe("project");
    expect(zilberman.scope).toBe("project");
    expect(drLurie.estimatedRunCostUsd).toBe(4);
    expect(zilberman.estimatedRunCostUsd).toBe(0.3);
    expect(drLurie.estimatedRunCostUsd).not.toBe(zilberman.estimatedRunCostUsd);
    // Neither figure was contaminated by the other tenant's runs.
    expect(drLurie.observedRunCostsUsd).toEqual([4, 4.4]);
    expect(zilberman.observedRunCostsUsd).toEqual([0.3, 0.5]);
  });

  it("falls back to pooled history when a tenant has too little of its own, and SAYS it did", () => {
    const fernwell = estimateRunCostFromHistory({ records, projectId: "fernwell" });
    expect(fernwell.scope).toBe("pooled");
    expect(fernwell.projectId).toBe("fernwell");
    expect(fernwell.basis).toBe("workflow_history");
    expect(fernwell.observedRunCostsUsd).toEqual([0.3, 0.5, 4, 4.4]);
    expect(fernwell.rationale).toContain("POOLED ACROSS TENANTS");
  });

  it("omitting projectId behaves exactly as it did before scoping existed", () => {
    const pooled = estimateRunCostFromHistory({ records });
    expect(pooled.scope).toBe("pooled");
    expect(pooled.projectId).toBeUndefined();
    expect(pooled.rationale).not.toContain("POOLED ACROSS TENANTS");
  });

  it("pre-W0.1 records carry no projectId and are never counted as any tenant's own history", () => {
    const legacy = [
      tenantRecord("run_l1", undefined, 9.0, "2026-08-01T00:00:00.000Z"),
      tenantRecord("run_l2", undefined, 9.5, "2026-08-02T00:00:00.000Z")
    ];
    const scoped = estimateRunCostFromHistory({ records: legacy, projectId: "dr-lurie" });
    // Deep enough to be usable POOLED, but nothing in it can be attributed to dr-lurie — so the
    // estimate is the pooled one, flagged, rather than a confident per-tenant figure.
    expect(scoped.scope).toBe("pooled");
    expect(scoped.estimatedRunCostUsd).toBe(9);
  });

  it("phase samples are a duration breakdown and never inflate the run total", () => {
    const withPhases: NodeTimingRecord[] = [
      tenantRecord("run_p1", "dr-lurie", 3.0, "2026-09-01T00:00:00.000Z"),
      { ...tenantRecord("run_p1", "dr-lurie", 0, "2026-09-01T00:00:01.000Z"), timingId: "t_run_p1_phase", phase: "validate" },
      tenantRecord("run_p2", "dr-lurie", 3.4, "2026-09-02T00:00:00.000Z")
    ];
    const estimate = estimateRunCostFromHistory({ records: withPhases, projectId: "dr-lurie" });
    expect(estimate.observedRunCostsUsd).toEqual([3, 3.4]);
    expect(estimate.sampleRecords).toBe(2);
  });
});

// The minimum-samples rule is unchanged by scoping: below it, in BOTH populations, the estimate is 0
// and the floor blocks nothing.
describe("estimateRunCostFromHistory — an unmeasured floor still blocks nothing", () => {
  it("returns 0 with scope 'none' when neither the tenant nor the pool has enough history", () => {
    const estimate = estimateRunCostFromHistory({
      records: [tenantRecord("run_only", "dr-lurie", 4.0, "2026-09-01T00:00:00.000Z")],
      projectId: "dr-lurie"
    });
    expect(estimate.estimatedRunCostUsd).toBe(0);
    expect(estimate.basis).toBe("no_history");
    expect(estimate.scope).toBe("none");
    expect(MIN_RUN_COST_HISTORY_SAMPLES).toBe(2);
  });
});
