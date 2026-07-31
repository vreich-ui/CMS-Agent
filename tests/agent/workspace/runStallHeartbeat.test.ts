import { beforeEach, describe, expect, it } from "vitest";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { assessRunStall, runNextNode, startDryRun, getRun, STALL_MARGIN_MS } from "../../../src/agent/workspace/executor.js";

// The ~300s silent death: the serverless driver process is killed mid-run with no goodbye, leaving
// the record at status "running" with nothing in flight — indistinguishable from a run still
// working. The dispatch claim (persisted BEFORE a node is handed to a runner) plus assessRunStall
// is what makes the two states tell apart, and the stale-dispatch reclaim is what makes the run
// resumable instead of stuck.
describe("run stall heartbeat and stale-dispatch reclaim", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("reports a live in-flight dispatch as not stalled, and a dead one as stalled", () => {
    const base = {
      runId: "run-stall", workflowId: "publishing_conductor", projectId: "p", startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true as const
    };
    const dispatchedAt = new Date(Date.now() - 30_000).toISOString();
    const live = assessRunStall({ ...base, status: "running", nodes: [{ nodeId: "n1", status: "running", dispatch: { dispatchedAt, timeoutMs: 120_000 } }] } as any);
    expect(live).toMatchObject({ inFlightNodeId: "n1", stalledSuspected: false });

    const deadDispatchedAt = new Date(Date.now() - 120_000 - STALL_MARGIN_MS - 5_000).toISOString();
    const dead = assessRunStall({ ...base, status: "running", nodes: [{ nodeId: "n1", status: "running", dispatch: { dispatchedAt: deadDispatchedAt, timeoutMs: 120_000 } }] } as any);
    expect(dead).toMatchObject({ inFlightNodeId: "n1", stalledSuspected: true });
    expect(dead!.advice).toMatch(/died mid-node|reclaim/i);
  });

  it("reports a between-node death (status running, nothing in flight, record untouched)", () => {
    const old = new Date(Date.now() - STALL_MARGIN_MS - 10_000).toISOString();
    const stalled = assessRunStall({
      runId: "run-idle", workflowId: "w", projectId: "p", status: "running", startedAt: old, updatedAt: old,
      nodes: [{ nodeId: "n1", status: "completed" }, { nodeId: "n2", status: "queued" }],
      artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
    } as any);
    expect(stalled).toMatchObject({ stalledSuspected: true });
    expect(stalled!.advice).toMatch(/died between nodes|resumable/i);
  });

  it("is absent entirely for non-running runs", () => {
    const record = {
      runId: "run-done", workflowId: "w", projectId: "p", status: "completed", startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
    };
    expect(assessRunStall(record as any)).toBeUndefined();
  });

  it("reclaims a stale dispatch to queued on the next advance, so the run resumes instead of sticking", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "stall-proj", input: "x" }, store);
    // Simulate a driver killed mid-node: first node persisted as running with an expired claim.
    const run = (await getRun(started.runId, store))!;
    const first = run.nodes[0];
    first.status = "running";
    first.startedAt = new Date(Date.now() - 400_000).toISOString();
    first.dispatch = { dispatchedAt: new Date(Date.now() - 400_000).toISOString(), timeoutMs: 90_000 };
    run.status = "running";
    await store.saveRun(run);

    const advanced = await runNextNode(started.runId, { executionRepository: store });
    // The stale claim was reclaimed and the node actually ran this time.
    const state = advanced.nodes.find((node) => node.nodeId === first.nodeId)!;
    expect(state.status).toBe("completed");
    expect(state.warnings).toContain("stale_dispatch_reclaimed");
    expect(state.dispatch).toBeUndefined();
  });

  it("does NOT double-dispatch while a claim is still within its window", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "stall-proj-2", input: "x" }, store);
    const run = (await getRun(started.runId, store))!;
    const first = run.nodes[0];
    first.status = "running";
    first.startedAt = new Date().toISOString();
    first.dispatch = { dispatchedAt: new Date().toISOString(), timeoutMs: 120_000 };
    run.status = "running";
    await store.saveRun(run);

    const advanced = await runNextNode(started.runId, { executionRepository: store });
    // Nothing changed: the node is (as far as this process can tell) genuinely in flight elsewhere.
    expect(advanced.nodes.find((node) => node.nodeId === first.nodeId)!.status).toBe("running");
    expect(advanced.nodes.filter((node) => node.status === "completed")).toHaveLength(0);
  });
});
