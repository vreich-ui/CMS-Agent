// T5 (Wave 2b) — the scheduled continuation tick's deploy shell. Deliberately thin: every decision
// (which runs are re-entered, which are refused and why, how long one tick may run) lives in
// src/agent/workspace/runContinuation.ts, where it is a pure function under unit test. This file only
// binds it to Netlify's scheduler and the request-scoped repository bootstrap the other functions use.
//
// There was no scheduled function in this repo before this one, so it follows Netlify's in-code
// convention (`export const config = { schedule }`) rather than mirroring an in-repo precedent.
// Netlify cron granularity is one minute, so CONTINUATION_TICK_CRON is "* * * * *" — the 60s end of
// the 30-60s interval the plan asked for; 30s is not expressible on this platform.

import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";
import { refreshRepositoryManagerForRequest } from "../../src/agent/runtime/repositories.js";
import { repositoryManager } from "../../src/agent/runtime/repositories.js";
import { CONTINUATION_TICK_CRON, runContinuationTick } from "../../src/agent/workspace/runContinuation.js";

// Netlify hands a scheduled function the same event shape the other functions here receive; the Blobs
// context must be connected before any repository access (see lambdaBlobs.ts), and the manager is
// refreshed per invocation so a Blob-backed store binds to THIS invocation's credentials.
type ScheduledEvent = { blobs?: unknown; headers?: unknown };

export const handler = async (event: ScheduledEvent = {}) => {
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();
  const result = await runContinuationTick({
    executionRepository: repositoryManager.getExecutionRepository(),
    workspaceRepository: repositoryManager.getWorkspaceRepository()
  });
  // One structured line per tick: what was scanned, what was driven, and the NAMED refusal for every
  // run that was not. A tick that decided to do nothing must say why it decided that.
  console.info("workflow.continuation_tick", JSON.stringify({
    enabled: result.enabled,
    scanned: result.scanned,
    driven: result.driven,
    timedOut: result.timedOut,
    refusals: result.verdicts.filter((verdict) => !verdict.reenter).map((verdict) => ({ runId: verdict.runId, code: verdict.code }))
  }));
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
};

export const config = { schedule: CONTINUATION_TICK_CRON };
