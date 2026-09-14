import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";

// D1 REPRODUCTION — "the driver process died mid-node" was the wrong diagnosis.
//
// A driver stamps a dispatch claim, saves it, runs the node, and saves the result. If ANY other
// writer touched the run record in between (the continuation tick's driverHealth stamp does exactly
// this, on every continuable run, every two minutes), the completion save loses the compare-and-swap.
// advanceRun's conflict handler then re-reads the run, finds the driver's OWN still-live claim, and
// returns the run untouched — the finished node's output is thrown away and the claim is left with
// nobody behind it until it ages out (timeoutMs + STALL_MARGIN_MS).
//
// This test drives the real executor against the real in-memory CAS store and interposes exactly one
// foreign write while the node is in flight.
const interposeOneWriteWhileInFlight = (store: ExecutionRepository): { store: ExecutionRepository; interposed: () => number } => {
  let interposedCount = 0;
  const proxy: ExecutionRepository = Object.create(store) as ExecutionRepository;
  proxy.saveRun = async (run: WorkflowExecutionRecord) => {
    const inFlight = run.nodes.some((node) => node.status === "running" && node.dispatch);
    // Only once, and only on the COMPLETION save (the record being written no longer holds the claim
    // it was dispatched under) — i.e. exactly the window the tick's health stamp lands in.
    if (!inFlight && interposedCount === 0) {
      const stored = await store.getRun(run.runId);
      if (stored && stored.nodes.some((node) => node.status === "running" && node.dispatch)) {
        interposedCount += 1;
        // The tick's stamp: a field nobody else reads, on a record somebody else is mid-node on.
        await store.saveRun({ ...stored, driverHealth: { ...(stored.driverHealth ?? {}), lastSeenByTickAt: new Date().toISOString() } });
      }
    }
    return store.saveRun(run);
  };
  return { store: proxy, interposed: () => interposedCount };
};

describe("D1 — a foreign write during a dispatch abandons the claim", () => {
  it("discards the completed node and leaves its claim with no driver behind it", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const { store: racing, interposed } = interposeOneWriteWhileInFlight(store);
    const started = await startDryRun({ executionMode: "mock", projectId: "cas-abandon", input: "x" }, store);

    const advanced = await runNextNode(started.runId, { executionRepository: racing });
    expect(interposed()).toBe(1);

    const after = (await getRun(started.runId, store))!;
    const stuck = after.nodes.find((node) => node.status === "running" && node.dispatch);
    // THE DEFECT: a node left "running", holding a claim, with the driver already returned.
    expect(stuck).toBeUndefined();
    expect(advanced.nodes.some((node) => node.status === "completed")).toBe(true);
  });

  it("still discards when another driver has taken the claim (the one case the old behaviour was right)", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "cas-stolen", input: "x" }, store);
    let stolen = false;
    const proxy: ExecutionRepository = Object.create(store) as ExecutionRepository;
    proxy.saveRun = async (run: WorkflowExecutionRecord) => {
      const completing = !run.nodes.some((node) => node.status === "running" && node.dispatch);
      if (completing && !stolen) {
        const stored = await store.getRun(run.runId);
        const claimed = stored?.nodes.find((node) => node.status === "running" && node.dispatch);
        if (stored && claimed) {
          stolen = true;
          // Another driver reclaimed the stale claim and re-dispatched the node under a NEW claim.
          claimed.dispatch = { ...claimed.dispatch!, dispatchedAt: new Date(Date.now() + 1_000).toISOString() };
          await store.saveRun(stored);
        }
      }
      return store.saveRun(run);
    };

    await runNextNode(started.runId, { executionRepository: proxy });
    expect(stolen).toBe(true);
    const after = (await getRun(started.runId, store))!;
    // The other driver's claim is intact and untouched — we did not write our result over it.
    const contested = after.nodes.find((node) => node.status === "running" && node.dispatch);
    expect(contested).toBeDefined();
    expect(contested!.status).toBe("running");
  });
});
