import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { retryNode, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// R2 Piece 1 acceptance — the no-progress gate. A node that fails with a NON-retryable code (so it
// goes terminal on its first attempt, before nodeRetryPolicy's own classified backoff would ever
// enter the picture) must refuse a manual workflow.retry_node call that changes nothing, and must
// allow one that supplies either a real state revision or an explicit justification.
//
// Uses the GLOBAL repositoryManager singleton throughout (never `new RepositoryManager()`): the
// executor's own default (executor.ts's resolveConductorNodes: `workspaceRepository ??
// repositoryManager.getWorkspaceRepository()`) reads node DEFINITIONS from that singleton whenever a
// caller does not thread its own workspaceRepository through RunAdvanceOptions — which this suite
// deliberately does not, so the "operator revises the node" case below reaches the exact same
// repository resolveConductorNodes will read from. resetRepositoryManager() between tests keeps each
// one's node/run state isolated.

const alwaysFails = (code = "max_turns_exceeded") => {
  let calls = 0;
  return {
    calls: () => calls,
    spy: vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async () => {
        calls += 1;
        return { ok: false as const, code, message: `Injected ${code} #${calls}.` };
      }
    } as never)
  };
};

describe("R2 — no-progress gate (retryNode)", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("refuses a retry that changes nothing: no re-dispatch happens, and the node reports a structured no_progress stop", async () => {
    const runner = alwaysFails();
    try {
      const store: ExecutionRepository = repositoryManager.getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "np-project-1", input: "x" }, store);

      const failed = await runNextNode(started.runId, { executionRepository: store });
      expect(failed.status).toBe("failed");
      const firstAttempt = failed.nodes.find((n) => n.nodeId === "input_triage")!;
      expect(firstAttempt.noProgress).toBeDefined();
      expect(firstAttempt.noProgress!.occurrences).toBe(1);
      expect(runner.calls()).toBe(1);

      // Manual retry with NOTHING changed: same input, same node definition, same (absent) capability
      // facts. Must be refused BEFORE the runner is ever called again — a $0 refusal, exactly like
      // preflightDriverAuth's own convention.
      const refused = (await retryNode(started.runId, "input_triage", { executionRepository: store }))!;
      expect(runner.calls()).toBe(1); // no second dispatch happened
      expect(refused.status).toBe("failed");
      const node = refused.nodes.find((n) => n.nodeId === "input_triage")!;
      expect(node.status).toBe("failed");
      expect(node.errors?.[0]).toBe("no_progress");
      expect(node.blockage?.code).toBe("no_progress");
      expect(node.blockage?.contract).toBe("blockage.v1");
      // Offers no bare "retry" remedy — that is exactly what would reproduce the same wall.
      expect(node.blockage?.remedies.some((r) => r.type === "retry")).toBe(false);
      // The ledger itself is untouched by a REFUSED attempt (no execution happened, so nothing new to
      // record) — still describing the one real terminal failure.
      expect(node.noProgress!.occurrences).toBe(1);
      expect(refused.errors.some((entry) => entry === "input_triage:no_progress")).toBe(true);
    } finally {
      runner.spy.mockRestore();
    }
  });

  it("allows the retry once an operator revises the node's own definition (a relevant state revision), no justification needed", async () => {
    const runner = alwaysFails();
    try {
      const store: ExecutionRepository = repositoryManager.getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "np-project-2", input: "x" }, store);
      await runNextNode(started.runId, { executionRepository: store });
      expect(runner.calls()).toBe(1);

      // A real state revision: an operator edits the node's own definition (bumps updatedAt).
      await repositoryManager.getWorkspaceRepository().updateNode("input_triage", { description: "revised by operator" }, {});

      const retried = (await retryNode(started.runId, "input_triage", { executionRepository: store }))!;
      expect(runner.calls()).toBe(2); // the retry actually dispatched this time
      const node = retried.nodes.find((n) => n.nodeId === "input_triage")!;
      // Runner still fails (alwaysFails), but this is now attempt 2 under DIFFERENT conditions — a
      // fresh ledger entry, not a blocked repeat.
      expect(node.errors?.[0]).not.toBe("no_progress");
      expect(node.noProgress!.occurrences).toBe(1);
    } finally {
      runner.spy.mockRestore();
    }
  });

  it("allows the retry when an explicit retryJustification is supplied, and records it on the ledger for audit", async () => {
    const runner = alwaysFails();
    try {
      const store: ExecutionRepository = repositoryManager.getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "np-project-3", input: "x" }, store);
      await runNextNode(started.runId, { executionRepository: store });
      expect(runner.calls()).toBe(1);

      const retried = (await retryNode(started.runId, "input_triage", {
        executionRepository: store,
        retryJustification: "operator rotated the client's API credential outside this engine"
      }))!;
      expect(runner.calls()).toBe(2);
      const node = retried.nodes.find((n) => n.nodeId === "input_triage")!;
      expect(node.errors?.[0]).not.toBe("no_progress");
      // Same conditions as before (nothing this engine can see changed) -> occurrences climbs, and the
      // justification that authorized it rides along on the ledger entry for a later reader.
      expect(node.noProgress!.occurrences).toBe(2);
      expect(node.noProgress!.lastOverrideJustification).toBe("operator rotated the client's API credential outside this engine");
    } finally {
      runner.spy.mockRestore();
    }
  });

  it("clears the ledger once the node genuinely succeeds", async () => {
    let calls = 0;
    const emptyRun = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async ({ node }: { node: WorkspaceNode }) => {
        calls += 1;
        if (calls === 1) return { ok: false as const, code: "max_turns_exceeded", message: "Injected failure." };
        return { ok: true as const, output: mockOutputForNode(node, emptyRun) };
      }
    } as never);
    try {
      const store: ExecutionRepository = repositoryManager.getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "np-project-4", input: "x" }, store);
      await runNextNode(started.runId, { executionRepository: store });

      const retried = (await retryNode(started.runId, "input_triage", { executionRepository: store, retryJustification: "test" }))!;
      const node = retried.nodes.find((n) => n.nodeId === "input_triage")!;
      expect(node.status).toBe("completed");
      expect(node.noProgress).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("survives a fresh read of the run record (pause/resume, driver restart): the ledger is written by the same CAS saveRun as every other field, not held in process memory", async () => {
    const runner = alwaysFails();
    try {
      const store: ExecutionRepository = repositoryManager.getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "np-project-5", input: "x" }, store);
      await runNextNode(started.runId, { executionRepository: store });

      // A plain getRun (exactly what a resumed driver, or a continuation-tick process that never held
      // any in-memory state for this run, would do) sees the ledger — it was persisted on the record
      // itself, not kept in a closure this test's own call stack happens to still hold.
      const reread = await store.getRun(started.runId);
      const node = reread!.nodes.find((n) => n.nodeId === "input_triage")!;
      expect(node.noProgress).toBeDefined();
      expect(node.noProgress!.occurrences).toBe(1);
      expect(node.noProgress!.code).toBe("max_turns_exceeded");

      // And the gate still refuses an unchanged retry driven off that freshly-read record.
      const refused = (await retryNode(started.runId, "input_triage", { executionRepository: store }))!;
      expect(refused.nodes.find((n) => n.nodeId === "input_triage")!.errors?.[0]).toBe("no_progress");
      expect(runner.calls()).toBe(1);
    } finally {
      runner.spy.mockRestore();
    }
  });
});
