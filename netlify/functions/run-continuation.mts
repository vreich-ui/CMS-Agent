// T5 (Wave 2b) — the scheduled continuation tick's deploy shell. Deliberately thin: every decision
// (which runs are re-entered, which are refused and why, how long one tick may run) lives in
// src/agent/workspace/runContinuation.ts, where it is a pure function under unit test. This file only
// binds it to Netlify's scheduler and the repository bootstrap.
//
// THIS IS A v2 FUNCTION (`export default`), and deliberately the only one in this repo — the others
// are all v1 (`export const handler`). It was v1 too when it first shipped, and that was a live bug:
//
//   Deployed 2026-08-13T16:13Z with the schedule correctly registered
//   (function_schedules: [{cron: "* * * * *", name: "run-continuation"}]), it ran every minute for 36
//   minutes and advanced NOTHING. run_1786557897658_elj34j sat at rev 41 with one queued node and a
//   22-hour-old heartbeat — a run the selector unambiguously classifies "reenter_stale_dispatch".
//   Cause: the v1 shell called connectLambdaBlobs(event), copied from the HTTP functions. That helper
//   returns early unless event.blobs is a non-empty string (see lambdaBlobs.ts), and Netlify injects
//   the Blobs context only into HTTP-triggered lambda events — a SCHEDULED invocation carries no such
//   context. So Blobs never connected, and the very next line (getExecutionRepository() ->
//   getStore({name}) in blobClient.ts) threw MissingBlobsEnvironmentError before the tick read a
//   single run. Identically, every minute, visible only in the platform log.
//
// A v2 function gets its Blobs environment from the runtime directly, so getStore({name}) binds with
// no connectLambda step at all — which is why the connectLambdaBlobs call is GONE below rather than
// guarded. Do not "restore consistency" with the v1 functions here; the inconsistency is the fix.
// NOTHING IS IMPORTED AT MODULE SCOPE, deliberately — see the `config` export at the bottom. The
// imports live inside the handler so this module loads with no side effects and no dependency chain,
// which is what lets the build's config extraction read the schedule without executing the agent
// runtime.

export default async () => {
  const { refreshRepositoryManagerForRequest, repositoryManager } = await import("../../src/agent/runtime/repositories.js");
  const { runContinuationTick } = await import("../../src/agent/workspace/runContinuation.js");
  // Refreshed per invocation so a Blob-backed store binds to THIS invocation's environment rather
  // than a manager cached from a previous warm invocation.
  refreshRepositoryManagerForRequest();
  try {
    const result = await runContinuationTick({
      executionRepository: repositoryManager.getExecutionRepository(),
      workspaceRepository: repositoryManager.getWorkspaceRepository()
    });
    // One structured line per tick: what was scanned, what was driven, and the NAMED refusal for
    // every run that was not. A tick that decided to do nothing must say why it decided that.
    console.info("workflow.continuation_tick", JSON.stringify({
      enabled: result.enabled,
      scanned: result.scanned,
      driven: result.driven,
      timedOut: result.timedOut,
      refusals: result.verdicts.filter((verdict) => !verdict.reenter).map((verdict) => ({ runId: verdict.runId, code: verdict.code }))
    }));
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  } catch (error) {
    // The bug above cost 36 silent ticks precisely because a throw here looks identical to a quiet
    // tick from outside the platform log. A failure now names ITSELF on the same structured channel
    // the success path uses, so "the tick is broken" and "the tick had nothing to do" are one grep
    // apart. Name and a truncated message only — a Blobs failure can echo decoded credential bytes,
    // which is why lambdaBlobs.ts makes the same trade.
    console.error("workflow.continuation_tick_failed", JSON.stringify({
      error: error instanceof Error ? error.name : "unknown",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 200)
    }));
    // 500, not a swallowed 200: a scheduled function that reports success while doing nothing is the
    // exact failure mode this whole file is a fix for.
    return new Response(JSON.stringify({ ok: false, error: "continuation_tick_failed" }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

// THE SCHEDULE MUST BE A LITERAL HERE. It was `{ schedule: CONTINUATION_TICK_CRON }` — an imported
// identifier — and the deploy that first made this function v2 (6a7df900, 2026-08-13T17:04:38Z) came
// back with `function_schedules: []`, where the preceding v1 deploy had reported
// `[{cron: "* * * * *", name: "run-continuation"}]`. The build's config extraction could not resolve
// the identifier, so the function deployed correctly and nothing ever called it — a worse failure
// than the Blobs bug it replaced, because an unscheduled function logs nothing at all.
//
// netlify.toml still declares the same expression, but that path is a v1 mechanism and this deploy
// proved it is INERT for a v2 function: the toml entry was present and the schedule was still empty.
// It is kept only as a safety net should this function ever regress to v1.
//
// tests/agent/continuationTickSchedule.test.ts asserts this literal equals CONTINUATION_TICK_CRON, so
// the duplication cannot drift.
export const config = { schedule: "* * * * *" };
