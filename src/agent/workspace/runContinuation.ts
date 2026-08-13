// T5 (Wave 2b, 2026-08-13) — THE SCHEDULED CONTINUATION TICK, and the pure selector under it.
//
// Evidence (run_1786557897658_elj34j, verified live 2026-08-12): 12.8 minutes of wall clock for ~7.3
// minutes of model work. A 192-second idle gap before reader_simulation and a 64-second gap before
// artifact_plan were not the model thinking — they were the driver PARKED between external
// workflow_run_all calls. Every node advance is individually persisted (advanceRun), so the run was
// resumable that entire time; nothing was in flight and nobody re-entered it. The external caller was
// the scheduler, and its poll interval was the run's pacing.
//
// This module replaces that poller and NOTHING else:
//   - it never supplies `approved` (approval is the operator's, not a cron's);
//   - it never re-enters a halted run — blocked (approval or budget), paused, cancelled, failed,
//     completed are all left exactly where the executor put them;
//   - it never re-enters a run that is genuinely mid-dispatch — that is what the dispatch heartbeat
//     (executionTypes.NodeDispatchClaim, read through executor.assessRunStall) is for;
//   - it never re-enters a run the operator vetoed (see skip_operator_withheld below).
// Every gate the executor applies on an external advance applies here unchanged, because this drives
// the run through the same runNextNode entry point an external caller uses.
//
// The selector is a PURE function of the persisted record plus a clock, so "which runs would this
// tick touch, and which would it refuse" is answerable in a unit test with no repository, no network
// and no schedule. The scheduled function is a thin shell over it.

import { assessRunStall, runNextNode, type RunStallInfo } from "./executor.js";
import { isOperatorPublishWithheld } from "./publishDecision.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "./executionTypes.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";

// The only two statuses an unattended driver may touch. Everything else is a stop somebody or
// something put there deliberately, and a tick that "helpfully" advanced past one would be the exact
// gate-weakening this program exists to prevent.
export const CONTINUABLE_RUN_STATUSES: readonly ExecutionStatus[] = ["running", "queued"];

// Named verdicts, one per scanned run. No run is ever silently dropped from a tick: a refusal is a
// record with a code and a reason, so "why was my run not advanced" is answered by the tick's own
// output instead of reconstructed from its absence.
export type ContinuationVerdictCode =
  | "reenter_idle_driver"      // active status, nothing in flight — the parked-driver case above
  | "reenter_stale_dispatch"   // a dispatch claim outlived its own timeout; advanceRun reclaims it
  | "skip_not_active"          // completed / failed / blocked / cancelled / paused — a stop, honoured
  | "skip_dispatch_in_flight"  // a live claim inside its window — re-entering would double-dispatch
  | "skip_operator_withheld";  // the operator's durable publish veto (P0 §2.2)

export type ContinuationVerdict = {
  runId: string;
  status: ExecutionStatus;
  reenter: boolean;
  code: ContinuationVerdictCode;
  reason: string;
  // The exact signal the decision was taken on, carried so a tick log can be audited against the
  // record. Absent for non-running runs (assessRunStall reports only on status "running").
  stall?: RunStallInfo;
};

// THE PREDICATE, in one place: re-enter a run iff its status is "running" or "queued", the operator
// has not vetoed it, and the dispatch heartbeat shows nothing genuinely in flight.
//
// "Nothing in flight" is deliberately NOT "stalledSuspected" — a run that just saved a node and is
// between dispatches reports stalledSuspected:false for the first STALL_MARGIN_MS (90s), and waiting
// that out would rebuild the 192-second idle gap this exists to remove. The signal that matters is
// the one assessRunStall already computes: is there an in-flight node inside its claim window. A
// queued run never carries a live claim (the claim and status "running" are written in the same save,
// executeRunnableNode), which is why assessRunStall's "running"-only scope is sufficient here rather
// than a second liveness notion invented for the tick.
export const decideRunContinuation = (run: WorkflowExecutionRecord, at: Date = new Date()): ContinuationVerdict => {
  const base = { runId: run.runId, status: run.status };
  if (!CONTINUABLE_RUN_STATUSES.includes(run.status)) {
    return { ...base, reenter: false, code: "skip_not_active", reason: `Run status "${run.status}" is a stop the executor or an operator put there; the tick advances only ${CONTINUABLE_RUN_STATUSES.join("/")} runs. Clearing a block is an operator act (approval, a raised budgetUsd, resume_run), never a scheduled one.` };
  }
  // A withheld decision is the operator taking the run back. It is only ever set by an explicit
  // set_operator_publish_decision call (T2: the project-policy default can only produce "approved"),
  // so this can never be a config accident — and an unattended tick driving a vetoed run toward a gate
  // it can never pass would spend model money on the operator's behalf against their stated decision.
  if (isOperatorPublishWithheld(run)) {
    return { ...base, reenter: false, code: "skip_operator_withheld", reason: "The operator's durable publish decision for this run is \"withheld\". The tick does not drive a run the operator stopped; advance it by hand if the non-publish tail is still wanted." };
  }
  const stall = assessRunStall(run, at);
  if (stall?.inFlightNodeId && !stall.stalledSuspected) {
    return { ...base, reenter: false, code: "skip_dispatch_in_flight", reason: `Node ${stall.inFlightNodeId} was dispatched at ${stall.dispatchedAt} and is inside its ${stall.timeoutMs}ms claim window — something is genuinely in flight. Re-entering would double-dispatch it.`, stall };
  }
  if (stall?.inFlightNodeId) {
    return { ...base, reenter: true, code: "reenter_stale_dispatch", reason: `Node ${stall.inFlightNodeId}'s dispatch claim outlived its own timeout — the driver died mid-node. The advance reclaims the stale claim and continues from persisted state.`, stall };
  }
  return { ...base, reenter: true, code: "reenter_idle_driver", reason: "Nothing is in flight and the run is not halted: the driver is parked between nodes. Re-entering continues it from persisted state under every gate an external advance applies.", ...(stall ? { stall } : {}) };
};

export type ContinuationSelection = { reenter: ContinuationVerdict[]; skipped: ContinuationVerdict[] };

export const selectContinuableRuns = (runs: readonly WorkflowExecutionRecord[], at: Date = new Date()): ContinuationSelection => {
  const verdicts = runs.map((run) => decideRunContinuation(run, at));
  return { reenter: verdicts.filter((verdict) => verdict.reenter), skipped: verdicts.filter((verdict) => !verdict.reenter) };
};

// The schedule, in the one form Netlify accepts (cron, whose finest granularity is one minute — a
// 30s tick is not expressible there, so 60s is the floor and is what the acceptance run's "no idle
// gap greater than the tick interval" is measured against).
export const CONTINUATION_TICK_CRON = "* * * * *";
export const CONTINUATION_TICK_INTERVAL_MS = 60_000;

// Wall-clock budget for ONE tick's advance loop, checked BETWEEN node advances (a dispatch already in
// progress is never cut short — the budget stops the loop starting another node, exactly as
// RUN_DRIVER_TIME_BUDGET_MS does for workflow.run_all). Defaulted under the tick interval so ticks
// rarely overlap; overlap is safe regardless (the dispatch claim plus the repository compare-and-swap
// are what make concurrent drivers safe, not this number), it is merely wasteful.
export const CONTINUATION_TICK_BUDGET_MS = (() => {
  const configured = Number(process.env.CONTINUATION_TICK_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 45_000;
})();

// Kill switch. The tick starts driving the moment the function deploys, so there has to be one thing
// an operator can set to stop it without a redeploy. Any of "off"/"false"/"0" disables it.
export const continuationTickEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !["off", "false", "0"].includes((env.RUN_CONTINUATION_TICK ?? "on").trim().toLowerCase());

export type ContinuationTickDeps = {
  executionRepository: ExecutionRepository;
  workspaceRepository?: WorkspaceRepository;
  // Injected for tests; production is the same runNextNode an external workflow_run_all call drives,
  // so the tick can never acquire semantics the external path does not have. `approved` is never
  // passed — a scheduled tick has no authority to approve a publish.
  advance?: (runId: string) => Promise<WorkflowExecutionRecord>;
  now?: () => Date;
  timeBudgetMs?: number;
  maxRuns?: number;
  maxStepsPerRun?: number;
};

export type ContinuationRunReport = {
  runId: string;
  code: ContinuationVerdictCode;
  statusBefore: ExecutionStatus;
  statusAfter?: ExecutionStatus;
  steps: number;
  // Named, never swallowed: one run's failure must not take the tick (or the other runs) down.
  error?: string;
};

export type ContinuationTickResult = {
  enabled: boolean;
  scanned: number;
  verdicts: ContinuationVerdict[];
  driven: ContinuationRunReport[];
  timedOut: boolean;
};

// Matches workflow.run_all's advance bound; the canonical graph has 18 nodes, so this is headroom for
// retries, never a pacing mechanism.
const DEFAULT_MAX_STEPS_PER_RUN = 100;
// Runs are driven sequentially within a tick, so this bounds how long one tick can be held by a
// backlog. Runs beyond it are picked up by the next tick — a bounded delay, not a dropped run.
const DEFAULT_MAX_RUNS = 5;

export async function runContinuationTick(deps: ContinuationTickDeps): Promise<ContinuationTickResult> {
  const clock = deps.now ?? (() => new Date());
  if (!continuationTickEnabled()) return { enabled: false, scanned: 0, verdicts: [], driven: [], timedOut: false };
  const advance = deps.advance ?? ((runId: string) => runNextNode(runId, { executionRepository: deps.executionRepository, workspaceRepository: deps.workspaceRepository }));
  const budgetMs = deps.timeBudgetMs ?? CONTINUATION_TICK_BUDGET_MS;
  const maxSteps = Math.max(1, Math.floor(deps.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN));
  const deadline = clock().getTime() + budgetMs;
  const runs = await deps.executionRepository.listRuns({});
  const { reenter, skipped } = selectContinuableRuns(runs, clock());
  const selected = reenter.slice(0, Math.max(1, Math.floor(deps.maxRuns ?? DEFAULT_MAX_RUNS)));
  const driven: ContinuationRunReport[] = [];
  let timedOut = false;

  for (const verdict of selected) {
    if (clock().getTime() > deadline) { timedOut = true; break; }
    const report: ContinuationRunReport = { runId: verdict.runId, code: verdict.code, statusBefore: verdict.status, steps: 0 };
    driven.push(report);
    try {
      // Re-decide before EVERY advance against the state the previous advance just persisted: another
      // driver (an external run_all, the conductor job, an overlapping tick) may have taken the run
      // meanwhile, and the gate the executor applied one node ago may be the reason to stop now.
      let current = await deps.executionRepository.getRun(verdict.runId);
      while (current && decideRunContinuation(current, clock()).reenter && report.steps < maxSteps) {
        if (clock().getTime() > deadline) { timedOut = true; break; }
        current = await advance(verdict.runId);
        report.steps += 1;
      }
      report.statusAfter = current?.status;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  }
  return { enabled: true, scanned: runs.length, verdicts: [...reenter, ...skipped], driven, timedOut };
}
