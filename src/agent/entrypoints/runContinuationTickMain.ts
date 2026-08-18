// Process wrapper for the continuation-tick Cloud Run Job (see runContinuationTickJob.ts). Kept
// separate from the logic module for the same reason runConductorJobMain.ts is: importing the logic
// must never register signal handlers or trigger execution.
//
// Cloud Run sends SIGTERM before killing a task. The tick drives runs through the same runNextNode
// the conductor job uses, so aborting lets the in-flight node finish and persist; whatever is left
// is picked up by the next tick, which is a bounded delay rather than a lost run.
import { continuationTickCliMain } from "./runContinuationTickJob.js";

const controller = new AbortController();
for (const signalName of ["SIGTERM", "SIGINT"] as const) {
  process.once(signalName, () => {
    console.error(`${signalName} received — finishing the in-flight node, then persisting state; remaining runs are picked up by the next tick.`);
    controller.abort();
  });
}

try {
  process.exitCode = await continuationTickCliMain(process.env, controller.signal);
} catch (error) {
  // A throw here means the tick could not even read the store — the failure mode that cost 36 silent
  // firings on Netlify. Non-zero so Cloud Scheduler surfaces it instead of counting a dead tick as a
  // successful one.
  console.error(JSON.stringify({
    event: "workflow.continuation_tick_failed",
    error: error instanceof Error ? error.name : "unknown",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 200)
  }));
  process.exitCode = 1;
}
