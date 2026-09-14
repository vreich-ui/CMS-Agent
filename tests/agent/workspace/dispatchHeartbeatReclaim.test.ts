import { afterEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { DriverHealthRepository } from "../../../src/agent/repository/interfaces/DriverHealthRepository.js";
import {
  DISPATCH_HEARTBEAT_GRACE_MS,
  DISPATCH_HEARTBEAT_INTERVAL_MS,
  isDispatchHeartbeatSilent,
  resetDispatchHeartbeats,
  setDispatchHeartbeatRepository,
  type DispatchHeartbeat
} from "../../../src/agent/workspace/dispatchHeartbeat.js";
import { assessRunStall, getRun, runNextNode, startDryRun, STALL_MARGIN_MS } from "../../../src/agent/workspace/executor.js";

// D3 — a claim's own window is a bound on the NODE. The heartbeat is a signal about the DRIVER, and
// it is the only one with a sense of scale: a driver that stopped one second after dispatching used
// to hold a node for its whole window plus 90s (180s for a model node, 390s for a capture stage).
const beat = (overrides: Partial<DispatchHeartbeat> = {}): DispatchHeartbeat => ({
  runId: "r", nodeIds: ["n1"], dispatchedAt: "2026-09-14T10:00:00.000Z", driver: "continuation_tick",
  heartbeatAt: "2026-09-14T10:00:00.000Z", ...overrides
});

afterEach(() => { setDispatchHeartbeatRepository(undefined); resetDispatchHeartbeats(); });

describe("D3 — heartbeat-based reclaim", () => {
  it("calls a dispatch silent only after two missed beats, and only about its own dispatch", () => {
    const dispatchedAt = "2026-09-14T10:00:00.000Z";
    const oneBeatLate = new Date(Date.parse(dispatchedAt) + DISPATCH_HEARTBEAT_INTERVAL_MS + 1_000);
    const twoBeatsLate = new Date(Date.parse(dispatchedAt) + DISPATCH_HEARTBEAT_GRACE_MS + 1_000);
    expect(isDispatchHeartbeatSilent(beat(), dispatchedAt, oneBeatLate)).toBe(false);
    expect(isDispatchHeartbeatSilent(beat(), dispatchedAt, twoBeatsLate)).toBe(true);
    // A heartbeat left behind by an EARLIER dispatch is not evidence about this one.
    expect(isDispatchHeartbeatSilent(beat({ dispatchedAt: "2026-09-14T09:00:00.000Z" }), dispatchedAt, twoBeatsLate)).toBe(false);
    // No heartbeat at all (a driver that does not beat, a store this process cannot reach) decides nothing.
    expect(isDispatchHeartbeatSilent(undefined, dispatchedAt, twoBeatsLate)).toBe(false);
  });

  it("reports a silent dispatch as stalled long before its claim window expires, and says a claim is still stamped", () => {
    const dispatchedAt = new Date(Date.now() - 45_000).toISOString();
    const record = {
      runId: "run-hb", workflowId: "w", projectId: "p", status: "running", startedAt: dispatchedAt, updatedAt: dispatchedAt,
      nodes: [{ nodeId: "n1", status: "running", dispatch: { dispatchedAt, timeoutMs: 300_000, driver: "continuation_tick" } }],
      artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
    } as any;
    // The claim window (300s + 90s) has not remotely expired.
    expect(assessRunStall(record)).toMatchObject({ stalledSuspected: false });
    const silent = assessRunStall(record, new Date(), { dispatchHeartbeat: beat({ runId: "run-hb", dispatchedAt, heartbeatAt: new Date(Date.now() - 40_000).toISOString() }) });
    expect(silent).toMatchObject({ inFlightNodeId: "n1", stalledSuspected: true, heartbeatSilent: true });
    // D2 — the note may never claim nothing is in flight while a claim is stamped.
    expect(silent!.advice).not.toMatch(/nothing is in flight/i);
    expect(silent!.advice).toMatch(/STILL STAMPED/);
  });

  it("reclaims a silent dispatch in well under 60s of wall clock, and leaves a live one untouched", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const health: DriverHealthRepository = new RepositoryManager().getDriverHealthRepository();
    setDispatchHeartbeatRepository(() => health);

    const stampClaim = async (projectId: string, dispatchedAt: string) => {
      const started = await startDryRun({ executionMode: "mock", projectId, input: "x" }, store);
      const run = (await getRun(started.runId, store))!;
      const first = run.nodes[0];
      first.status = "running";
      first.startedAt = dispatchedAt;
      // A 300s window: under the pre-D3 rule this node is unreclaimable for 390s.
      first.dispatch = { dispatchedAt, timeoutMs: 300_000, driver: "continuation_tick" };
      run.status = "running";
      await store.saveRun(run);
      return { runId: started.runId, nodeId: first.nodeId, dispatchedAt };
    };

    // SILENT: dispatched 45s ago, last heartbeat 40s ago — two missed beats.
    const dead = await stampClaim("hb-dead", new Date(Date.now() - 45_000).toISOString());
    await health.recordDispatchHeartbeat(beat({ runId: dead.runId, nodeIds: [dead.nodeId], dispatchedAt: dead.dispatchedAt, heartbeatAt: new Date(Date.now() - 40_000).toISOString() }));
    const reclaimed = await runNextNode(dead.runId, { executionRepository: store });
    const reclaimedState = reclaimed.nodes.find((node) => node.nodeId === dead.nodeId)!;
    expect(reclaimedState.status).toBe("completed");
    expect(reclaimedState.warnings).toContain("stale_dispatch_reclaimed");
    expect(reclaimedState.warnings).toContain("dispatch_heartbeat_silent");
    // 45s after dispatch — far inside the 390s the claim window alone would have demanded.
    expect(45_000).toBeLessThan(300_000 + STALL_MARGIN_MS);

    // LIVE: same age, but the driver beat 3 seconds ago. The double-dispatch guard still holds.
    const alive = await stampClaim("hb-alive", new Date(Date.now() - 45_000).toISOString());
    await health.recordDispatchHeartbeat(beat({ runId: alive.runId, nodeIds: [alive.nodeId], dispatchedAt: alive.dispatchedAt, heartbeatAt: new Date(Date.now() - 3_000).toISOString() }));
    const untouched = await runNextNode(alive.runId, { executionRepository: store });
    const untouchedState = untouched.nodes.find((node) => node.nodeId === alive.nodeId)!;
    expect(untouchedState.status).toBe("running");
    expect(untouchedState.dispatch).toBeDefined();
    expect(untouchedState.warnings ?? []).not.toContain("stale_dispatch_reclaimed");
  });

  it("a real dispatch writes a heartbeat while it runs and clears it when it ends", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const health: DriverHealthRepository = new RepositoryManager().getDriverHealthRepository();
    const written: DispatchHeartbeat[] = [];
    const recording: DriverHealthRepository = Object.create(health) as DriverHealthRepository;
    recording.recordDispatchHeartbeat = async (entry) => { written.push(entry); return health.recordDispatchHeartbeat(entry); };
    setDispatchHeartbeatRepository(() => recording);

    const started = await startDryRun({ executionMode: "mock", projectId: "hb-live", input: "x" }, store);
    await runNextNode(started.runId, { executionRepository: store });
    // Writes are fire-and-forget; let the microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written.length).toBeGreaterThan(0);
    expect(written[0]!.runId).toBe(started.runId);
    expect(await health.getDispatchHeartbeat(started.runId)).toBeUndefined();
  });
});
