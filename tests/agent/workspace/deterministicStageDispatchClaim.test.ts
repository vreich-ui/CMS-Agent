import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";

// T14.4 — THE LONG DETERMINISTIC STAGE MUST PUBLISH A DISPATCH CLAIM.
//
// capture_emit_live is deterministic but not quick: it probes and ingests every asset on the target
// site, then walks creates/reuses over the project MCP. On zilberman that is 100-200s of real
// network work. Before this fix the claim was stamped AFTER the capture/clone branches — and the
// PERSISTED record was worse than unclaimed: with the negative test applied it reads status
// "queued", because the in-memory "running" transition is never saved before the stage begins. So
// for the whole of that window nothing on disk said the node was in flight; assessRunStall saw an
// idle driver and runContinuation re-entered the SAME node while pass A was still working. The two passes then collided on the TARGET's own locks: pass A held an object_checkout
// lease, pass B asked for the same object and got HTTP 423, which surfaced as
// capture_emission_refused while pass A quietly finished its writes.
//
// run_1787655233171_y4w8z5 is the evidence: capture_emit_live recorded
//   "capture_emission_refused: ... object_checkout on zilberman returned an MCP error result: status 423"
// at 10:57:27, and zilberman's four pages carry updated_at 10:58:18-10:58:46 — written by the pass
// that was still running 79 seconds after the run had been declared blocked.
//
// The observation below is taken from INSIDE the stage, which is the only place the bug was visible:
// both the before and after records look identical once the node is terminal.

const observed: { fromInsideTheStage?: unknown } = {};
let storeRef: { getRun: (id: string) => Promise<unknown> } | undefined;
let runIdRef = "";

vi.mock("../../../src/agent/workspace/captureConductorRoutes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/agent/workspace/captureConductorRoutes.js")>();
  return {
    ...actual,
    // Make the run's FIRST node look like a deterministic capture stage.
    readCaptureStage: (node: { id?: string }) => (node.id === "input_triage" ? ("emit" as never) : undefined),
    // Stand in for the 100s of network work, and read the PERSISTED record while "in flight".
    runCaptureStage: async () => {
      const record = (await storeRef!.getRun(runIdRef)) as { nodes: Array<{ nodeId: string; status: string; dispatch?: unknown }> };
      observed.fromInsideTheStage = record.nodes.find((node) => node.nodeId === "input_triage");
      return { kind: "refused" as const, code: "capture_emission_refused", message: "stand-in for the long stage" };
    }
  };
});

describe("deterministic capture/clone stages publish a dispatch claim while they run", () => {
  it("persists status=running WITH a dispatch stamp before the stage starts, so a tick cannot re-enter it", async () => {
    const { startDryRun, runNextNode, assessRunStall } = await import("../../../src/agent/workspace/executor.js");
    const store = new RepositoryManager().getExecutionRepository();
    storeRef = store as never;
    const started = await startDryRun({ executionMode: "mock", projectId: "claim-proj", input: "x" }, store);
    runIdRef = started.runId;

    await runNextNode(started.runId, { executionRepository: store });

    const inFlight = observed.fromInsideTheStage as { status: string; dispatch?: { dispatchedAt: string; timeoutMs: number } };
    expect(inFlight, "the stage must be able to see its own persisted claim").toBeDefined();
    expect(inFlight.status).toBe("running");
    expect(inFlight.dispatch, "no dispatch stamp = assessRunStall sees an idle driver = double-dispatch").toBeDefined();

    // The claim's window has to outlast the work. 120_000 (the model default) would call a live
    // emission dead while it was still ingesting assets.
    expect(inFlight.dispatch!.timeoutMs).toBeGreaterThanOrEqual(300_000);

    // And the claim is what a concurrent tick reads: mid-stage, the run is unambiguously in flight.
    const midStage = assessRunStall({ ...(await store.getRun(started.runId))!, status: "running", nodes: [inFlight as never] } as never);
    expect(midStage).toMatchObject({ inFlightNodeId: "input_triage", stalledSuspected: false });
  });

  it("releases the claim on the terminal transition, so a blocked node never looks in flight forever", async () => {
    const { startDryRun, runNextNode, getRun } = await import("../../../src/agent/workspace/executor.js");
    const store = new RepositoryManager().getExecutionRepository();
    storeRef = store as never;
    const started = await startDryRun({ executionMode: "openai", projectId: "claim-proj-2", input: "x" }, store);
    runIdRef = started.runId;

    await runNextNode(started.runId, { executionRepository: store });

    const record = (await getRun(started.runId, store))!;
    const settled = record.nodes.find((node) => node.nodeId === "input_triage")!;
    expect(settled.status).toBe("blocked");
    expect(settled.warnings).toContain("capture_stage_deterministic_unavailable:capture_emission_refused");
    expect(settled.dispatch, "a terminal node holding a claim reads as in flight forever").toBeUndefined();
  });
});
