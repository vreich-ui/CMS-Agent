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

import { assessRunStall, nextDispatchTimeoutMs, runNextNode, DISPATCH_DEADLINE_MARGIN_MS, type RunStallInfo } from "./executor.js";
import { isOperatorPublishWithheld } from "./publishDecision.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "./executionTypes.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { UsageRepository } from "../repository/interfaces/UsageRepository.js";
import type { DriverHealthRepository } from "../repository/interfaces/DriverHealthRepository.js";
import { applyRunDriverHealth, makeTickId, TICK_LEDGER_RETENTION_MS, type TickLedgerEntry, type TickLedgerRefusal } from "./driverHealth.js";

import { repositoryManager } from "../runtime/repositories.js";
import { logProjectEnvNamesOnce, preflightDriverEnv, recordDriverEnvWarning } from "./driverEnvPreflight.js";
// T15.9 (#188) — THIS is the "continuation plane" the issue names as the driver that chains
// clone_conductor after capture: capture_crawl parks on the pdf-tool plane (see the module header
// above), so it is THIS tick — not the site.duplicate MCP call — that is normally the first thing to
// ever observe a site.duplicate-originated capture run reach a terminal status. See
// siteDuplicationChain.ts for the full contract (scope, failure semantics, budget, determinism).
import { maybeChainCloneAfterCapture } from "./siteDuplicationChain.js";

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
  | "skip_operator_withheld"   // the operator's durable publish veto (P0 §2.2)
  | "skip_retry_backoff"       // W1 T1.1 — every remaining node is waiting out an orchestrator retry
  // W0 T1.2 — REPORT-ONLY, never produced by decideRunContinuation. The tick had less task time left
  // than the next dispatch's own timeout plus its margin, so it declined to start a node the platform
  // would kill mid-flight and left the run for the next tick.
  | "deferred_deadline";

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
  // W1 T1.1 — a run whose only remaining work is an orchestrator retry that has not come due is
  // WAITING, not parked. Re-entering it would dispatch nothing and, without this, the tick's advance
  // loop would spin against a no-op advance until its step bound. The backoff is short (60-120s), so
  // the next tick picks it up.
  if (run.retryBackoffUntil && Date.parse(run.retryBackoffUntil) > at.getTime()) {
    return { ...base, reenter: false, code: "skip_retry_backoff", reason: `The run's only remaining work is an orchestrator retry that comes due at ${run.retryBackoffUntil}. A tick after that dispatches it — no human retry needed, and re-entering now would dispatch nothing.` };
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

// W0 T1.2 — the driver task's own wall-clock ceiling. On Cloud Run this is `--task-timeout` (600s
// after C2.2; 300s when the incident happened) and the platform kills the task at it with no warning
// and no chance to persist. Read from the environment so the code and the deploy flag cannot drift
// apart silently, defaulted to the pre-C2.2 300s — the conservative direction, since a too-small
// value only defers a dispatch by one tick while a too-large one loses a node mid-flight.
export const TASK_TIMEOUT_MS = (env: NodeJS.ProcessEnv = process.env): number => {
  const configured = Number(env.TASK_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 300_000;
};

export type ContinuationTickDeps = {
  executionRepository: ExecutionRepository;
  workspaceRepository?: WorkspaceRepository;
  // Injected for tests; production is the same runNextNode an external workflow_run_all call drives,
  // so the tick can never acquire semantics the external path does not have. `approved` is never
  // passed — a scheduled tick has no authority to approve a publish.
  advance?: (runId: string) => Promise<WorkflowExecutionRecord>;
  // S1 — driver env preflight. The tick refuses to dispatch a run whose project MCP endpoint env var
  // is not set in ITS process (records `driver_env_missing:<VAR>` on the run once instead). Injected
  // for tests; production reads the live project registry and process.env.
  projectRepository?: ProjectRepository;
  // T15.9 (#188) — read by maybeChainCloneAfterCapture to price capture's own accrued spend against
  // the chain's shared budgetUsd (see siteDuplicationChain.ts). Injected for tests; production reads
  // the live usage store.
  usageRepository?: UsageRepository;
  // W0 T0.2/T0.3 — the tick ledger and per-tenant background-dispatch stamp. Injected for tests;
  // production reads the live store. Every write through it is best-effort: a ledger this tick could
  // not write must never stop the tick from driving runs.
  driverHealthRepository?: DriverHealthRepository;
  // W0 T1.2 — the driver process's own task timeout (Cloud Run --task-timeout, in ms). A dispatch is
  // deferred to the next tick when the node's claim would outlive it. Injected for tests; production
  // reads TASK_TIMEOUT_MS.
  taskTimeoutMs?: number;
  // Injected for tests: how long the run's next dispatch could take. Production resolves the real
  // node graph through executor.nextDispatchTimeoutMs (serial node, or the widest in the batch).
  dispatchTimeoutMs?: (run: WorkflowExecutionRecord) => Promise<number | undefined>;
  env?: NodeJS.ProcessEnv;
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
  // Set when the tick declined to dispatch because this process cannot see the run's project MCP
  // endpoint (driver_env_missing:<VAR>). steps is 0; the run is left for a driver that can.
  skippedReason?: string;
  // T15.9 (#188) — set when this run's advance loop ended on a HALTED capture_conductor run that
  // carries a site.duplicate request marker: "chained" (with the new clone runId) or "refused"
  // (with the named code) from maybeChainCloneAfterCapture. Absent for every other run.
  chain?: { action: "chained"; cloneRunId: string } | { action: "refused"; code: string };
  // W0 T1.2 — set when this run's advance was deferred because the remaining task time could not
  // hold the next dispatch's own timeout. steps may be > 0: the deferral is decided per dispatch, so
  // a tick can advance three nodes and defer the fourth.
  deferredReason?: string;
};

export type ContinuationTickResult = {
  enabled: boolean;
  scanned: number;
  verdicts: ContinuationVerdict[];
  driven: ContinuationRunReport[];
  timedOut: boolean;
  // W0 T0.2 — this execution's ledger id, so a stdout line and its stored record are the same event.
  tickId?: string;
  // W0 T0.2 — at least one run has now been selected for re-entry and advanced ZERO steps for
  // SILENT_TICK_THRESHOLD consecutive ticks. The Cloud Run job exits 1 on this, which is the whole
  // point: a driver that has stopped driving must be able to fail its own job.
  driverSilent?: boolean;
  // W0 T1.2 — this tick stopped early because the next dispatch could not fit in the task's own
  // remaining time. Not a failure: the next tick starts that node with a full task ahead of it.
  deferredDeadline?: boolean;
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
  const advance = deps.advance ?? ((runId: string) => runNextNode(runId, { executionRepository: deps.executionRepository, workspaceRepository: deps.workspaceRepository, driver: "continuation_tick" }));
  const projectRepository = deps.projectRepository ?? repositoryManager.getProjectRepository();
  const usageRepository = deps.usageRepository ?? repositoryManager.getUsageRepository();
  // W0 T0.2/T0.3 — resolved lazily and defensively: a store this process cannot reach must cost the
  // tick its LEDGER, never its ability to drive runs.
  const driverHealthRepository = (() => {
    if (deps.driverHealthRepository) return deps.driverHealthRepository;
    try { return repositoryManager.getDriverHealthRepository(); } catch { return undefined; }
  })();
  const env = deps.env ?? process.env;
  await logProjectEnvNamesOnce(projectRepository, env);
  const budgetMs = deps.timeBudgetMs ?? CONTINUATION_TICK_BUDGET_MS;
  const maxSteps = Math.max(1, Math.floor(deps.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN));
  const tickStartedAt = clock();
  const tickId = makeTickId(tickStartedAt);
  const deadline = tickStartedAt.getTime() + budgetMs;
  // W0 T1.2 — the HARD ceiling, distinct from the tick's own soft time budget above: exceeding the
  // budget ends the loop cleanly, while exceeding this one has the platform kill the process with a
  // node in flight (2026-09-04: article_body, 12.7 minutes and ~$0.60 lost to a 300s task timeout).
  const taskTimeoutMs = deps.taskTimeoutMs ?? TASK_TIMEOUT_MS(env);
  const taskDeadline = tickStartedAt.getTime() + taskTimeoutMs;
  const dispatchTimeoutMs = deps.dispatchTimeoutMs ?? ((run: WorkflowExecutionRecord) => nextDispatchTimeoutMs(run, deps.workspaceRepository).catch(() => undefined));
  const runs = await deps.executionRepository.listRuns({});
  const { reenter, skipped } = selectContinuableRuns(runs, clock());
  const selected = reenter.slice(0, Math.max(1, Math.floor(deps.maxRuns ?? DEFAULT_MAX_RUNS)));
  const driven: ContinuationRunReport[] = [];
  let timedOut = false;
  let deferredDeadline = false;

  for (const verdict of selected) {
    if (clock().getTime() > deadline) { timedOut = true; break; }
    const report: ContinuationRunReport = { runId: verdict.runId, code: verdict.code, statusBefore: verdict.status, steps: 0 };
    driven.push(report);
    try {
      // Re-decide before EVERY advance against the state the previous advance just persisted: another
      // driver (an external run_all, the conductor job, an overlapping tick) may have taken the run
      // meanwhile, and the gate the executor applied one node ago may be the reason to stop now.
      let current = await deps.executionRepository.getRun(verdict.runId);
      // Driver env preflight — BEFORE the first advance. A run this process cannot serve is not
      // dispatched at all: the warning is recorded once and the run is left for a driver that can.
      if (current) {
        const preflight = await preflightDriverEnv(current, projectRepository, env);
        if (!preflight.ok) {
          current = await recordDriverEnvWarning(current, preflight.warning, deps.executionRepository);
          report.skippedReason = preflight.warning;
          report.statusAfter = current.status;
          continue;
        }
      }
      while (current && decideRunContinuation(current, clock()).reenter && report.steps < maxSteps) {
        if (clock().getTime() > deadline) { timedOut = true; break; }
        // W0 T1.2 — DEADLINE-AWARE DISPATCH. Ask how long the next dispatch could claim (the node's
        // own timeout, or the widest in the concurrent batch) and refuse to start it if the task
        // cannot hold it plus its margin. Deferring costs one tick interval; dispatching anyway costs
        // the node's whole spend plus the claim's 90s expiry before anything can pick it up again.
        //
        // ONE EXCEPTION, and it is what keeps this from being a livelock: a node whose own timeout
        // cannot fit in a WHOLE fresh task (a deterministic capture stage claims 300s, and the task
        // was 300s before C2.2 raised it to 600s) gains nothing from being deferred — every future
        // tick would refuse it for the same reason and the run would never move again. Such a node is
        // dispatched exactly as it was before this wave; the fix for it is the task-timeout flag, not
        // a deferral loop.
        const nextTimeoutMs = await dispatchTimeoutMs(current);
        const fitsAFreshTask = nextTimeoutMs !== undefined && nextTimeoutMs + DISPATCH_DEADLINE_MARGIN_MS <= taskTimeoutMs;
        if (fitsAFreshTask && clock().getTime() + nextTimeoutMs! + DISPATCH_DEADLINE_MARGIN_MS > taskDeadline) {
          report.code = "deferred_deadline";
          report.deferredReason = `Next dispatch claims ${nextTimeoutMs}ms and this task has ${Math.max(0, taskDeadline - clock().getTime())}ms left; starting it would have the platform kill it mid-node. Deferred to the next tick, which starts it with a full task ahead of it.`;
          deferredDeadline = true;
          break;
        }
        const before = current;
        current = await advance(verdict.runId);
        report.steps += 1;
        // W1 T1.1 — an advance that changed nothing (the executor found nothing to dispatch, e.g.
        // every remaining node is inside its retry backoff) must end this run's loop. Without this,
        // a no-op advance that leaves the run re-enterable spins to the step bound.
        if (current && before && current.rev !== undefined && current.rev === before.rev && current.updatedAt === before.updatedAt) break;
      }
      // T15.9 (#188) — this run's advance loop just stopped. If it stopped because the run reached a
      // HALTED status (decideRunContinuation no longer reenters it) and it is a site.duplicate-
      // originated capture_conductor run, decide the chain now: this is the FIRST and, for a normally
      // parked capture (capture_crawl on the pdf-tool plane), the ONLY place that observes the
      // transition — see siteDuplicationChain.ts. A no-op for every other run (wrong workflow, no
      // site.duplicate marker, or not yet halted — e.g. the loop stopped on maxSteps/deadline while
      // still mid-run, correctly deferred to the next tick).
      if (current) {
        const chainOutcome = await maybeChainCloneAfterCapture(current, { executionRepository: deps.executionRepository, workspaceRepository: deps.workspaceRepository, usageRepository });
        if (chainOutcome.action === "chained") {
          current = chainOutcome.captureRun;
          report.chain = { action: "chained", cloneRunId: chainOutcome.cloneRunId };
        } else if (chainOutcome.action === "refused") {
          current = chainOutcome.captureRun;
          report.chain = { action: "refused", code: chainOutcome.code };
        }
      }
      report.statusAfter = current?.status;
      // W0 T0.3 — one stamp per tenant per tick, written only when this tick actually dispatched
      // something for it. "Is anything driving dr-lurie at all" then costs one read
      // (project.get -> driverHealth) instead of a scan of every run.
      if (report.steps > 0 && current) {
        await driverHealthRepository?.recordTenantDispatch({ projectId: current.projectId, lastBackgroundDispatchAt: clock().toISOString(), driver: "continuation_tick", runId: current.runId }).catch(() => undefined);
      }
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    if (deferredDeadline) break;
  }

  // W0 T0.2 — THE LEDGER, and the silence signal. Two facts the tick could not previously leave
  // behind: that it looked at a run at all, and that it has now failed to advance an advanceable run
  // three ticks running. Both are written AFTER the driving loop so a slow store can never delay a
  // dispatch, and every write is swallowed — a tick that drove ten nodes and could not write its own
  // ledger is a tick that drove ten nodes.
  const observedAt = clock().toISOString();
  const stepsByRun = new Map(driven.map((report) => [report.runId, report.steps]));
  const selectedRunIds = new Set(selected.map((verdict) => verdict.runId));
  let driverSilent = false;
  for (const verdict of [...reenter, ...skipped]) {
    // Terminal runs are not driven by anyone and never will be: stamping driver health on all 51 of
    // them every two minutes would be pure write amplification for no signal.
    if (!CONTINUABLE_RUN_STATUSES.includes(verdict.status)) continue;
    try {
      const stored = await deps.executionRepository.getRun(verdict.runId);
      if (!stored) continue;
      const advancedSteps = stepsByRun.get(verdict.runId) ?? 0;
      const applied = applyRunDriverHealth(stored, {
        at: observedAt,
        advancedSteps,
        // Only a run this tick SELECTED and then advanced zero steps counts toward silence — a
        // backlog beyond maxRuns, a live dispatch, or an operator veto is the tick working.
        selected: selectedRunIds.has(verdict.runId) && verdict.reenter,
        ...(advancedSteps === 0 ? { refusal: { code: driven.find((report) => report.runId === verdict.runId)?.code ?? verdict.code, reason: driven.find((report) => report.runId === verdict.runId)?.skippedReason ?? driven.find((report) => report.runId === verdict.runId)?.deferredReason ?? verdict.reason } } : {})
      });
      if (applied.silent) driverSilent = true;
      if (applied.changed) await deps.executionRepository.saveRun(applied.run);
    } catch {
      // A CAS conflict here means another driver wrote the run while we were stamping health on it —
      // which is the opposite of the condition this detects. Next tick re-observes it.
    }
  }

  const ledger: TickLedgerEntry = {
    tickId,
    startedAt: tickStartedAt.toISOString(),
    finishedAt: observedAt,
    scanned: runs.length,
    driven: driven.filter((report) => report.steps > 0).map((report) => ({ runId: report.runId, code: report.code, steps: report.steps, ...(report.statusAfter ? { statusAfter: report.statusAfter } : {}) })),
    refusals: [
      ...skipped.map((verdict): TickLedgerRefusal => ({ runId: verdict.runId, reason: verdict.code })),
      ...driven.filter((report) => report.steps === 0).map((report): TickLedgerRefusal => ({ runId: report.runId, reason: report.skippedReason ?? report.deferredReason ?? report.error ?? report.code }))
    ],
    ...(driverSilent ? { driverSilent: true } : {})
  };
  await driverHealthRepository?.recordTick(ledger).catch(() => undefined);
  await driverHealthRepository?.pruneTicks(new Date(tickStartedAt.getTime() - TICK_LEDGER_RETENTION_MS).toISOString()).catch(() => undefined);
  if (driverSilent) {
    // ERROR severity because this is the line an alert should fire on: the tick is running and the
    // runs are not moving, which is exactly the state that was invisible for 44 minutes.
    console.error(JSON.stringify({ event: "workflow.continuation_tick_driver_silent", severity: "ERROR", tickId, scanned: runs.length, silentRunIds: [...selectedRunIds].filter((runId) => (stepsByRun.get(runId) ?? 0) === 0) }));
  }

  return { enabled: true, scanned: runs.length, verdicts: [...reenter, ...skipped], driven, timedOut, tickId, ...(driverSilent ? { driverSilent: true } : {}), ...(deferredDeadline ? { deferredDeadline: true } : {}) };
}
