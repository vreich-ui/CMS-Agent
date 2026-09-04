import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { decideRunContinuation } from "../../../src/agent/workspace/runContinuation.js";
import { decideNodeRetry, MAX_ORCHESTRATOR_RETRIES, retryBackoffMs } from "../../../src/agent/workspace/nodeRetryPolicy.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// W1 T1.1 acceptance. 3,534 minutes — 89% of active wall clock across the last 25 dr-lurie runs —
// were runs sitting "failed" waiting for a human to press workflow.retry_node. These tests pin the
// four things that has to be true for a driver to press it instead: it retries the transient codes,
// it stops after three attempts, it NEVER retries a ceiling or a gate, and a run waiting out a
// backoff is neither "completed" nor a run the tick spins on.

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
  // Fast-forward the clock the only way that does not make the test wait a real minute: move the
  // node's own notBefore into the past, exactly as the passage of time would.
  const run = (await store.getRun(runId))!;
  const node = run.nodes.find((state) => state.nodeId === nodeId)!;
  node.retry = { ...node.retry!, notBefore: new Date(Date.now() - 1_000).toISOString() };
  await store.saveRun(run);
};

describe("W1 T1.1 — the orchestrator retries instead of parking the run on a human", () => {
  it("retries a transient model_error, keeps the run running, and completes without a human", async () => {
    const spy = failingRunner(1);
    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-retry", input: "x" }, store);

      const afterFailure = await runNextNode(started.runId, { executionRepository: store });
      const node = afterFailure.nodes.find((state) => state.nodeId === "input_triage")!;

      // The run did NOT fail: it is running, with the node queued behind a backoff.
      expect(afterFailure.status).toBe("running");
      expect(node.status).toBe("queued");
      expect(node.retry).toMatchObject({ attempt: 1, code: "model_error" });
      expect(Date.parse(node.retry!.notBefore)).toBeGreaterThan(Date.now());
      // W0 T0.1 still holds: the attempt that failed is on the record.
      expect(node.errorHistory).toHaveLength(1);
      expect(afterFailure.errors.some((entry) => entry.startsWith("input_triage:model_error:retried@"))).toBe(true);

      // Inside the backoff the tick refuses — it does not spin on a run with nothing due.
      expect(decideRunContinuation(afterFailure).code).toBe("skip_retry_backoff");
      // ...and an advance during the backoff must never stamp the run "completed".
      const duringBackoff = await runNextNode(started.runId, { executionRepository: store });
      expect(duringBackoff.status).toBe("running");

      await rewindBackoff(store, started.runId, "input_triage");
      const afterRetry = await runNextNode(started.runId, { executionRepository: store });
      const retried = afterRetry.nodes.find((state) => state.nodeId === "input_triage")!;
      expect(retried.status).toBe("completed");
      expect(retried.retry).toBeUndefined();
      expect(retried.errorHistory).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails the run after three attempts — a persistent failure still reaches a human", async () => {
    const spy = failingRunner(99);
    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-retry-exhaust", input: "x" }, store);

      await runNextNode(started.runId, { executionRepository: store });
      await rewindBackoff(store, started.runId, "input_triage");
      await runNextNode(started.runId, { executionRepository: store });
      await rewindBackoff(store, started.runId, "input_triage");
      const third = await runNextNode(started.runId, { executionRepository: store });

      const node = third.nodes.find((state) => state.nodeId === "input_triage")!;
      expect(third.status).toBe("failed");
      expect(node.status).toBe("failed");
      // Three attempts total: two retries recorded in history, the third is the live failure.
      expect(node.errorHistory).toHaveLength(MAX_ORCHESTRATOR_RETRIES);
      expect(node.errors?.[0]).toBe("model_error");
      // And the tick leaves a failed run exactly where the executor put it.
      expect(decideRunContinuation(third).code).toBe("skip_not_active");
    } finally {
      spy.mockRestore();
    }
  });

  it("never auto-retries a budget ceiling or an approval gate", () => {
    const at = new Date();
    expect(decideNodeRetry({}, "budget_exceeded", at)).toEqual({ retry: false, reason: "not_retryable" });
    expect(decideNodeRetry({}, "approval_required", at)).toEqual({ retry: false, reason: "not_retryable" });
    expect(decideNodeRetry({}, "cancelled", at)).toEqual({ retry: false, reason: "not_retryable" });
    // An unknown code is non-retryable by default: a new runner error is a human's call, not a loop.
    expect(decideNodeRetry({}, "output_schema_violation", at)).toEqual({ retry: false, reason: "not_retryable" });
    expect(decideNodeRetry({}, "model_error", at)).toMatchObject({ retry: true, attempt: 1 });
    expect(decideNodeRetry({ retry: { attempt: MAX_ORCHESTRATOR_RETRIES, notBefore: at.toISOString(), code: "model_error", scheduledAt: at.toISOString() } }, "model_error", at))
      .toEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it("backs off exponentially — 60s then 120s", () => {
    expect(retryBackoffMs(1)).toBe(60_000);
    expect(retryBackoffMs(2)).toBe(120_000);
  });

  it("a budget_exceeded failure fails the node immediately, with no retry marker", async () => {
    const spy = failingRunner(99, "budget_exceeded");
    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-retry-budget", input: "x" }, store);
      const failed = await runNextNode(started.runId, { executionRepository: store });
      const node = failed.nodes.find((state) => state.nodeId === "input_triage")!;
      expect(failed.status).toBe("failed");
      expect(node.status).toBe("failed");
      expect(node.retry).toBeUndefined();
      expect(node.errorHistory).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("two drivers racing a due retry dispatch it once (the CAS still holds)", async () => {
    const spy = failingRunner(1);
    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-retry-cas", input: "x" }, store);
      await runNextNode(started.runId, { executionRepository: store });
      await rewindBackoff(store, started.runId, "input_triage");

      const [a, b] = await Promise.all([
        runNextNode(started.runId, { executionRepository: store }),
        runNextNode(started.runId, { executionRepository: store })
      ]);
      for (const record of [a, b]) {
        const node = record.nodes.find((state) => state.nodeId === "input_triage")!;
        // Whichever ordering the lock produced, the node ran once: one superseded attempt, one success.
        expect(node.errorHistory ?? []).toHaveLength(1);
      }
      const stored = (await store.getRun(started.runId))!;
      expect(stored.nodes.find((state) => state.nodeId === "input_triage")!.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });
});
