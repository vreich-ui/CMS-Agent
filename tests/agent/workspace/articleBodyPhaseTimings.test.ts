import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// ACCEPTANCE — W0.4 (static-guesses brief, 2026-09-09). THE NODE'S DURATION MUST COVER THE WORK.
//
// `completedAt`/`durationMs` were stamped the instant the model returned — which was the end of the
// node when that line was written, and has not been since the engine-owned validate -> revise ->
// revalidate loop was seamed in after it. Everything the loop does (up to three validator calls plus
// a full second model dispatch, ~345s on article_body's real numbers) was therefore absent from the
// run record and from the timing ledger.
//
// That is not merely a cosmetic undercount. article_body is the node with the longest legitimate tail
// and the node whose claim window the stall incident turned on, and its p95 — the figure a per-node
// stall threshold was going to be derived from — was the one most understated. A threshold computed
// from a duration that stops before the work does would have been "measured" and still wrong.
//
// The phase samples are the same fact at finer grain, and they are DISJOINT by construction: the
// revision dispatches are accumulated separately and subtracted out of the validate segment, so their
// sum is bounded by the node's own duration instead of counting the revisions twice.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MODEL_MS = 25;
const REVISION_MS = 30;
const VALIDATE_BEFORE_MS = 15;
const VALIDATE_AFTER_MS = 15;

let runnerCalls = 0;
vi.mock("../../../src/agent/execution/runnerRegistry.js", () => ({
  getNodeRunner: () => ({
    run: async () => {
      // Both the original dispatch and the revision come through here, and they are given DIFFERENT
      // durations on purpose: the phase samples are only meaningful if each segment can be told apart
      // from the others by its length alone.
      runnerCalls += 1;
      await sleep(runnerCalls === 1 ? MODEL_MS : REVISION_MS);
      return { ok: true, output: { artifact: "client_object.v1", body: { slug: "s", title: "T", nodes: [] } } };
    }
  })
}));

vi.mock("../../../src/agent/workspace/articleBodyValidation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/agent/workspace/articleBodyValidation.js")>();
  return {
    ...actual,
    // Make the run's FIRST node look like the node that owns the loop, so one runNextNode reaches it
    // without driving the whole conductor — the same device articleBodyClaimWindow.test.ts uses.
    ownsValidationLoop: () => true,
    readBodyForValidation: () => ({ slug: "s", title: "T", nodes: [] }),
    runArticleBodyValidationLoop: async (output: Record<string, unknown>, deps: { revise?: (request: unknown) => Promise<unknown> }) => {
      await sleep(VALIDATE_BEFORE_MS);
      await deps.revise?.({ output, body: {}, issues: ["stand-in"], attempt: 1 });
      await sleep(VALIDATE_AFTER_MS);
      return { output, warnings: [], authFailure: undefined };
    }
  };
});

describe("W0.4 — article_body's recorded duration ends where the node ends, not where its model call ends", () => {
  it("re-stamps the duration past the validation loop and records disjoint phase samples", async () => {
    const { startDryRun, runNextNode } = await import("../../../src/agent/workspace/executor.js");
    repositoryManager.getUsageRepository().clear();
    repositoryManager.getNodeTimingRepository().clear();

    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "openai", projectId: "phase-proj", input: "x" }, store);
    const run = await runNextNode(started.runId, { executionRepository: store });

    const nodeId = run.nodes[0]!.nodeId;
    const state = run.nodes.find((node) => node.nodeId === nodeId)!;

    // 1. THE DURATION COVERS THE LOOP. The old stamp would have been the model call alone (~25ms);
    //    the node genuinely occupied the model call plus the revision plus both validate segments.
    //    The bound carries a small tolerance rather than being exact: setTimeout may return a
    //    fraction early and the record's timestamps are millisecond-truncated ISO strings, so four
    //    staged sleeps can land a few ms under their nominal sum. The distance that matters is the
    //    one between this figure and MODEL_MS — asserted below — not the last millisecond.
    const workMs = MODEL_MS + REVISION_MS + VALIDATE_BEFORE_MS + VALIDATE_AFTER_MS;
    expect(state.durationMs).toBeGreaterThanOrEqual(workMs - 10);
    expect(state.durationMs).toBeGreaterThan(MODEL_MS * 2);

    const samples = await repositoryManager.getNodeTimingRepository().list({ runId: started.runId, nodeId });
    const phases = samples.filter((record) => record.phase !== undefined);
    const completions = samples.filter((record) => record.phase === undefined);

    // 2. THREE PHASES, NAMED. This is what a per-phase claim (W1) needs in order to be set from
    //    measurement rather than from ARTICLE_BODY_VALIDATION_PHASE_TIMEOUT_MS's arithmetic.
    expect(phases.map((record) => record.phase).sort()).toEqual(["model", "revision", "validate"]);

    // 3. DISJOINT. The revision is a full second model dispatch that happens INSIDE the loop; if it
    //    were left inside the validate segment as well, the phases would sum past the node's own
    //    duration and the breakdown would be describing more work than happened.
    const phaseTotal = phases.reduce((sum, record) => sum + record.durationMs, 0);
    expect(phaseTotal).toBeLessThanOrEqual(state.durationMs!);
    expect(phases.find((record) => record.phase === "revision")!.durationMs).toBeGreaterThanOrEqual(REVISION_MS - 5);
    expect(phases.find((record) => record.phase === "model")!.durationMs).toBeGreaterThanOrEqual(MODEL_MS - 5);

    // 4. A PHASE IS NOT A COMPLETION. The node ran once; the ledger says so, and the breakdown rides
    //    alongside carrying no cost of its own.
    expect(completions).toHaveLength(1);
    expect(completions[0]!.durationMs).toBe(state.durationMs);
    for (const phase of phases) expect(phase.costUsd).toBe(0);
  });
});
