import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";

// T3 — THE ARTICLE_BODY CLAIM WINDOW MUST COVER THE ENGINE-OWNED VALIDATION LOOP.
//
// The dispatch claim is stamped ONCE, with nodeTimeoutMs, before the model loop starts. But the
// engine-owned validate -> revise -> revalidate loop runs AFTER the model returns, inside that same
// claim: up to three validator calls at 15s each plus one full second model dispatch of up to
// nodeTimeoutMs again. On article_body (six dependencies in one ~48k-char payload, the node most
// likely to use its whole 300s) that is ~645s of legitimate work under a claim that goes stale at
// nodeTimeoutMs + STALL_MARGIN_MS = 390s.
//
// So the 60s continuation tick read a node that was still working as a dead driver and RE-DISPATCHED
// it — the same double-dispatch loop already documented for gap_adjudicator (~248 re-dispatches in
// 24h). Nothing covered this: every existing claim test asserts the claim EXISTS, none compares its
// window against the wall-clock of the work that runs under it.
//
// The fix re-stamps per phase rather than widening the initial claim, because a single claim sized
// for the worst case would hide a genuinely dead driver for eleven minutes. This test therefore
// asserts the two things that distinguish those options: the clock RESTARTS at the loop boundary,
// and the revision phase (a full model dispatch) claims a model-sized window rather than a
// validator-sized one.

type RunRecord = { status: string; nodes: Array<{ nodeId: string; status: string; dispatch?: { dispatchedAt: string; timeoutMs: number } }> };
const observed: { atModelDispatch?: RunRecord; atLoopEntry?: RunRecord; atRevision?: RunRecord } = {};
let storeRef: { getRun: (id: string) => Promise<unknown> } | undefined;
let runIdRef = "";

// The PERSISTED record, read from inside the work — the only vantage point the defect was visible
// from, since both the before and after records look identical once the node is terminal.
const recordNow = async (): Promise<RunRecord> => (await storeRef!.getRun(runIdRef)) as RunRecord;
const claimOf = (record: RunRecord) => record.nodes[0]!.dispatch!;

// A stand-in model dispatch. Real runners are not wanted here: the subject is the claim written
// around the loop, not what any model says.
vi.mock("../../../src/agent/execution/runnerRegistry.js", () => ({
  getNodeRunner: () => ({
    run: async () => {
      // The revision phase dispatches through this same runner, so only the FIRST call is the
      // original model dispatch whose claim the loop has to outlive.
      observed.atModelDispatch ??= await recordNow();
      return { ok: true, output: { artifact: "client_object.v1", body: { slug: "s", title: "T", nodes: [] } } };
    }
  })
}));

vi.mock("../../../src/agent/workspace/articleBodyValidation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/agent/workspace/articleBodyValidation.js")>();
  return {
    ...actual,
    // Make the run's FIRST node look like the node that owns the validation loop, so one
    // runNextNode reaches the loop without driving the whole conductor.
    ownsValidationLoop: () => true,
    readBodyForValidation: () => ({ slug: "s", title: "T", nodes: [] }),
    // Stand in for the loop's real wall-clock (up to 3x15s of validator calls plus a revision
    // dispatch), and read the PERSISTED claim from inside it — the only place the defect was visible.
    runArticleBodyValidationLoop: async (output: Record<string, unknown>, deps: { revise?: (request: unknown) => Promise<unknown> }) => {
      observed.atLoopEntry = await recordNow();
      await deps.revise?.({ output, body: {}, issues: ["stand-in"], attempt: 1 });
      observed.atRevision = await recordNow();
      return { output, warnings: [], authFailure: undefined };
    }
  };
});

describe("T3 — the article_body dispatch claim covers the engine-owned validation loop", () => {
  it("re-stamps the claim at the loop boundary, so a tick cannot reclaim a node that is still working", async () => {
    const { startDryRun, runNextNode, STALL_MARGIN_MS, ARTICLE_BODY_VALIDATION_PHASE_TIMEOUT_MS } = await import("../../../src/agent/workspace/executor.js");
    const { decideRunContinuation } = await import("../../../src/agent/workspace/runContinuation.js");
    const store = new RepositoryManager().getExecutionRepository();
    storeRef = store as never;
    const started = await startDryRun({ executionMode: "openai", projectId: "claim-proj", input: "x" }, store);
    runIdRef = started.runId;

    await runNextNode(started.runId, { executionRepository: store });

    expect(observed.atModelDispatch?.nodes[0]?.dispatch, "the model dispatch must publish a claim").toBeDefined();
    expect(observed.atLoopEntry?.nodes[0]?.dispatch, "the validation loop must run under a claim of its own").toBeDefined();
    const atDispatch = claimOf(observed.atModelDispatch!);
    const atLoop = claimOf(observed.atLoopEntry!);

    // 1. THE CLOCK RESTARTS. Before the fix these two stamps were the same instant, which is exactly
    //    why the loop's wall-clock counted against the model's window.
    expect(Date.parse(atLoop.dispatchedAt)).toBeGreaterThanOrEqual(Date.parse(atDispatch.dispatchedAt));
    expect(atLoop.timeoutMs).toBe(ARTICLE_BODY_VALIDATION_PHASE_TIMEOUT_MS);

    // 2. THE REVISION PHASE IS A FULL MODEL DISPATCH and claims a model-sized window, not a
    //    validator-sized one — otherwise the tick reclaims mid-dispatch exactly as it did before.
    expect(claimOf(observed.atRevision!).timeoutMs).toBe(atDispatch.timeoutMs);
    expect(Date.parse(claimOf(observed.atRevision!).dispatchedAt)).toBeGreaterThanOrEqual(Date.parse(atLoop.dispatchedAt));

    // 3. THE ACCEPTANCE TEST — one instant, judged against the claim as it was and as it now is.
    //
    //    The phases above are instantaneous here, so the wall-clock the fix exists for is staged.
    //    These are article_body's real numbers: a 300s node timeout (nodes.ts), a model that uses its
    //    whole window, ~30s of validator calls, then a revision that is a second full dispatch. The
    //    claim SHAPES below are the ones the executor actually stamped — only the elapsed time is
    //    supplied.
    const ARTICLE_BODY_TIMEOUT_MS = 300_000;
    const modelStart = 0;
    const loopStart = modelStart + ARTICLE_BODY_TIMEOUT_MS;   // the model used its whole window
    const revisionStart = loopStart + 30_000;                 // two validator calls later
    const tick = new Date(revisionStart + 70_000);            // a continuation tick, 70s into the revision
    const withClaim = (record: typeof observed.atLoopEntry, dispatchedAt: number, timeoutMs: number) =>
      ({ ...record!, nodes: [{ ...record!.nodes[0]!, dispatch: { ...record!.nodes[0]!.dispatch!, dispatchedAt: new Date(dispatchedAt).toISOString(), timeoutMs } }] });

    // BEFORE — ONE claim, stamped once at model dispatch: 400s elapsed against a 300s + 90s window.
    // The tick calls a node that is mid-revision a dead driver and re-dispatches it. This is the
    // observed gap_adjudicator loop, reproduced.
    expect(revisionStart + 70_000).toBeGreaterThan(ARTICLE_BODY_TIMEOUT_MS + STALL_MARGIN_MS);
    expect(decideRunContinuation(withClaim(observed.atModelDispatch, modelStart, ARTICLE_BODY_TIMEOUT_MS) as never, tick).code).toBe("reenter_stale_dispatch");

    // AFTER — the revision phase re-stamped at its own boundary with a MODEL-sized window (the shape
    // asserted in 2), so the same tick sees 70s of a 300s + 90s window: genuinely in flight.
    expect(decideRunContinuation(withClaim(observed.atRevision, revisionStart, ARTICLE_BODY_TIMEOUT_MS) as never, tick).code).toBe("skip_dispatch_in_flight");

    // And the validate phase between them is covered by its own, deliberately NARROWER window — wide
    // enough for the validator calls it can make, and no wider, so a driver that dies there is still
    // reclaimed in ~150s instead of being hidden for the eleven minutes a single worst-case claim
    // would have cost.
    expect(decideRunContinuation(withClaim(observed.atLoopEntry, loopStart, atLoop.timeoutMs) as never, new Date(loopStart + 20_000)).code).toBe("skip_dispatch_in_flight");
    expect(decideRunContinuation(withClaim(observed.atLoopEntry, loopStart, atLoop.timeoutMs) as never, new Date(loopStart + atLoop.timeoutMs + STALL_MARGIN_MS + 1_000)).code).toBe("reenter_stale_dispatch");
  });
});
