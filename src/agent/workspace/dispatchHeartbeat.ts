// D3 (2026-09-14) — THE DISPATCH HEARTBEAT, and why it does not live on the run record.
//
// Before this, "is this dispatch alive?" had exactly one answer: the claim's own
// `dispatchedAt + timeoutMs + STALL_MARGIN_MS`. That is a bound on how long the node may take, not
// a signal about the driver — so a driver that vanished one second after dispatching held the node
// hostage for the node's WHOLE window plus 90s: 180s for a 90s model node, 390s for a capture stage.
// In run_1789303857536_obd2fd that was five to eight minutes of dead air per incident, for nodes
// that complete in 18-25 seconds.
//
// A heartbeat fixes the sense of scale: a live driver says "still here" every
// DISPATCH_HEARTBEAT_INTERVAL_MS, and a claim whose heartbeat has been silent for twice that is
// reclaimable no matter how wide its own window is. Two heartbeat intervals is the whole latency,
// so a dead dispatch is reclaimed inside ~30-45s instead of 180-390s.
//
// THE HEARTBEAT IS NOT WRITTEN TO THE RUN RECORD, and that is the entire design constraint. Every
// run-record save is a compare-and-swap; a 15-second write to the record a driver is mid-node on is
// precisely the foreign write that D1 (nodeAdvanceSave.ts) exists to survive. A heartbeat written
// there would have manufactured the failure it was added to detect, every fifteen seconds. So it
// goes in the driver-health store — a separate, last-write-wins key space that conflicts with
// nothing — and it is read, never required: an unreachable store costs a reclaim its EARLY signal
// and leaves the pre-existing timeout rule exactly as it was.
import type { DriverHealthRepository } from "../repository/interfaces/DriverHealthRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { RunDriver } from "./executionTypes.js";

export const DISPATCH_HEARTBEAT_INTERVAL_MS = 15_000;
// Two missed beats. One is a slow store write or a GC pause; two is a process that is not there.
export const DISPATCH_HEARTBEAT_GRACE_MS = 2 * DISPATCH_HEARTBEAT_INTERVAL_MS;

// One document per RUN, overwritten in place. `dispatchedAt` ties it to the exact claim it describes:
// a heartbeat left behind by an earlier dispatch can never be read as evidence about a later one,
// which is what keeps a driver that does not heartbeat at all (an older build, mid-rollout) from
// having its live dispatches reclaimed early.
export type DispatchHeartbeat = {
  runId: string;
  nodeIds: string[];
  dispatchedAt: string;
  driver: RunDriver;
  heartbeatAt: string;
};

// PURE. The reclaim rule's new half: this heartbeat describes THIS claim and has gone quiet.
// Returns false for a missing heartbeat, a heartbeat about a different dispatch, or a fresh one —
// every case where the only honest answer is "no early evidence", leaving the timeout rule to decide.
export const isDispatchHeartbeatSilent = (
  heartbeat: DispatchHeartbeat | undefined,
  claimDispatchedAt: string | undefined,
  at: Date = new Date(),
  graceMs: number = DISPATCH_HEARTBEAT_GRACE_MS
): boolean => {
  if (!heartbeat || !claimDispatchedAt) return false;
  if (heartbeat.dispatchedAt !== claimDispatchedAt) return false;
  const last = Date.parse(heartbeat.heartbeatAt);
  if (!Number.isFinite(last)) return false;
  return at.getTime() - last > graceMs;
};

// ── the runtime half ────────────────────────────────────────────────────────────────────────────
// Started by stampDispatch (the single place a claim is written) and stopped by advanceRun's finally
// (the single place a dispatch ends). Every write is best-effort and unawaited by the dispatch path:
// a heartbeat that cannot be written must never delay, fail or alter a node execution.
type ActiveHeartbeat = { beat: DispatchHeartbeat; timer: ReturnType<typeof setInterval> };
const active = new Map<string, ActiveHeartbeat>();

let repositoryFor: (() => DriverHealthRepository | undefined) | undefined;
// Injected once at runtime wiring (and by tests). Kept as a getter rather than an instance so this
// module never forces a store to be constructed in a process that has none.
export const setDispatchHeartbeatRepository = (resolve: (() => DriverHealthRepository | undefined) | undefined): void => {
  repositoryFor = resolve;
};
export const resolveDispatchHeartbeatRepository = (): DriverHealthRepository | undefined => {
  // The default is the process's own driver-health store; the injectable seam above exists for tests
  // and for a process that deliberately has none. Resolved lazily and defensively for the same reason
  // runContinuation resolves its ledger that way: a store this process cannot reach must cost the
  // dispatch its HEARTBEAT, never its ability to run the node.
  try { return repositoryFor ? repositoryFor() : repositoryManager.getDriverHealthRepository(); }
  catch { return undefined; }
};

const write = (beat: DispatchHeartbeat): void => {
  const repository = resolveDispatchHeartbeatRepository();
  if (!repository) return;
  void Promise.resolve(repository.recordDispatchHeartbeat(beat)).catch(() => undefined);
};

export const beginDispatchHeartbeat = (runId: string, nodeId: string, dispatchedAt: string, driver: RunDriver): void => {
  const existing = active.get(runId);
  // A concurrent batch stamps every sibling under ONE dispatchedAt: extend the same heartbeat rather
  // than starting four timers that overwrite each other's node lists.
  if (existing && existing.beat.dispatchedAt === dispatchedAt) {
    if (!existing.beat.nodeIds.includes(nodeId)) existing.beat.nodeIds.push(nodeId);
    existing.beat.heartbeatAt = new Date().toISOString();
    write(existing.beat);
    return;
  }
  if (existing) { clearInterval(existing.timer); active.delete(runId); }
  const beat: DispatchHeartbeat = { runId, nodeIds: [nodeId], dispatchedAt, driver, heartbeatAt: new Date().toISOString() };
  const timer = setInterval(() => {
    beat.heartbeatAt = new Date().toISOString();
    write(beat);
  }, DISPATCH_HEARTBEAT_INTERVAL_MS);
  // Never hold a serverless process (or a test runner) open for a node that has already finished.
  timer.unref?.();
  active.set(runId, { beat, timer });
  write(beat);
};

export const endDispatchHeartbeat = (runId: string): void => {
  const existing = active.get(runId);
  if (!existing) return;
  clearInterval(existing.timer);
  active.delete(runId);
  const repository = resolveDispatchHeartbeatRepository();
  if (!repository) return;
  // Clearing is what makes a COMPLETED dispatch leave no evidence behind for the next one to trip
  // over; a failure to clear is harmless, because the dispatchedAt match already scopes the record.
  void Promise.resolve(repository.clearDispatchHeartbeat(runId)).catch(() => undefined);
};

// Test seam only: drop every in-process timer without touching a store.
export const resetDispatchHeartbeats = (): void => {
  for (const { timer } of active.values()) clearInterval(timer);
  active.clear();
};
