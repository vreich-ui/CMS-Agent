import { beforeEach, describe, expect, it } from "vitest";
import { assessRunStall, DISPATCH_DEADLINE_MARGIN_MS } from "../../../src/agent/workspace/executor.js";
import { runContinuationTick, TASK_TIMEOUT_MS } from "../../../src/agent/workspace/runContinuation.js";
import { MemoryDriverHealthRepository } from "../../../src/agent/repository/memory/MemoryDriverHealthRepository.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W0 T0.4 + T1.2 acceptance.
// T0.4: `stall` could say "not touched for 90s" and nothing else, so a run 2 hours into a 12-minute
//       pipeline read the same as one 91 seconds past its last save.
// T1.2: on 2026-09-04 article_body was dispatched ~10s before the 300s Cloud Run task timeout; the
//       task was killed mid-node, the claim expired 90s later, and the node was re-dispatched 12.7
//       minutes and ~$0.60 later. A dispatch that cannot fit in the task must not start.

const runAt = (startedAtMsAgo: number, remaining: string[]): WorkflowExecutionRecord => ({
  runId: "run_overdue", workflowId: "publishing_conductor", projectId: "dr-lurie", status: "running", executionMode: "openai",
  startedAt: new Date(Date.now() - startedAtMsAgo).toISOString(),
  updatedAt: new Date(Date.now() - 10_000).toISOString(),
  nodes: [
    { nodeId: "input_triage", status: "completed" },
    ...remaining.map((nodeId) => ({ nodeId, status: "queued" as const }))
  ],
  artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
});

// article_body p95 60s + learning_recorder p95 40s = 100s of remaining work; 3x = 300s.
const timing = { p95DurationMsByNode: { article_body: 60_000, learning_recorder: 40_000 } };

describe("W0 T0.4 — overdue-run flag", () => {
  it("flags a 2-hour-old run against its own measured p95, and leaves a 5-minute-old one alone", () => {
    const overdue = assessRunStall(runAt(2 * 60 * 60_000, ["article_body", "learning_recorder"]), new Date(), timing);
    expect(overdue?.stalledSuspected).toBe(true);
    expect(overdue?.advice).toMatch(/^overdue: no driver progress/);

    const young = assessRunStall(runAt(5 * 60_000, ["article_body", "learning_recorder"]), new Date(), timing);
    expect(young?.advice ?? "").not.toMatch(/overdue/);
  });

  it("says nothing new without measured timings — every existing caller keeps today's behaviour", () => {
    const noTimings = assessRunStall(runAt(2 * 60 * 60_000, ["article_body"]), new Date());
    expect(noTimings?.advice ?? "").not.toMatch(/overdue/);
  });

  it("carries the tick's own driver-health record into the stall block (T0.3)", () => {
    const run = runAt(60_000, ["article_body"]);
    run.driverHealth = { lastSeenByTickAt: "2026-09-04T14:06:00.000Z", lastRefusal: { code: "skip_dispatch_in_flight", at: "2026-09-04T14:06:00.000Z" } };
    const stall = assessRunStall(run, new Date());
    expect(stall?.lastSeenByTickAt).toBe("2026-09-04T14:06:00.000Z");
    expect(stall?.lastRefusal?.code).toBe("skip_dispatch_in_flight");
  });
});

const fakeStore = (records: WorkflowExecutionRecord[]): ExecutionRepository => ({
  listRuns: async () => records,
  listRunsPage: async () => ({ runs: records, matchedCount: records.length, hasMore: false }),
  getRun: async (runId: string) => records.find((record) => record.runId === runId),
  createRun: async (record) => record,
  saveRun: async (record) => { const index = records.findIndex((candidate) => candidate.runId === record.runId); records[index] = record; return record; },
  resetRun: async (_runId, next) => next,
  health: async () => ({ backend: "memory", ok: true } as never)
});

const queuedRun = (): WorkflowExecutionRecord => ({
  runId: "run_deadline", workflowId: "publishing_conductor", projectId: "dr-lurie", status: "queued", executionMode: "mock",
  startedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date(Date.now() - 10_000).toISOString(),
  nodes: [{ nodeId: "article_body", status: "queued" }], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
});

describe("W0 T1.2 — deadline-aware dispatch", () => {
  beforeEach(() => { delete process.env.WORKSPACE_STORE; delete process.env.TASK_TIMEOUT_MS; resetRepositoryManager(); });

  const tickWith = async (elapsedMs: number, records: WorkflowExecutionRecord[], nodeTimeoutMs = 300_000) => {
    const advanced: string[] = [];
    const base = Date.now();
    let calls = 0;
    const result = await runContinuationTick({
      executionRepository: fakeStore(records),
      driverHealthRepository: new MemoryDriverHealthRepository(),
      projectRepository: repositoryManager.getProjectRepository(),
      env: { DR_LURIE_MCP_ENDPOINT: "https://dr-lurie.example/mcp" },
      taskTimeoutMs: 600_000,
      // The tick's own soft budget is deliberately out of the way here: this test is about the HARD
      // task ceiling. In production the two interact (a 240s budget inside a 300s task is exactly how
      // article_body got dispatched 10s before the kill on 2026-09-04).
      timeBudgetMs: 600_000,
      // First call returns the tick's start; every later call is `elapsedMs` into the task.
      now: () => new Date(calls++ === 0 ? base : base + elapsedMs),
      dispatchTimeoutMs: async () => nodeTimeoutMs,
      advance: async (runId) => { advanced.push(runId); const record = records.find((candidate) => candidate.runId === runId)!; record.status = "completed"; return record; }
    });
    return { result, advanced };
  };

  it("defers a 300s dispatch with 50s of task left, and dispatches the same node at 10s elapsed", async () => {
    const late = await tickWith(550_000, [queuedRun()]);
    expect(late.advanced).toEqual([]);
    expect(late.result.deferredDeadline).toBe(true);
    expect(late.result.driven[0]).toMatchObject({ code: "deferred_deadline", steps: 0 });
    expect(late.result.driven[0].deferredReason).toMatch(/300000ms/);

    const early = await tickWith(10_000, [queuedRun()]);
    expect(early.advanced).toEqual(["run_deadline"]);
    expect(early.result.deferredDeadline).toBeUndefined();
  });

  it("dispatches a node that cannot fit a whole fresh task rather than deferring it forever", async () => {
    // A deterministic capture stage claims 300s; before C2.2 the task itself was 300s. Deferring such
    // a node would refuse it on every future tick too — a livelock, which is strictly worse than the
    // mid-flight kill this task exists to avoid.
    const oversized = await tickWith(10_000, [queuedRun()], 600_000);
    expect(oversized.advanced).toEqual(["run_deadline"]);
    expect(oversized.result.deferredDeadline).toBeUndefined();
  });

  it("reads the task ceiling from the deploy's own env var, defaulting to the pre-C2.2 300s", () => {
    expect(TASK_TIMEOUT_MS({})).toBe(300_000);
    expect(TASK_TIMEOUT_MS({ TASK_TIMEOUT_MS: "600000" })).toBe(600_000);
    expect(DISPATCH_DEADLINE_MARGIN_MS).toBe(15_000);
  });
});
