// W0 T0.2/T0.3 (2026-09-04) — THE TICK'S OWN LEDGER, and the per-tenant "when did a background
// driver last dispatch anything" stamp.
//
// THE INCIDENT THIS CLOSES. On 2026-09-04 a dr-lurie run sat "running" with nothing in flight from
// 14:06 to 14:50, then ran ten nodes in nine minutes. Nothing in the system could say the driver had
// stopped looking at it: the tick writes ONE stdout line and exits 0 whatever happens
// (runContinuationTickJob.ts), nothing about a tick reaches the store, and assessRunStall reasons
// only about a node's own claim or `updatedAt + 90s` — none of which can express "no driver has
// looked at this run for 44 minutes". Scheduler saw a green job every two minutes throughout.
//
// So this module adds the two records that make driver silence a fact rather than an inference:
//   1. a TICK LEDGER entry per execution (what was scanned, what was driven, every refusal), and
//      `run.driverHealth` on each scanned run — a CAS-safe write that never changes run status;
//   2. a per-tenant `lastBackgroundDispatchAt`, so "is anything driving dr-lurie at all" is one read
//      rather than a scan of every run.
// When a run is selected for re-entry and advanced ZERO steps for SILENT_TICK_THRESHOLD consecutive
// ticks, the run gets a `driver_silent_since:<ts>` warning and the tick exits non-zero, which is what
// finally makes the Cloud Run job's failure visible to Scheduler and alerting.
import type { RunDriver, RunDriverHealth, WorkflowExecutionRecord } from "./executionTypes.js";

// Three consecutive silent ticks at the deployed 2-minute cadence ≈ 6 minutes — under the 15-minute
// hole the external caller's own cadence would have produced anyway, and far under the 44-minute one.
// Deliberately not 1: a single tick that declines to advance a run is normal (a backlog beyond
// maxRuns, a deadline deferral, a competing driver holding the run).
export const SILENT_TICK_THRESHOLD = 3;

// 48 hours of ledger, pruned oldest-first by the tick that notices. Long enough to reconstruct an
// incident the morning after, short enough that the prefix listing stays cheap.
export const TICK_LEDGER_RETENTION_MS = 48 * 60 * 60 * 1000;

export const driverSilentWarning = (since: string): string => `driver_silent_since:${since}`;
export const isDriverSilentWarning = (warning: string): boolean => warning.startsWith("driver_silent_since:");

export type TickLedgerDrivenEntry = { runId: string; code: string; steps: number; statusAfter?: string };
export type TickLedgerRefusal = { runId: string; reason: string };

// One record per tick execution. `driven` carries only runs that actually advanced a step, which is
// the distinction the incident turned on: the old stdout line reported a run as "driven" with
// steps: 0 when the tick had in fact done nothing to it.
export type TickLedgerEntry = {
  tickId: string;
  startedAt: string;
  finishedAt?: string;
  scanned: number;
  driven: TickLedgerDrivenEntry[];
  refusals: TickLedgerRefusal[];
  // Set when this tick concluded that at least one run has been silent for SILENT_TICK_THRESHOLD
  // consecutive ticks. The Cloud Run job exits 1 on exactly this.
  driverSilent?: boolean;
};

// The per-tenant stamp. One document per project, overwritten on every successful background
// dispatch — the question it answers ("is anything driving this tenant?") only ever needs the latest.
export type TenantDriverHealth = {
  projectId: string;
  lastBackgroundDispatchAt: string;
  driver: RunDriver;
  runId: string;
};

export const makeTickId = (at: Date = new Date()): string => `tick_${at.getTime()}_${Math.random().toString(36).slice(2, 8)}`;

// Pure: the run's driverHealth after a tick observed it. `advancedSteps > 0` clears every silence
// signal — the driver is demonstrably alive — and a refusal that is not the tick's own decision to
// defer is recorded so `list_runs` can show WHY the last driver walked away.
export const nextRunDriverHealth = (
  current: RunDriverHealth | undefined,
  observation: { at: string; advancedSteps: number; selected: boolean; refusal?: { code: string; reason?: string } }
): RunDriverHealth => {
  const base: RunDriverHealth = { ...(current ?? {}), lastSeenByTickAt: observation.at };
  if (observation.advancedSteps > 0) {
    delete base.silentTicks;
    delete base.silentSince;
    delete base.lastRefusal;
    return { ...base, lastDrivenAt: observation.at };
  }
  if (observation.refusal) base.lastRefusal = { ...observation.refusal, at: observation.at };
  // Only a run the tick SELECTED and then failed to advance counts toward silence. A run refused
  // because something is genuinely in flight, because the operator vetoed it, or because it is
  // terminal is not a silent driver — it is the tick working correctly.
  if (!observation.selected) {
    delete base.silentTicks;
    delete base.silentSince;
    return base;
  }
  const silentTicks = (current?.silentTicks ?? 0) + 1;
  return { ...base, silentTicks, silentSince: current?.silentSince ?? observation.at };
};

export const isRunDriverSilent = (health: RunDriverHealth | undefined): boolean => (health?.silentTicks ?? 0) >= SILENT_TICK_THRESHOLD;

// Apply the observation to the record itself: driverHealth plus, at the threshold, the run-level
// warning. Deduplicated by value like every other run warning (driverEnvPreflight's), and removed
// again the moment a tick advances the run, so the warning always describes the CURRENT silence.
export const applyRunDriverHealth = (
  run: WorkflowExecutionRecord,
  observation: { at: string; advancedSteps: number; selected: boolean; refusal?: { code: string; reason?: string } }
): { run: WorkflowExecutionRecord; changed: boolean; silent: boolean } => {
  const driverHealth = nextRunDriverHealth(run.driverHealth, observation);
  const silent = isRunDriverSilent(driverHealth);
  const warnings = (run.warnings ?? []).filter((warning) => !isDriverSilentWarning(warning));
  const nextWarnings = silent ? [...warnings, driverSilentWarning(driverHealth.silentSince ?? observation.at)] : warnings;
  const next: WorkflowExecutionRecord = {
    ...run,
    driverHealth,
    ...(nextWarnings.length ? { warnings: nextWarnings } : run.warnings ? { warnings: [] } : {})
  };
  const changed = JSON.stringify(run.driverHealth) !== JSON.stringify(driverHealth) || JSON.stringify(run.warnings ?? []) !== JSON.stringify(next.warnings ?? []);
  return { run: next, changed, silent };
};
