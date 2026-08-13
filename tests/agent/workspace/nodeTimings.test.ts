import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { MemoryNodeTimingRepository } from "../../../src/agent/repository/memory/MemoryNodeTimingRepository.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import {
  aggregateNodeTimingsByNode,
  buildNodeTimingRecord,
  foldEma,
  percentile,
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

    // Not a global $0 default: a model-dispatched node in the SAME run carries the mock run's own
    // nonzero estimated cost (mirrors nodeGating.test.ts's usage.byNode.input_triage assertion).
    const inputTriage = timings.find((t) => t.nodeId === "input_triage");
    expect(inputTriage?.outcome).toBe("completed");
    expect(inputTriage?.costUsd).toBeGreaterThan(0);
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
    const aggregates = result.data.plan.nodeTimingAggregates as Record<string, { count: number; emaDurationMs: number; p50DurationMs: number; p95DurationMs: number }>;
    expect(aggregates.input_triage?.count).toBeGreaterThan(0);
    expect(typeof aggregates.input_triage?.emaDurationMs).toBe("number");
    expect(typeof aggregates.input_triage?.p50DurationMs).toBe("number");
    expect(typeof aggregates.input_triage?.p95DurationMs).toBe("number");
  });

  it("returns nulls for an unknown run, exactly as before (no aggregates on a null plan)", async () => {
    const tools = createWorkspaceTools();
    const getRunCost = tools.find((t) => t.name === "workflow.get_run_cost")!;
    const result = (await getRunCost.execute({ runId: "run_missing" })) as { data: { ledger: unknown; plan: unknown } };
    expect(result.data).toEqual({ ledger: null, plan: null });
  });
});
