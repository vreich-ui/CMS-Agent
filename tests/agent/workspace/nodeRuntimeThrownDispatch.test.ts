import { beforeEach, describe, expect, it, vi } from "vitest";

// P1.1 — a failure that happens AFTER the run record exists must still be addressable.
//
// `executeNode` creates the run and mints the execution id, and only then dispatches. Anything
// thrown after that line — the runner itself, output validation, the stage-output write — used to
// propagate out as a bare Error: the caller got prose with no identifier in it, and the stored run
// stayed at status "running" forever, indistinguishable from one still in flight. These tests use a
// REAL executeNode against a runner that throws (the real runtime failure, not a fabricated error
// object that already carries ids) and assert both halves: the thrown value carries this dispatch's
// own run/execution ids, and the run is persisted as a terminal failure through the normal
// repository path.

const runner = vi.hoisted(() => ({ throws: true as boolean }));

vi.mock("../../../src/agent/execution/runnerRegistry.js", () => ({
  getNodeRunner: () => ({
    run: async () => {
      if (runner.throws) throw new Error("provider socket closed mid-turn");
      return { ok: true, output: { artifact: "probe.v1" } };
    },
    validateConfiguration: () => ({ ok: true }),
    supports: () => true
  }),
  listNodeRunners: () => []
}));

import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const PROBE: WorkspaceNode = {
  id: "probe", name: "Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object", required: ["artifact"], properties: { artifact: { const: "probe.v1" } } },
  modelConfig: {}
};

describe("node.execute — a dispatch that throws still reports its run", () => {
  beforeEach(async () => {
    delete process.env.WORKSPACE_STORE;
    runner.throws = true;
    resetRepositoryManager();
    await repositoryManager.getWorkspaceRepository().createNode(PROBE, { actor: "test" });
  });

  it("carries the real run and execution ids on the thrown value, in the shape a success returns", async () => {
    const thrown = await executeNode({ nodeId: "probe", input: {} }).then(
      () => undefined,
      (error: unknown) => error as { message: string; execution?: { runId?: string; status?: string }; executionId?: string; cause?: unknown }
    );

    expect(thrown).toBeDefined();
    // Real ids, not placeholders: `execution.runId` / `executionId` is exactly what a successful
    // return puts them on, so one reader works on both.
    expect(typeof thrown!.execution?.runId).toBe("string");
    expect(thrown!.execution!.runId!.length).toBeGreaterThan(0);
    expect(typeof thrown!.executionId).toBe("string");
    expect(thrown!.message).toContain(thrown!.execution!.runId!);
    // The original failure is preserved, not replaced by the wrapper.
    expect((thrown!.cause as Error).message).toBe("provider socket closed mid-turn");
  });

  it("persists the run as a terminal failure with a blockage, not a run left 'running'", async () => {
    const thrown = await executeNode({ nodeId: "probe", input: {} }).then(
      () => undefined,
      (error: unknown) => error as { execution?: { runId?: string }; executionId?: string }
    );
    const runId = thrown!.execution!.runId!;

    // Read back through the normal repository path — what an operator's workflow.get_run would see.
    const stored = await repositoryManager.getExecutionRepository().getRun(runId);
    expect(stored?.status).toBe("failed");
    expect(stored?.errors?.[0]).toBe("node_execution_threw");
    const state = stored!.nodes[0] as { status: string; blockage?: { scope: { run_id?: string; execution_id?: string } } };
    expect(state.status).toBe("failed");
    expect(state.blockage?.scope.run_id).toBe(runId);
    // The blockage is addressed to the SAME execution the throw reported, so a card built from the
    // stored run and a caller holding the thrown value are talking about one dispatch.
    expect(state.blockage?.scope.execution_id).toBe(thrown!.executionId);
  });

  it("leaves a guard failure BEFORE the run exists with no ids — nothing ran, so nothing is invented", async () => {
    const thrown = await executeNode({ nodeId: "no_such_node", input: {} }).then(
      () => undefined,
      (error: unknown) => error as { execution?: unknown; executionId?: unknown }
    );
    expect(thrown).toBeDefined();
    expect(thrown!.execution).toBeUndefined();
    expect(thrown!.executionId).toBeUndefined();
  });

  it("still returns normally when the dispatch does not throw", async () => {
    runner.throws = false;
    const result = await executeNode({ nodeId: "probe", input: {} }) as { execution: { status: string }; executionId: string };
    expect(result.execution.status).toBe("completed");
    expect(typeof result.executionId).toBe("string");
  });
});
