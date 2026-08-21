// Framework-free model for the tenant scoped-bearer repair panel (Settings surface). Pure
// data → data, root-testable — mirrors the split used by changes.ts / toolPermissions.ts so the
// component itself stays presentational.

import type { SiteCredentialExecutionStatus, SiteCredentialPlan, SiteCredentialPlanEntry } from "./types/workspace.js";

// site_credentials_execution_status reports whatever state string the underlying Cloud Run Job
// execution has (e.g. "ACTIVE" / "SUCCEEDED" / "FAILED" / "CANCELLED"); only a recognized
// terminal state stops polling. An unrecognized value is treated as still in flight rather than
// silently declared "done" — apply genuinely rebuilds tenant sites for 10-20 minutes, and a wrong
// guess here would either freeze the UI mid-repair or spuriously claim it already finished.
const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "completed",
  "done",
  "error",
  "terminated",
  "deadline_exceeded"
]);

export function isTerminalExecutionState(state: string): boolean {
  return TERMINAL_STATES.has(state.trim().toLowerCase());
}

export type FleetSummary = { tone: "success" | "warning"; message: string };

// The headline the operator reads before deciding whether to fire anything: either the fleet is
// fully caught up, or an exact count of how many tenants are stale.
export function summarizeFleet(plan: SiteCredentialPlan | null): FleetSummary | null {
  if (!plan) return null;
  if (plan.staleCount === 0) return { tone: "success", message: "All tenants current — no scoped-bearer repair needed." };
  const noun = plan.staleCount === 1 ? "tenant needs" : "tenants need";
  return { tone: "warning", message: `${plan.staleCount} ${noun} repair.` };
}

export type ApplyGate = { allowed: boolean; reason?: string };

// Firing apply with nothing stale wastes a full fleet rebuild for zero effect — gate it, and say
// why in the same place the button lives so the disabled state is never a silent dead end.
export function applyGate(plan: SiteCredentialPlan | null): ApplyGate {
  if (!plan) return { allowed: false, reason: "Load the plan before repairing." };
  if (plan.staleCount === 0) return { allowed: false, reason: "Nothing to repair — every tenant already has the current scoped bearer." };
  return { allowed: true };
}

export type ExecutionView = {
  tone: "info" | "success" | "warning" | "error";
  headline: string;
  detail?: string;
};

const SUCCESS_LIKE_STATES = new Set(["succeeded", "completed", "done"]);

// Turns the raw execution-status envelope into what the panel renders. A partial failure is
// surfaced as an error (never folded into "success" just because the job as a whole reached a
// terminal state), and always points the operator at Cloud Run for the log — this UI does not
// stream job logs.
export function describeExecutionStatus(status: SiteCredentialExecutionStatus, jobName?: string): ExecutionView {
  const terminal = isTerminalExecutionState(status.state);
  const succeeded = status.succeededCount ?? 0;
  const failed = status.failedCount ?? 0;
  const jobRef = jobName ? ` (job ${jobName})` : "";

  if (!terminal) {
    return { tone: "info", headline: `Repair in progress — ${status.state}.`, detail: "This rebuilds every stale tenant and can take 10-20 minutes." };
  }
  if (failed === 0 && succeeded === 0 && !SUCCESS_LIKE_STATES.has(status.state.trim().toLowerCase())) {
    // Terminal without ever reporting per-tenant counts — most likely failed, cancelled, or
    // errored before any repair work happened.
    return { tone: "error", headline: "Repair did not complete.", detail: `The job execution reported "${status.state}" before repairing any tenant. Check the execution log in Cloud Run${jobRef}.` };
  }
  if (failed > 0) {
    return {
      tone: "error",
      headline: `Repair finished with ${failed} failure${failed === 1 ? "" : "s"}.`,
      detail: `${succeeded} tenant${succeeded === 1 ? "" : "s"} repaired, ${failed} failed. The failure detail is in the execution log in Cloud Run${jobRef} — this panel only reports counts.`
    };
  }
  return { tone: "success", headline: `Repair complete — ${succeeded} tenant${succeeded === 1 ? "" : "s"} repaired.` };
}

export function tenantStatusLabel(status: SiteCredentialPlanEntry["status"]): string {
  return status === "current" ? "Current" : "Needs repair";
}
