// W1 T1.1 (2026-09-04) — ORCHESTRATOR-LEVEL RETRY, the 89% bucket.
//
// Measured over the last 25 publishing_conductor runs (dr-lurie): 3,534 minutes — 89% of all active
// wall clock — were runs sitting in status "failed" waiting for a human to call
// workflow.retry_node. Model and tool time across the same window was 119 minutes. The runs that no
// human touched finished in 9-12 minutes; the median run took 61. Nothing about the failures needed
// a human: 11 retries, and the operator's entire contribution was pressing the button again.
//
// So a transient runner failure now schedules its own next attempt instead of parking the run:
//   - only the four codes below, which describe a call that went wrong rather than a decision;
//   - at most MAX_ORCHESTRATOR_RETRIES per node (3 attempts total), then "failed" exactly as today;
//   - exponential backoff, so a provider having a bad minute is not hammered;
//   - the superseded attempt is preserved by nodeAttemptHistory (W0 T0.1) — an auto-retry that hid
//     its own failures would rebuild the blindness the previous wave just fixed.
//
// WHAT IS NEVER AUTO-RETRIED, and why it is not a policy knob:
//   - `budget_exceeded` — the run hit a ceiling an operator set. Retrying spends past it, which is
//     the one thing the ceiling exists to prevent.
//   - `approval_required` — a gate held the node deliberately. Retrying is the driver overruling an
//     operator, which no unattended path may ever do.
//   - `cancelled` — someone stopped it.
// Anything not named retryable stays a terminal failure, so a new runner error code is non-retryable
// until a human decides otherwise.
//
// WHY A MARKER, NOT A "retry_pending" NODE STATUS. The plan called for a new status literal. A node
// status is read by the GUI, the node schemas, the constellation feed and every switch over
// executionStatuses; introducing a sixth node status to express "queued, but not before 14:32"
// would ripple through all of them for a fact that is really a scheduling detail of a queued node.
// The node therefore stays "queued" — which is exactly what it is — and carries `retry` with the
// attempt count and the earliest next dispatch. findNextRunnableNode is the only scheduler, and it
// is the only place that has to know.
import type { NodeExecutionState, WorkflowExecutionRecord } from "./executionTypes.js";
import { appendNodeAttempt } from "./nodeAttemptHistory.js";

// A call that went wrong. Every other code describes a decision (a gate, a ceiling, a cancellation)
// or a defect a retry cannot fix (a schema the node cannot satisfy is not transient).
export const RETRYABLE_RUNNER_ERROR_CODES: ReadonlySet<string> = new Set([
  "model_error",
  "timeout",
  "model_timeout",
  "tool_failed",
  "output_validation_failed"
]);

// Never, in any mode, for any caller. Listed explicitly rather than left to fall through the set
// above so the intent survives a future edit of that set.
export const NEVER_AUTO_RETRIED_CODES: ReadonlySet<string> = new Set(["budget_exceeded", "approval_required", "cancelled"]);

// Three attempts total. Past that the failure is not transient and a human should look at it — the
// point of this wave is to stop parking runs on humans for the ROUTINE case, not to retry forever.
export const MAX_ORCHESTRATOR_RETRIES = 2;

// 60s, then 120s. Long enough for a provider blip or a rate limit to clear, short enough that the
// worst case (two backoffs) costs three minutes against the hours this replaces.
export const retryBackoffMs = (attempt: number): number => 60_000 * 2 ** Math.max(0, attempt - 1);

export type NodeRetryDecision =
  | { retry: true; attempt: number; notBefore: string }
  | { retry: false; reason: "not_retryable" | "attempts_exhausted" };

export const decideNodeRetry = (state: Pick<NodeExecutionState, "retry">, code: string, at: Date): NodeRetryDecision => {
  if (NEVER_AUTO_RETRIED_CODES.has(code) || !RETRYABLE_RUNNER_ERROR_CODES.has(code)) return { retry: false, reason: "not_retryable" };
  const attempt = (state.retry?.attempt ?? 0) + 1;
  if (attempt > MAX_ORCHESTRATOR_RETRIES) return { retry: false, reason: "attempts_exhausted" };
  return { retry: true, attempt, notBefore: new Date(at.getTime() + retryBackoffMs(attempt)).toISOString() };
};

// Put the node back in the queue with its next-attempt time, preserving the attempt that just
// failed. Mirrors retryNode's reset exactly (nodeAttemptHistory first, then clear) so an
// orchestrator retry and an operator retry can never leave two different shapes of node behind.
export const scheduleNodeRetry = (
  run: WorkflowExecutionRecord,
  state: NodeExecutionState,
  decision: Extract<NodeRetryDecision, { retry: true }>,
  failure: { code: string; message?: string },
  at: string
): void => {
  appendNodeAttempt(state, at);
  state.status = "queued";
  delete state.output;
  delete state.errors;
  delete state.completedAt;
  delete state.durationMs;
  delete state.startedAt;
  delete state.dispatch;
  state.retry = { attempt: decision.attempt, notBefore: decision.notBefore, code: failure.code, ...(failure.message ? { message: failure.message } : {}), scheduledAt: at };
  delete run.stageOutputs[state.nodeId];
  run.artifacts = run.artifacts.filter((artifact) => artifact.nodeId !== state.nodeId);
};

// A queued node that is waiting out its backoff. The scheduler skips it; nothing else changes.
export const isAwaitingRetryBackoff = (state: Pick<NodeExecutionState, "status" | "retry">, at: Date): boolean =>
  state.status === "queued" && !!state.retry && Date.parse(state.retry.notBefore) > at.getTime();

export const nextRetryAt = (run: WorkflowExecutionRecord, at: Date): string | undefined =>
  run.nodes
    .filter((node) => isAwaitingRetryBackoff(node, at))
    .map((node) => node.retry!.notBefore)
    .sort()[0];
