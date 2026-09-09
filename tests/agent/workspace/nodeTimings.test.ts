import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { MemoryNodeTimingRepository } from "../../../src/agent/repository/memory/MemoryNodeTimingRepository.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import {
  aggregateNodeTimingsByEra,
  aggregateNodeTimingsByNode,
  buildNodeTimingRecord,
  foldEma,
  percentile,
  MODEL_ROUTE_ERA,
  UNATTRIBUTED_ROUTE_ERA,
  type NodeTimingRecord
} from "../../../src/agent/workspace/nodeTimings.js";

// T6 (Wave 3, ships dark, run_1786557897658_elj34j) — nothing under test here is read by any
// decision path. These tests prove the ledger records what it should and exposes it read-only; see
// nodeTimings.ts's header for the three follow-ups explicitly gated on two runs of data.

const record = (overrides: Partial<NodeTimingRecord> & Pick<NodeTimingRecord, "nodeId" | "durationMs" | "recordedAt">): NodeTimingRecord =>
  buildNodeTimingRecord({ runId: "run_x", workflowId: "publishing_conductor", costUsd: 0, outcome: "completed", ...overrides });

describe("foldEma (pure, alpha=0.3)", () => {
  it("takes the first sample as EMA_0, unsmoothed", () => {
    expect(foldEma(undefined, 100)).toBe(100);
  });

  it("folds a chronological series with the standard EMA recurrence", () => {
    // ema1=100; ema2=0.3*200+0.7*100=130; ema3=0.3*300+0.7*130=181
    let ema = foldEma(undefined, 100);
    ema = foldEma(ema, 200);
    ema = foldEma(ema, 300);
    expect(ema).toBeCloseTo(181, 6);
  });
});

// Percentile definition: NEAREST-RANK, rank = ceil(p/100 * n) 1-based, no interpolation — see
// nodeTimings.ts's own comment on percentile() for the full statement of why.
describe("percentile (nearest-rank)", () => {
  it("n=1: every percentile returns the single sample", () => {
    expect(percentile([420], 50)).toBe(420);
    expect(percentile([420], 95)).toBe(420);
  });

  it("n=2: p50 is the smaller sample, p95 is the larger — the case a linear-interpolation definition would answer differently", () => {
    expect(percentile([100, 300], 50)).toBe(100);
    expect(percentile([100, 300], 95)).toBe(300);
  });

  it("returns 0 for an empty sample set", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe("aggregateNodeTimingsByNode (pure)", () => {
  it("computes count, EMA, p50 and p95 for a known 5-sample series", () => {
    const records: NodeTimingRecord[] = [100, 200, 300, 400, 500].map((durationMs, i) =>
      record({ nodeId: "draft_writer", durationMs, recordedAt: `2026-08-12T00:0${i}:00.000Z` })
    );
    const aggregates = aggregateNodeTimingsByNode(records);
    expect(aggregates.draft_writer.count).toBe(5);
    // ema5 = fold(100,200,300,400,500) = 322.69... -> rounded to the nearest ms.
    expect(aggregates.draft_writer.emaDurationMs).toBe(323);
    expect(aggregates.draft_writer.p50DurationMs).toBe(300); // rank=ceil(0.5*5)=3 -> sorted[2]
    expect(aggregates.draft_writer.p95DurationMs).toBe(500); // rank=ceil(0.95*5)=5 -> sorted[4]
  });

  it("folds EMA in recordedAt-chronological order regardless of the input array's own order", () => {
    const records: NodeTimingRecord[] = [
      record({ nodeId: "a", durationMs: 300, recordedAt: "2026-08-12T00:02:00.000Z" }),
      record({ nodeId: "a", durationMs: 100, recordedAt: "2026-08-12T00:00:00.000Z" }),
      record({ nodeId: "a", durationMs: 200, recordedAt: "2026-08-12T00:01:00.000Z" })
    ];
    // Chronological order is 100,200,300 -> ema3=181 (same arithmetic as the foldEma test above).
    expect(aggregateNodeTimingsByNode(records).a.emaDurationMs).toBe(181);
  });

  it("keeps each nodeId's samples independent", () => {
    const records: NodeTimingRecord[] = [
      record({ nodeId: "a", durationMs: 100, recordedAt: "t1" }),
      record({ nodeId: "b", durationMs: 900, recordedAt: "t1" }),
      record({ nodeId: "a", durationMs: 200, recordedAt: "t2" })
    ];
    const aggregates = aggregateNodeTimingsByNode(records);
    expect(aggregates.a.count).toBe(2);
    expect(aggregates.b.count).toBe(1);
    expect(aggregates.b.emaDurationMs).toBe(900);
  });
});

describe("MemoryNodeTimingRepository", () => {
  it("stores a recorded completion and lists it back with the expected shape", async () => {
    const repo = new MemoryNodeTimingRepository();
    const stored = await repo.record(buildNodeTimingRecord({ runId: "run_1", workflowId: "publishing_conductor", nodeId: "article_body", durationMs: 4200, costUsd: 0.0213, outcome: "completed" }));

    const listed = await repo.list({ workflowId: "publishing_conductor" });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ runId: "run_1", workflowId: "publishing_conductor", nodeId: "article_body", durationMs: 4200, costUsd: 0.0213, outcome: "completed" });
    expect(listed[0].timingId).toBe(stored.timingId);
    expect(listed[0].recordedAt).toEqual(expect.any(String));

    // Filters actually filter — an unrelated runId/nodeId query finds nothing.
    expect(await repo.list({ runId: "run_other" })).toEqual([]);
    expect(await repo.list({ nodeId: "other_node" })).toEqual([]);
  });
});

// Drives a real dry run through executor.ts's actual dispatch loop (executeRunnableNode /
// advanceRun) — the same path production traffic takes — so this proves the recorder is actually
// wired into the conductor, not just callable in isolation.
const advanceUntil = async (runId: string, store: ExecutionRepository, done: (run: WorkflowExecutionRecord) => boolean) => {
  let run = (await getRun(runId, store))!;
  for (let i = 0; i < 40 && !done(run) && !["completed", "failed", "blocked", "cancelled"].includes(run.status); i++) {
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run;
};
const reached = (nodeId: string) => (run: WorkflowExecutionRecord) => ["completed", "blocked", "failed", "skipped"].includes(run.nodes.find((node) => node.nodeId === nodeId)?.status ?? "queued");

describe("recordNodeTiming — deterministic (non-model) completions land too", () => {
  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    repositoryManager.getNodeTimingRepository().clear();
  });

  it("records a skip-predicate completion with costUsd 0, alongside a model-dispatched node's nonzero cost", async () => {
    const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: { contentClass: "docs", topic: "Object lifecycle runbook" } }, store);
    const run = await advanceUntil(started.runId, store, reached("research"));
    expect(run.nodes.find((n) => n.nodeId === "research")?.status).toBe("skipped");

    const timings = await repositoryManager.getNodeTimingRepository().list({ runId: run.runId });
    const research = timings.find((t) => t.nodeId === "research");
    expect(research).toMatchObject({ outcome: "skipped", costUsd: 0, workflowId: "publishing_conductor", runId: run.runId });

    // W0.2 — THE COST HALF IS THE ACTUAL HALF. This is a MOCK run: its usage records are
    // status:"estimated", which the budget guard has never counted as money (R-20). costUsd used to
    // be totalCostUsdEstimate and so reported a mock run's imaginary spend as ledger cost, which is
    // the figure the live EV floor then read. The spend is still fully visible — it just sits in
    // estimatedCostUsd, where nothing countable reads it.
    const inputTriage = timings.find((t) => t.nodeId === "input_triage");
    expect(inputTriage?.outcome).toBe("completed");
    expect(inputTriage?.costUsd).toBe(0);
    expect(inputTriage?.estimatedCostUsd ?? 0).toBeGreaterThan(0);
  });

  it("W0.1 — every sample carries the tenant, the execution mode and the route era it came from", async () => {
    const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: { contentClass: "docs", topic: "Object lifecycle runbook" } }, store);
    const run = await advanceUntil(started.runId, store, reached("research"));

    const timings = await repositoryManager.getNodeTimingRepository().list({ runId: run.runId });
    expect(timings.length).toBeGreaterThan(0);
    for (const timing of timings) {
      expect(timing.projectId).toBe("project-a");
      expect(timing.executionMode).toBe("mock");
      expect(typeof timing.routeEra).toBe("string");
    }
    // A model-dispatched node records the model era; nothing here is left unattributed.
    expect(timings.find((t) => t.nodeId === "input_triage")?.routeEra).toBe(MODEL_ROUTE_ERA);

    // And the projectId filter actually discriminates rather than being carried and ignored.
    const repo = repositoryManager.getNodeTimingRepository();
    expect(await repo.list({ runId: run.runId, projectId: "project-a" })).toHaveLength(timings.length);
    expect(await repo.list({ runId: run.runId, projectId: "zilberman" })).toEqual([]);
  });
});

describe("W0.1/W0.2 — aggregation excludes what it cannot count", () => {
  const sample = (over: Partial<NodeTimingRecord>): NodeTimingRecord => buildNodeTimingRecord({
    runId: "run_a", workflowId: "publishing_conductor", nodeId: "artifact_plan",
    durationMs: 1000, costUsd: 1, outcome: "completed", ...over
  });

  it("a mock sample is absent by default and present with includeMock", () => {
    const records = [sample({ executionMode: "mock", routeEra: MODEL_ROUTE_ERA, recordedAt: "2026-09-01T00:00:00.000Z" })];
    expect(aggregateNodeTimingsByNode(records).artifact_plan).toBeUndefined();
    expect(aggregateNodeTimingsByNode(records, { includeMock: true }).artifact_plan?.count).toBe(1);
  });

  it("a phase sample never counts as a node completion", () => {
    const records = [
      sample({ routeEra: MODEL_ROUTE_ERA, executionMode: "openai", recordedAt: "2026-09-01T00:00:00.000Z" }),
      sample({ routeEra: MODEL_ROUTE_ERA, executionMode: "openai", phase: "validate", durationMs: 400, costUsd: 0, recordedAt: "2026-09-01T00:00:01.000Z" })
    ];
    expect(aggregateNodeTimingsByNode(records).artifact_plan?.count).toBe(1);
    expect(aggregateNodeTimingsByNode(records, { includePhases: true }).artifact_plan?.count).toBe(2);
  });

  // THE era-mixing case the whole wave turns on: artifact_plan's old model-era samples (118s) against
  // its current deterministic route (0.2s). Pooled, the p95 says 118s and a stall threshold derived
  // from it looks justified; era-keyed, the node reports what it now actually does.
  it("the node view reports the current era only, and says how many samples that set aside", () => {
    const records = [
      sample({ routeEra: MODEL_ROUTE_ERA, executionMode: "openai", durationMs: 118_000, recordedAt: "2026-09-01T00:00:00.000Z" }),
      sample({ routeEra: MODEL_ROUTE_ERA, executionMode: "openai", durationMs: 120_000, recordedAt: "2026-09-02T00:00:00.000Z" }),
      sample({ routeEra: "artifactPlanDeterministic", executionMode: "openai", durationMs: 200, recordedAt: "2026-09-03T00:00:00.000Z" })
    ];
    const byNode = aggregateNodeTimingsByNode(records).artifact_plan!;
    expect(byNode.routeEra).toBe("artifactPlanDeterministic");
    expect(byNode.count).toBe(1);
    expect(byNode.p95DurationMs).toBe(200);
    expect(byNode.eraExcludedCount).toBe(2);

    // Nothing is lost — the era view still holds both programs, separately.
    const byEra = aggregateNodeTimingsByEra(records);
    expect(byEra[`artifact_plan::${MODEL_ROUTE_ERA}`]?.p95DurationMs).toBe(120_000);
    expect(byEra["artifact_plan::artifactPlanDeterministic"]?.p95DurationMs).toBe(200);
  });

  // Old records must keep aggregating: a migration that made the existing 26-41 samples per node
  // unreadable would buy honesty at the price of having no history at all.
  it("pre-W0.1 records (no routeEra) still aggregate, and stand aside once attributed samples arrive", () => {
    const legacy = [
      sample({ durationMs: 5_000, recordedAt: "2026-08-01T00:00:00.000Z" }),
      sample({ durationMs: 7_000, recordedAt: "2026-08-02T00:00:00.000Z" })
    ];
    expect(aggregateNodeTimingsByNode(legacy).artifact_plan?.count).toBe(2);
    expect(aggregateNodeTimingsByNode(legacy).artifact_plan?.routeEra).toBe(UNATTRIBUTED_ROUTE_ERA);

    const withAttributed = [...legacy, sample({ routeEra: MODEL_ROUTE_ERA, durationMs: 9_000, recordedAt: "2026-09-03T00:00:00.000Z" })];
    const aggregate = aggregateNodeTimingsByNode(withAttributed).artifact_plan!;
    expect(aggregate.routeEra).toBe(MODEL_ROUTE_ERA);
    expect(aggregate.count).toBe(1);
    expect(aggregate.eraExcludedCount).toBe(2);
  });
});

describe("workflow.get_run_cost plan block — read-only nodeTimingAggregates", () => {
  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    repositoryManager.getNodeTimingRepository().clear();
  });

  it("adds nodeTimingAggregates without changing any pre-existing plan or ledger field", async () => {
    const tools = createWorkspaceTools();
    const startDry = tools.find((t) => t.name === "workflow.start_dry_run")!;
    const runNode = tools.find((t) => t.name === "workflow.run_next_node")!;
    const getRunCost = tools.find((t) => t.name === "workflow.get_run_cost")!;

    const started = (await startDry.execute({ executionMode: "mock", projectId: "dr-lurie", input: {} })) as { data: { run: { runId: string } } };
    const runId = started.data.run.runId;
    await runNode.execute({ runId });
    await runNode.execute({ runId });

    const result = (await getRunCost.execute({ runId })) as { data: { ledger: Record<string, unknown>; plan: Record<string, unknown> } };
    // Every field conductorTools.test.ts already asserts on for this exact scenario, unchanged.
    const ledger = result.data.ledger as { reusableNodeIds: string[]; stages: { nodeId: string; reusable: boolean }[]; totalTokens: number };
    expect(ledger.reusableNodeIds).toContain("input_triage");
    expect(ledger.stages.find((stage) => stage.nodeId === "input_triage")?.reusable).toBe(true);
    expect(ledger.totalTokens).toBeGreaterThan(0);
    expect(result.data.plan.strategy).toBe("full_run");
    expect(result.data.plan.reusableStages).toContain("input_triage");

    // The read-only addition: per-nodeId {count, emaDurationMs, p50DurationMs, p95DurationMs}.
    //
    // W0.2 — this run is MOCK, so its samples are deliberately absent from the countable aggregates.
    // The plan block is not empty-because-broken; it is empty because a mock run is not evidence
    // about what a live run costs or how long it takes, and this was the one place that difference
    // was being papered over. `includeMock` proves the records exist and the exclusion is the rule
    // doing its job.
    const aggregates = result.data.plan.nodeTimingAggregates as Record<string, { count: number; emaDurationMs: number; p50DurationMs: number; p95DurationMs: number }>;
    expect(aggregates.input_triage).toBeUndefined();

    const records = await repositoryManager.getNodeTimingRepository().list({ runId });
    const withMock = aggregateNodeTimingsByNode(records, { includeMock: true });
    expect(withMock.input_triage?.count).toBeGreaterThan(0);
    expect(typeof withMock.input_triage?.emaDurationMs).toBe("number");
    expect(typeof withMock.input_triage?.p50DurationMs).toBe("number");
    expect(typeof withMock.input_triage?.p95DurationMs).toBe("number");
    expect(withMock.input_triage?.routeEra).toBe(MODEL_ROUTE_ERA);
  });

  it("returns nulls for an unknown run, exactly as before (no aggregates on a null plan)", async () => {
    const tools = createWorkspaceTools();
    const getRunCost = tools.find((t) => t.name === "workflow.get_run_cost")!;
    const result = (await getRunCost.execute({ runId: "run_missing" })) as { data: { ledger: unknown; plan: unknown } };
    expect(result.data).toEqual({ ledger: null, plan: null });
  });
});
