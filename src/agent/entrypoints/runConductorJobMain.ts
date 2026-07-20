// Process wrapper for the Cloud Run Job (see runConductorJob.ts). Kept separate from the logic
// module so importing runConductorJob never registers signal handlers or triggers execution.
// Cloud Run sends SIGTERM before killing a task; aborting lets the loop finish the in-flight node
// and persist state, so the run resumes with --run <runId> on the next execution.
import { cliMain } from "./runConductorJob.js";

const controller = new AbortController();
for (const signalName of ["SIGTERM", "SIGINT"] as const) {
  process.once(signalName, () => {
    console.error(`${signalName} received — finishing the in-flight node, then persisting state; the run remains resumable.`);
    controller.abort();
  });
}

try {
  process.exitCode = await cliMain(process.argv.slice(2), process.env, controller.signal);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
