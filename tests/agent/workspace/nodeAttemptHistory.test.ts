import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { retryNode, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { listNodeExecutions } from "../../../src/agent/workspace/nodeRuntime.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// W0 T0.1 acceptance. The measured defect: across the last 25 publishing_conductor runs, 11 human
// retries and exactly ONE surviving pre-retry failure reason. A node that failed, was retried and
// then succeeded left nothing behind — node.errors cleared by the retry, run.errors dropped by the
// completion — so "why did these runs fail" was unanswerable for 10 of the 11.

// W1 T1.1 (2026-09-04): the injected code is now a NON-retryable one (max_turns_exceeded).
// model_timeout is auto-retried by the orchestrator since W1, so it no longer produces the
// terminal failure THIS test is about — the subject here is unchanged, only the way the
// failure is provoked.

describe("W0 T0.1 — failure history survives a retry", () => {
  it("keeps the failed attempt on the node, marks the run entry retried, and lists one record per attempt", async () => {
    let calls = 0;
    const emptyRun = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async ({ node }: { node: WorkspaceNode }) => {
        calls += 1;
        if (calls === 1) return { ok: false as const, code: "max_turns_exceeded", message: "Injected provider failure." };
        return { ok: true as const, output: mockOutputForNode(node, emptyRun) };
      }
    } as never);

    try {
      const manager = new RepositoryManager();
      const store: ExecutionRepository = manager.getExecutionRepository();
      const usage = manager.getUsageRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-history", input: "x" }, store);

      const failed = await runNextNode(started.runId, { executionRepository: store });
      expect(failed.status).toBe("failed");
      expect(failed.errors).toEqual(["input_triage:max_turns_exceeded"]);

      const retried = (await retryNode(started.runId, "input_triage", { executionRepository: store }))!;
      const node = retried.nodes.find((state) => state.nodeId === "input_triage")!;
      expect(node.status).toBe("completed");

      // 1. The superseded attempt is on the node, with the code the retry cleared.
      expect(node.errorHistory).toHaveLength(1);
      expect(node.errorHistory![0]).toMatchObject({ attempt: 1, status: "failed", code: "max_turns_exceeded", message: "Injected provider failure." });

      // 2. The run-level ledger still names the original failure (marked, not deleted).
      expect(retried.errors.some((entry) => entry.startsWith("input_triage:max_turns_exceeded:retried@"))).toBe(true);

      // 3. node.list_executions returns one record per attempt, not one per node.
      const executions = await listNodeExecutions({ runId: started.runId, nodeId: "input_triage" }, store, usage);
      expect(executions).toHaveLength(2);
      expect(executions.map((entry) => entry.attempt).sort()).toEqual([1, 2]);
      expect(executions.find((entry) => entry.superseded)).toMatchObject({ status: "failed", attempt: 1 });
      expect(executions.find((entry) => !entry.superseded)).toMatchObject({ status: "completed", attempt: 2 });
    } finally {
      spy.mockRestore();
    }
  });

  it("a node that never ran records no attempt — history counts executions, not button presses", async () => {
    const emptyRun = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async ({ node }: { node: WorkspaceNode }) => ({ ok: true as const, output: mockOutputForNode(node, emptyRun) })
    } as never);
    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-history-2", input: "x" }, store);
      // draft_writer is queued and untouched; retrying it is an operator no-op, not an attempt.
      const retried = (await retryNode(started.runId, "draft_writer", { executionRepository: store }))!;
      expect(retried.nodes.find((state) => state.nodeId === "draft_writer")!.errorHistory).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
