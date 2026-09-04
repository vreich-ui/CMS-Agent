// Cloud Run Job entrypoint for the continuation tick (Wave 2b's T5, relocated).
//
// WHY THIS EXISTS ON CLOUD RUN AND NOT NETLIFY — read before "simplifying" this away.
//
// The tick first shipped as a Netlify scheduled function. It was correct, it deployed, and it ran
// flawlessly every 60 seconds for hours doing NOTHING, because Netlify is the wrong plane. Phase 1
// of docs/platform/DIRECTION.md moved the execution plane to Cloud Run + GCS; the Netlify Blobs
// store has not received a conductor run since mid-July 2026. Observed 2026-08-14:
//
//   workflow.continuation_tick {"enabled":true,"scanned":21,"driven":[],"timedOut":false,
//     "refusals":[{"runId":"run_1784213511374_gl5o0h","code":"skip_not_active"}, ...]}
//
// All 21 were July runs from the abandoned Blobs store. The live runs — run_1786557897658_elj34j
// and everything after — live in the GCS bucket the MCP service writes, and the Netlify function
// could not see one of them. An API-mode read of the Blobs store confirmed the store itself held
// only those 21: the tick was reading correctly and there was simply nothing there.
//
// So the tick belongs where the runs are. It reuses bootstrapWorkspaceStore() from the conductor
// job — the same GCS store factory registration, so a tick and a conductor execution can never bind
// to different stores — and it drives runs through the same runNextNode the external
// workflow_run_all uses. It acquires no authority the external path lacks: `approved` is never
// passed, and every budget, approval and publish gate applies unchanged.
import { bootstrapWorkspaceStore } from "./runConductorJob.js";
import { repositoryManager } from "../runtime/repositories.js";
import { continuationTickEnabled, runContinuationTick, type ContinuationTickResult } from "../workspace/runContinuation.js";

export type ContinuationTickJobOptions = {
  timeBudgetMs?: number;
  maxRuns?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
};

// One structured line per execution, on stdout, matching the conductor job's convention so both are
// queryable the same way in Cloud Logging. A tick that decided to do nothing must still say what it
// scanned and why it refused each run — the Netlify incident above was legible ONLY because this
// line existed.
export const summarizeTick = (result: ContinuationTickResult): string => JSON.stringify({
  event: "workflow.continuation_tick",
  // W0 T0.2 — the ledger id, so the stdout line and the stored ticks/<tickId>.json record are
  // provably the same execution.
  ...(result.tickId ? { tickId: result.tickId } : {}),
  enabled: result.enabled,
  scanned: result.scanned,
  driven: result.driven.map((report) => ({ runId: report.runId, code: report.code, statusBefore: report.statusBefore, statusAfter: report.statusAfter, steps: report.steps, ...(report.chain ? { chain: report.chain } : {}) })),
  timedOut: result.timedOut,
  ...(result.driverSilent ? { driverSilent: true } : {}),
  ...(result.deferredDeadline ? { deferredDeadline: true } : {}),
  refusals: result.verdicts.filter((verdict) => !verdict.reenter).map((verdict) => ({ runId: verdict.runId, code: verdict.code }))
});

// W0 T0.2 — the exit-code rule, as a pure function so "when does this job fail" is answerable in a
// unit test without running a tick.
export const tickExitCode = (result: Pick<ContinuationTickResult, "driverSilent">): number => (result.driverSilent ? 1 : 0);

export async function runContinuationTickJob(options: ContinuationTickJobOptions = {}): Promise<{ result: ContinuationTickResult; exitCode: number }> {
  const log = options.log ?? (() => undefined);
  // Fail fast and loudly on store misconfiguration. A tick that silently binds to the WRONG store is
  // the exact failure this file's header documents, and it is invisible from the outside — the tick
  // reports a healthy scan of a store nobody is writing.
  bootstrapWorkspaceStore();
  if (!continuationTickEnabled()) {
    log("RUN_CONTINUATION_TICK is off; the tick is deployed but will drive nothing until it is unset.");
  }
  const result = await runContinuationTick({
    executionRepository: repositoryManager.getExecutionRepository(),
    workspaceRepository: repositoryManager.getWorkspaceRepository(),
    ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
    ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns })
  });
  // Exit 0 even when nothing was driven: "no run needed advancing" is the healthy steady state, and a
  // non-zero exit there would make Cloud Scheduler retry and alert on normal operation. Only a THROWN
  // failure (store unreachable, misconfiguration) is non-zero — see runContinuationTickMain.ts.
  //
  // W0 T0.2 — with ONE addition, and it is the point of the wave. "Nothing needed advancing" and "I
  // have failed to advance an advanceable run three ticks running" were the same green job before
  // this line: on 2026-09-04 the job exited 0 every two minutes through a 44-minute hole. The second
  // case now fails the job, so Cloud Run job failures — the thing Scheduler and alerting actually
  // watch — finally include the failure mode that matters.
  return { result, exitCode: tickExitCode(result) };
}

export async function continuationTickCliMain(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<number> {
  const budget = Number(env.CONTINUATION_TICK_BUDGET_MS);
  const maxRuns = Number(env.CONTINUATION_TICK_MAX_RUNS);
  const { result, exitCode } = await runContinuationTickJob({
    ...(Number.isFinite(budget) && budget > 0 ? { timeBudgetMs: budget } : {}),
    ...(Number.isFinite(maxRuns) && maxRuns > 0 ? { maxRuns } : {}),
    ...(signal ? { signal } : {}),
    log: (line) => console.error(line)
  });
  console.log(summarizeTick(result));
  return exitCode;
}
