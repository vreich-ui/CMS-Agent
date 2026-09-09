import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_ROUTE_METADATA_KEYS,
  ROUTE_ERA_METADATA_KEYS,
  ROUTE_MANIFESTS,
  multiPhaseRouteIds,
  phaseTimeoutMsFor,
  resolvePhaseTimeoutMs,
  resolveRouteEra,
  STALL_MARGIN_MS
} from "../../../src/agent/workspace/routeRegistry.js";
import { assessRunStall } from "../../../src/agent/workspace/executor.js";
import { decideRunContinuation } from "../../../src/agent/workspace/runContinuation.js";
import { runCaptureStage } from "../../../src/agent/workspace/captureConductorRoutes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// ACCEPTANCE — W1.1 (static-guesses brief, 2026-09-09). THE INVARIANT:
//
//   at no instant during a route's LEGITIMATE work does assessRunStall report stalledSuspected.
//
// The incident was not a threshold set too low. It was a claim stamped for phase 1 of a multi-phase
// node: article_body claims a model-sized window, then keeps working through validate and revision
// underneath it, so the continuation tick reads a live node as a dead driver and re-dispatches it.
// `reclaimForPhase` fixed exactly one route by hand; every other multi-phase route kept the shape.
//
// This test walks the REGISTRY rather than a hand-kept list, so a route added later without phase
// claims fails here instead of failing in production two weeks after someone forgets.

const NODE: WorkspaceNode = {
  id: "article_body",
  // article_body's real number (nodes.ts): the node most likely to use its whole window.
  modelConfig: { timeout: 300_000 }
} as unknown as WorkspaceNode;

// A run record with one node in flight under a claim — the only shape assessRunStall inspects.
const runInFlight = (dispatchedAtMs: number, timeoutMs: number): WorkflowExecutionRecord => ({
  runId: "run_phase",
  workflowId: "publishing_conductor",
  projectId: "dr-lurie",
  status: "running",
  startedAt: new Date(dispatchedAtMs).toISOString(),
  updatedAt: new Date(dispatchedAtMs).toISOString(),
  nodes: [{
    nodeId: NODE.id,
    status: "running",
    startedAt: new Date(dispatchedAtMs).toISOString(),
    dispatch: { dispatchedAt: new Date(dispatchedAtMs).toISOString(), timeoutMs, driver: "continuation_tick", projectEndpointConfigured: true }
  }],
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true
} as unknown as WorkflowExecutionRecord);

describe("W1.1 — every multi-phase route's claim tracks the phase actually in flight", () => {
  it("the registry declares phases for every route that has more than one wait in a dispatch", () => {
    // The routes the incident class applies to. Named explicitly so removing a route's phases is a
    // visible change to this list rather than a silent loss of coverage.
    expect(multiPhaseRouteIds().sort()).toEqual(["article_body", "artifact_materializer", "release_executor"]);
    for (const manifest of ROUTE_MANIFESTS) {
      expect(manifest.phases.length, `${manifest.id} declares no phases`).toBeGreaterThan(0);
      for (const phase of manifest.phases) {
        expect(resolvePhaseTimeoutMs(phase.timeout, NODE), `${manifest.id}:${phase.id}`).toBeGreaterThan(0);
      }
    }
  });

  // THE INVARIANT ITSELF. Every phase is given its FULL declared window — the worst legitimate case —
  // and the claim is re-stamped at each boundary exactly as claimForPhase does. The run is then
  // sampled at every instant a tick could fire, and must never be called stalled.
  it("walking each route phase-by-phase at full window length is never read as a dead driver", () => {
    for (const routeId of multiPhaseRouteIds()) {
      const manifest = ROUTE_MANIFESTS.find((candidate) => candidate.id === routeId)!;
      let clock = 0;
      let claimedAt = 0;
      let claimTimeoutMs = phaseTimeoutMsFor(routeId, manifest.phases[0].id, NODE)!;

      for (const phase of manifest.phases) {
        // The boundary: the executor re-stamps before the phase starts.
        claimedAt = clock;
        claimTimeoutMs = phaseTimeoutMsFor(routeId, phase.id, NODE)!;

        // Sample every 30s across the phase's full window, plus its final instant. 30s is finer than
        // the deployed 120s tick, so any window a tick could land inside is covered.
        for (let elapsed = 0; elapsed <= claimTimeoutMs; elapsed += 30_000) {
          const at = new Date(clock + elapsed);
          const stall = assessRunStall(runInFlight(claimedAt, claimTimeoutMs), at);
          expect(stall?.stalledSuspected, `${routeId}:${phase.id} read as stalled ${elapsed}ms into a ${claimTimeoutMs}ms phase`).toBe(false);
        }
        clock += claimTimeoutMs;
      }

      // ...and the tick agrees, on the same record, through its own verdict rather than the raw
      // assessor: the last phase, at its last legitimate instant, is "in flight", not "stale".
      const lastInstant = new Date(claimedAt + claimTimeoutMs);
      expect(decideRunContinuation(runInFlight(claimedAt, claimTimeoutMs), lastInstant).code).toBe("skip_dispatch_in_flight");
    }
  });

  // The other half of the bargain, and the reason a single worst-case claim was rejected: a phase that
  // DIES is still reclaimed on its own phase's clock, not on the whole route's worst case.
  it("a phase that dies is reclaimed on that phase's window, not the route's worst case", () => {
    const validateWindow = phaseTimeoutMsFor("article_body", "validate", NODE)!;
    const modelWindow = phaseTimeoutMsFor("article_body", "model", NODE)!;
    expect(validateWindow).toBeLessThan(modelWindow);

    const deadInValidate = runInFlight(0, validateWindow);
    expect(decideRunContinuation(deadInValidate, new Date(validateWindow + STALL_MARGIN_MS + 1_000)).code).toBe("reenter_stale_dispatch");
    // Under one worst-case claim sized for the whole route, the same dead driver would still look
    // alive at that instant — hidden for minutes rather than reclaimed.
    expect(decideRunContinuation(runInFlight(0, modelWindow * 2), new Date(validateWindow + STALL_MARGIN_MS + 1_000)).code).toBe("skip_dispatch_in_flight");
  });

  it("an unknown phase gets the route's widest declared window, never a narrow one", () => {
    // Fail-open: a route that re-stamps for a phase its manifest does not name must not end up with a
    // SHORTER deadline than it would have had, which would reclaim live work.
    expect(phaseTimeoutMsFor("article_body", "not_a_phase", NODE)).toBe(phaseTimeoutMsFor("article_body", "model", NODE));
    // A route the registry does not know at all re-stamps nothing; the caller leaves the claim alone.
    expect(phaseTimeoutMsFor("no_such_route", "stage", NODE)).toBeUndefined();
  });
});

describe("W1.1 — the routes actually call their phase claim", () => {
  it("a capture stage names itself at its boundary", async () => {
    const phases: string[] = [];
    // The run carries no capture facts, so the stage refuses immediately — which is fine: the claim
    // boundary sits BEFORE the tenant call and must be reached whatever the stage then decides.
    await runCaptureStage({
      run: { runId: "r", workflowId: "capture_conductor", projectId: "zilberman", stageOutputs: {}, initialInput: { sourceUrl: "https://example.test", targetProjectId: "zilberman" } } as unknown as WorkflowExecutionRecord,
      node: NODE,
      stage: "map",
      onPhase: async (phase) => { phases.push(phase); }
    }).catch(() => undefined);
    expect(phases).toEqual(["map"]);
  });

  // The materializer's per-slot claims are asserted end-to-end against the real bridge fixture in
  // artifactMaterialization.test.ts ("the materializer re-stamps its dispatch claim per slot"), which
  // is where that module's harness lives.
});

// THE NEGATIVE. An invariant test that cannot fail proves nothing, so this reproduces the defect:
// with ONE claim stamped at the first phase — the pre-W1.1 behaviour — the same walk IS read as a
// dead driver before the route's legitimate work is done.
describe("W1.1 — and the invariant genuinely fails without per-phase claims", () => {
  it("a single claim stamped at phase 1 is read as stalled while later phases are still working", () => {
    const stalledRoutes: string[] = [];
    for (const routeId of multiPhaseRouteIds()) {
      const manifest = ROUTE_MANIFESTS.find((candidate) => candidate.id === routeId)!;
      const firstWindow = phaseTimeoutMsFor(routeId, manifest.phases[0].id, NODE)!;
      // Total legitimate wall-clock for the route: every phase using its full window.
      const total = manifest.phases.reduce((sum, phase) => sum + phaseTimeoutMsFor(routeId, phase.id, NODE)!, 0);
      // One claim, stamped once at t=0, sampled at the route's last legitimate instant.
      const stall = assessRunStall(runInFlight(0, firstWindow), new Date(total));
      if (stall?.stalledSuspected) stalledRoutes.push(routeId);
    }
    // Every multi-phase route is misread under the old single-claim shape — which is why re-stamping
    // is the fix and a bigger threshold is not.
    expect(stalledRoutes.sort()).toEqual(multiPhaseRouteIds().sort());
  });
});

describe("W0.1/W1.1 — route era is resolved from the same registry the phases live in", () => {
  it("names a deterministic stage by key and value, and a model dispatch as the model era", () => {
    expect(resolveRouteEra({ id: "capture_crawl", metadata: { captureStageDeterministic: "crawl" } } as unknown as WorkspaceNode)).toBe("captureStageDeterministic:crawl");
    expect(resolveRouteEra({ id: "publish_executor", metadata: { publishExecutorDeterministic: "execute" } } as unknown as WorkspaceNode)).toBe("publishExecutorDeterministic:execute");
    expect(resolveRouteEra({ id: "artifact_materializer", metadata: { visualStandardMaterializerDeterministic: true } } as unknown as WorkspaceNode)).toBe("visualStandardMaterializerDeterministic");
    expect(resolveRouteEra({ id: "article_body", metadata: {} } as unknown as WorkspaceNode)).toBe("model");
    // ATTRIBUTION IS NOT DISPATCH. artifact_materializer runs a deterministic bridge route and never
    // reaches a model, but it is deliberately absent from DETERMINISTIC_ROUTE_METADATA_KEYS because
    // that list also decides concurrent-batch eligibility. Attribution reads its own list, so the
    // materializer's samples stop being filed under the model era.
    expect(resolveRouteEra({ id: "artifact_materializer", metadata: { artifactMaterializerDeterministic: true } } as unknown as WorkspaceNode)).toBe("artifactMaterializerDeterministic");
    expect(DETERMINISTIC_ROUTE_METADATA_KEYS).not.toContain("artifactMaterializerDeterministic");
    expect(ROUTE_ERA_METADATA_KEYS).toContain("artifactMaterializerDeterministic");
    // A composed workflow's shared tail carries BOTH its own stage key and the inherited DTC key.
    // Declaration order decides, so the same node resolves to the same era on every sample.
    expect(resolveRouteEra({ id: "publish_executor", metadata: { publishExecutorDeterministic: "execute", cloneStageDeterministic: "publish" } } as unknown as WorkspaceNode)).toBe("publishExecutorDeterministic:execute");
  });
});
