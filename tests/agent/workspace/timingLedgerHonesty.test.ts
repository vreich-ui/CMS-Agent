import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { MemoryNodeTimingRepository } from "../../../src/agent/repository/memory/MemoryNodeTimingRepository.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { runNextNode, startDryRun, STALL_MARGIN_MS } from "../../../src/agent/workspace/executor.js";
import { recordNodeTimingCompletion } from "../../../src/agent/workspace/nodeTimings.js";
import { recordModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// ACCEPTANCE — W0.3 (static-guesses brief, 2026-09-09).
//
// Two writers were producing samples nobody could reason from. An orchestrator retry recorded ONE
// sample carrying the LAST attempt's duration and EVERY attempt's cost — wrong in both halves at
// once. A reclaimed dispatch recorded nothing at all, because the reclaim deletes durationMs before
// anything observes it, which made the one failure class the stall bookkeeping exists to handle the
// one class absent from the history of it.

const failingRunner = (failures: number, code = "model_error") => {
  let calls = 0;
  const emptyRun = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;
  return vi.spyOn(registry, "getNodeRunner").mockReturnValue({
    supports: () => true,
    validateConfiguration: () => ({ ok: true as const }),
    run: async ({ node }: { node: WorkspaceNode }) => {
      calls += 1;
      if (calls <= failures) return { ok: false as const, code, message: `Injected ${code} #${calls}.` };
      return { ok: true as const, output: mockOutputForNode(node, emptyRun) };
    }
  } as never);
};

const rewindBackoff = async (store: ExecutionRepository, runId: string, nodeId: string) => {
  const run = (await store.getRun(runId))!;
  const node = run.nodes.find((state) => state.nodeId === nodeId)!;
  node.retry = { ...node.retry!, notBefore: new Date(Date.now() - 1_000).toISOString() };
  await store.saveRun(run);
};

describe("W0.3 — a retried node yields one sample per attempt, and its cost is never counted twice", () => {
  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    repositoryManager.getNodeTimingRepository().clear();
  });

  it("records the attempt that scheduleNodeRetry is about to erase", async () => {
    const spy = failingRunner(1);
    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-retry", input: "x" }, store);

      const afterFailure = await runNextNode(started.runId, { executionRepository: store });
      expect(afterFailure.nodes.find((state) => state.nodeId === "input_triage")?.status).toBe("queued");

      // The failed attempt is a sample NOW — before this, it never reached a terminal status and so
      // never reached the ledger at all.
      const afterOne = await repositoryManager.getNodeTimingRepository().list({ runId: started.runId, nodeId: "input_triage" });
      expect(afterOne).toHaveLength(1);
      expect(afterOne[0]).toMatchObject({ outcome: "failed", attempt: 1, projectId: "project-retry", executionMode: "mock" });

      await rewindBackoff(store, started.runId, "input_triage");
      const afterRetry = await runNextNode(started.runId, { executionRepository: store });
      expect(afterRetry.nodes.find((state) => state.nodeId === "input_triage")?.status).toBe("completed");

      // Two attempts, two samples — not one sample describing the survivor and billing both.
      const samples = (await repositoryManager.getNodeTimingRepository().list({ runId: started.runId, nodeId: "input_triage" }))
        .filter((record) => record.phase === undefined);
      expect(samples).toHaveLength(2);
      expect(samples.map((record) => record.outcome)).toEqual(["failed", "completed"]);
      expect(samples.map((record) => record.attempt)).toEqual([1, 2]);
    } finally {
      spy.mockRestore();
    }
  });

  // The arithmetic on its own, with REAL (status:"actual") usage — the mock path above records
  // estimated spend, which by W0.2 is correctly $0 and so cannot demonstrate the windowing.
  it("windows each attempt's actual cost, so N samples sum to the run's spend rather than N x it", async () => {
    const timings = new MemoryNodeTimingRepository();
    const attemptOneStartedAt = "2026-09-09T10:00:00.000Z";
    const attemptTwoStartedAt = "2026-09-09T10:05:00.000Z";
    await recordModelUsage({ runId: "run_delta", workflowId: "publishing_conductor", nodeId: "article_body", model: "gpt-x", provider: "openai", inputTokens: 100, outputTokens: 50, status: "actual", costUsdEstimate: 1.5, recordedAt: "2026-09-09T10:01:00.000Z" });

    const first = await recordNodeTimingCompletion({ runId: "run_delta", workflowId: "publishing_conductor", nodeId: "article_body", durationMs: 1000, outcome: "failed", attempt: 1, attemptStartedAt: attemptOneStartedAt }, timings);
    expect(first.costUsd).toBeCloseTo(1.5, 6);

    // The retry spends another $0.90; the usage ledger now totals $2.40 for this (runId, nodeId), and
    // the naive read — the one this replaces — would bill attempt 1 a second time.
    await recordModelUsage({ runId: "run_delta", workflowId: "publishing_conductor", nodeId: "article_body", model: "gpt-x", provider: "openai", inputTokens: 60, outputTokens: 30, status: "actual", costUsdEstimate: 0.9, recordedAt: "2026-09-09T10:06:00.000Z" });
    const second = await recordNodeTimingCompletion({ runId: "run_delta", workflowId: "publishing_conductor", nodeId: "article_body", durationMs: 1200, outcome: "completed", attempt: 2, attemptStartedAt: attemptTwoStartedAt }, timings);

    // The second sample carries only what the second attempt added.
    expect(second.costUsd).toBeCloseTo(0.9, 6);
    const total = (await timings.list({ runId: "run_delta", nodeId: "article_body" })).reduce((sum, record) => sum + record.costUsd, 0);
    expect(total).toBeCloseTo(2.4, 6);

    // Without a window, the whole node's spend is what a sample carries — correct for a node that ran
    // once, and exactly the double-count for one that was retried.
    const unwindowed = await recordNodeTimingCompletion({ runId: "run_delta", workflowId: "publishing_conductor", nodeId: "article_body", durationMs: 1200, outcome: "completed" }, timings);
    expect(unwindowed.costUsd).toBeCloseTo(2.4, 6);
  });

  it("a phase sample carries no cost and does not consume the node's spend", async () => {
    const timings = new MemoryNodeTimingRepository();
    await recordModelUsage({ runId: "run_phase", workflowId: "publishing_conductor", nodeId: "article_body", model: "gpt-x", provider: "openai", inputTokens: 100, outputTokens: 50, status: "actual", costUsdEstimate: 2 });

    const phase = await recordNodeTimingCompletion({ runId: "run_phase", workflowId: "publishing_conductor", nodeId: "article_body", durationMs: 400, outcome: "completed", phase: "validate" }, timings);
    expect(phase.costUsd).toBe(0);

    // The completion sample still gets the whole $2 — a phase sample carries no cost, so it cannot
    // consume any of the attempt's spend.
    const completion = await recordNodeTimingCompletion({ runId: "run_phase", workflowId: "publishing_conductor", nodeId: "article_body", durationMs: 1500, outcome: "completed" }, timings);
    expect(completion.costUsd).toBeCloseTo(2, 6);
  });
});

describe("W0.3 — a reclaimed dispatch is a sample, not a silence", () => {
  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    repositoryManager.getNodeTimingRepository().clear();
  });

  it("records the dead dispatch with terminatedBy 'reclaim' before erasing its state", async () => {
    const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-reclaim", input: "x" }, store);

    // Stage exactly the shape advanceRun's reclaim branch exists for: a node persisted "running" with
    // a claim whose window closed long ago, i.e. a driver killed mid-node.
    const staged = (await store.getRun(started.runId))!;
    staged.status = "running";
    const node = staged.nodes.find((state) => state.nodeId === "input_triage")!;
    const dispatchedAt = new Date(Date.now() - (120_000 + STALL_MARGIN_MS + 60_000)).toISOString();
    node.status = "running";
    node.startedAt = dispatchedAt;
    node.dispatch = { dispatchedAt, timeoutMs: 120_000, driver: "http_run_all", projectEndpointConfigured: false };
    await store.saveRun(staged);

    await runNextNode(started.runId, { executionRepository: store });

    const samples = await repositoryManager.getNodeTimingRepository().list({ runId: started.runId, nodeId: "input_triage" });
    const reclaimed = samples.find((record) => record.terminatedBy === "reclaim");
    expect(reclaimed).toBeDefined();
    expect(reclaimed).toMatchObject({ outcome: "failed", projectId: "project-reclaim" });
    // The duration is the real elapsed time under the claim, not the 0 a deleted durationMs implies.
    expect(reclaimed!.durationMs).toBeGreaterThan(120_000);
  });
});
