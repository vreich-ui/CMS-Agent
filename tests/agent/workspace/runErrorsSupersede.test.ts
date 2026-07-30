import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { retryNode, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// Defect (T-2, run_1785352838155_l544ye): the run reached publication_controller cleanly, then
// terminated with errors ["draft_writer:model_timeout", "learning_recorder:model_timeout"] even
// though draft_writer had, in between, been retried and completed successfully. retryNode resets the
// NODE's own status/output/errors but never touched the run-level `errors` array those failures were
// appended to, so a resolved failure stayed in the array forever, making triage misleading — an
// operator reading `run.errors` could not tell a currently-broken node from one that already recovered.

describe("run-level errors array (T-2 defect: stale entries after a successful retry)", () => {
  it("drops a node's stale error entry once a retry completes it successfully", async () => {
    let calls = 0;
    const emptyRun = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async ({ node }: { node: WorkspaceNode }) => {
        calls += 1;
        if (calls === 1) return { ok: false as const, code: "model_timeout", message: "OpenAI node execution timed out." };
        return { ok: true as const, output: mockOutputForNode(node, emptyRun) };
      }
    } as never);

    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-errs", input: "x" }, store);

      const failed = await runNextNode(started.runId, { executionRepository: store });
      expect(failed.status).toBe("failed");
      expect(failed.nodes.find((n) => n.nodeId === "input_triage")!.status).toBe("failed");
      expect(failed.errors).toEqual(["input_triage:model_timeout"]);

      const retried = (await retryNode(started.runId, "input_triage", { executionRepository: store }))!;
      expect(retried.nodes.find((n) => n.nodeId === "input_triage")!.status).toBe("completed");
      // The node itself no longer carries the resolved failure...
      expect(retried.nodes.find((n) => n.nodeId === "input_triage")!.errors).toBeUndefined();
      // ...and neither should the run-level ledger the operator actually reads for triage.
      expect(retried.errors).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("supersedes only the retried node's entries, leaving other nodes' failures intact", async () => {
    // input_triage fails once then is retried to success; topic_opportunity fails and is left alone.
    let triageCalls = 0;
    const emptyRun = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async ({ node }: { node: WorkspaceNode }) => {
        if (node.id === "input_triage") {
          triageCalls += 1;
          if (triageCalls === 1) return { ok: false as const, code: "model_timeout", message: "timed out" };
          return { ok: true as const, output: mockOutputForNode(node, emptyRun) };
        }
        if (node.id === "topic_opportunity") return { ok: false as const, code: "model_timeout", message: "timed out" };
        return { ok: true as const, output: mockOutputForNode(node, emptyRun) };
      }
    } as never);

    try {
      const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-errs-2", input: "x" }, store);

      await runNextNode(started.runId, { executionRepository: store }); // input_triage fails
      const retried = (await retryNode(started.runId, "input_triage", { executionRepository: store }))!; // input_triage succeeds
      const afterSecondNode = await runNextNode(retried.runId, { executionRepository: store }); // topic_opportunity fails

      expect(afterSecondNode.errors).toEqual(["topic_opportunity:model_timeout"]);
    } finally {
      spy.mockRestore();
    }
  });
});
