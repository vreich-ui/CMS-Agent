// T15.9 (#188) — the in-call "kick" (T12.11's KICK RULE) extracted from siteDuplicationTools.ts so
// the chained clone run gets the IDENTICAL "start AND kick" treatment the capture run already gets.
// One implementation, two callers (site.duplicate's own kick of capture, and
// siteDuplicationChain.ts's kick of the clone run it starts) — so the chain can never behave
// differently from the entry point it is chained after, and a future change to the kick contract
// (the no-progress stop rule, the step cap, the time budget shape) never has to be made twice.
//
// Advance while nodes settle; stop at the first no-progress advance (an external job parking the
// run — the pdf-tool crawl plane is the only one today, but this is deliberately generic), a halted
// status, the step cap, or the time budget. Never supplies `approved` — that authority belongs to an
// operator or to policy (resolvePublishAuthority), never to a caller kicking a run forward.
import { getRun, runNextNode } from "./executor.js";
import { HALTED_EXECUTION_STATUSES, type WorkflowExecutionRecord } from "./executionTypes.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";

export const KICK_MAX_STEPS = 60;
export const DEFAULT_KICK_TIME_BUDGET_MS = 60_000;

// Reads an env-configured override for a kick's wall-clock budget, falling back to `fallbackMs`.
// Kept as a small pure function (not a module-level constant) so two kick sites can each read their
// own env var without one caching the other's value at import time.
export const resolveKickTimeBudgetMs = (envVar: string, fallbackMs: number = DEFAULT_KICK_TIME_BUDGET_MS): number => {
  const configured = Number(process.env[envVar]);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : fallbackMs;
};

const settledCount = (run: WorkflowExecutionRecord): number =>
  run.nodes.filter((node) => node.status === "completed" || node.status === "skipped" || node.status === "failed").length;

export type KickDeps = { executionRepository: ExecutionRepository; workspaceRepository?: WorkspaceRepository };
export type KickOptions = { timeBudgetMs?: number; maxSteps?: number };
export type KickResult = { steps: number; stoppedBecause: string; run: WorkflowExecutionRecord };

export async function kickRun(runId: string, deps: KickDeps, options: KickOptions = {}): Promise<KickResult> {
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_KICK_TIME_BUDGET_MS;
  const maxSteps = options.maxSteps ?? KICK_MAX_STEPS;
  const deadline = Date.now() + timeBudgetMs;
  let run = (await getRun(runId, deps.executionRepository))!;
  let steps = 0;
  let stoppedBecause = "run_halted";
  while (!HALTED_EXECUTION_STATUSES.has(run.status)) {
    if (steps >= maxSteps) { stoppedBecause = "kick_step_cap"; break; }
    if (Date.now() > deadline) { stoppedBecause = "kick_time_budget"; break; }
    const before = settledCount(run);
    run = await runNextNode(runId, { executionRepository: deps.executionRepository, workspaceRepository: deps.workspaceRepository });
    steps += 1;
    if (!HALTED_EXECUTION_STATUSES.has(run.status) && settledCount(run) <= before) {
      // No node settled on this advance: the run is parked on external work (e.g. a pending pdf-tool
      // capture job). The long-run planes own it from here — polling inside one request/tick window
      // would spin instead of handing off.
      stoppedBecause = "handed_to_long_run_plane";
      break;
    }
  }
  return { steps, stoppedBecause, run };
}
