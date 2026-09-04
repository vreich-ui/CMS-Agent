// W0 T0.1 (2026-09-04) — ATTEMPT HISTORY, because a retry used to erase its own evidence.
//
// Measured on the last 25 publishing_conductor runs (dr-lurie): 11 human `workflow.retry_node` calls
// across 7 runs, and exactly ONE of the 11 pre-retry failure reasons could still be read afterwards.
// retryNode clears the node's own state (`errors`, `output`, timing) so the next attempt starts
// clean, and a later completion filters that node's entries out of `run.errors` (executor.ts, the
// T-2 defect note) so triage reflects current status. Together those two individually correct
// behaviours meant a node that failed, was retried and then succeeded left NO record that it had
// ever failed — which is why "why did these runs fail" was unanswerable for 10 of 11 retries, and
// why the whole W0 wave exists.
//
// The fix is additive and costs one array per retried node:
//   - the superseded attempt is appended to `node.errorHistory[]` BEFORE the reset clears it;
//   - the run-level `<nodeId>:<code>` entries are MARKED `:retried@<ts>` instead of being left for
//     the completion filter to drop, so the run still says what happened to it.
// Nothing here decides anything: retry POLICY is W1's job. This module only remembers.
import type { NodeAttemptRecord, NodeExecutionState } from "./executionTypes.js";

// Bounded like every other per-node list on the record (see boundList in executor.ts): a run that
// retried one node twenty times is a different problem, and an unbounded history would carry the
// whole stack of them into every list_runs page.
export const MAX_NODE_ATTEMPT_HISTORY = 10;

// The marker that makes a resolved failure survive its own resolution. Chosen to keep the existing
// `<nodeId>:<code>` prefix intact, so every reader that matches by node id still matches.
export const NODE_ERROR_RETRIED_MARKER = ":retried@";

export const isRetriedRunError = (entry: string): boolean => entry.includes(NODE_ERROR_RETRIED_MARKER);

// The attempt number a node's NEXT execution will be: 1 for a node that has never been superseded.
export const nextAttemptNumber = (state: Pick<NodeExecutionState, "errorHistory">): number => (state.errorHistory?.length ?? 0) + 1;

// A superseded attempt worth remembering: one that actually ran (it was dispatched, or it started, or
// it recorded an error). A queued node that was never dispatched has nothing to remember, and
// recording an empty attempt for it would make `errorHistory.length` mean "times the control was
// pressed" instead of "attempts that happened".
export const buildNodeAttemptRecord = (state: NodeExecutionState, recordedAt: string): NodeAttemptRecord | undefined => {
  if (!state.errors?.length && !state.startedAt && !state.lastDispatch && !state.dispatch) return undefined;
  const dispatch = state.dispatch ?? state.lastDispatch;
  return {
    attempt: nextAttemptNumber(state),
    status: state.status,
    recordedAt,
    ...(state.errors?.[0] ? { code: state.errors[0] } : {}),
    ...(state.errors?.[1] ? { message: state.errors[1] } : {}),
    ...(dispatch?.dispatchedAt ? { dispatchedAt: dispatch.dispatchedAt } : {}),
    ...(dispatch?.driver ? { driver: dispatch.driver } : {}),
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {})
  };
};

// Append the attempt the caller is about to erase. Mutates the state in place, at exactly the point
// the reset that erases it happens, so the two can never drift apart.
export const appendNodeAttempt = (state: NodeExecutionState, recordedAt: string): void => {
  const record = buildNodeAttemptRecord(state, recordedAt);
  if (!record) return;
  state.errorHistory = [...(state.errorHistory ?? []), record].slice(-MAX_NODE_ATTEMPT_HISTORY);
};

// Mark this node's run-level failure entries as retried rather than deleting them. An already-marked
// entry is left alone, so a node retried twice carries one marker per entry, never a nested one.
export const markRunErrorsRetried = (errors: readonly string[], nodeId: string, at: string): string[] =>
  errors.map((entry) => (entry.startsWith(`${nodeId}:`) && !isRetriedRunError(entry) ? `${entry}${NODE_ERROR_RETRIED_MARKER}${at}` : entry));

// The completion filter, with the one exception T0.1 adds: an entry marked retried is HISTORY and
// stays. Everything else is unchanged — a node's LIVE failure entries are still superseded by its
// own success, which is the T-2 defect fix this replaces.
export const dropUnretriedNodeErrors = (errors: readonly string[], nodeId: string): string[] =>
  errors.filter((entry) => !entry.startsWith(`${nodeId}:`) || isRetriedRunError(entry));
