// W3.2.1 — the ledger's WRITE side, shared by the controlled-tool executor and the tenant choke
// point so both produce the same record in the same store through the same failure policy.
//
// THE FAILURE POLICY IS THE POINT. `recordToolExecution` never throws and never rejects. An audit
// write is not part of the operation it describes: a publish that succeeded and a ledger write that
// failed is one bad outcome, not two, and turning the second into an exception would let a
// transient store error abort a tenant call that had already landed. The failure is reported to the
// process log (once, without payloads) and the caller proceeds.
//
// AND IT IS NOT ON THE CALLER'S CLOCK. The write is started and NOT awaited. The record describes a
// tenant call that has already happened, so making the caller wait for the audit adds latency to
// every tenant call and buys nothing: capture's emit_live makes ~58 tenant calls on a real site and
// was paying two sequential blob round trips for each of them, ~116 writes serialised into a stage
// that is already the longest on its route.
//
// Two properties keep that honest rather than merely fast:
//   - READ-YOUR-WRITES. `flushToolExecutionLedger()` awaits every write still in flight, and every
//     READER calls it first. A ledger that answered "no records" for a call it had just been handed
//     would be worse than a slow one.
//   - NO QUEUE. The write starts immediately; only the WAIT is skipped. There is no buffer holding
//     records back, so a process killed mid-dispatch loses at most the writes actually in flight —
//     not a whole dispatch's worth. (Before this ledger existed the equivalent loss was 100%: the
//     records lived in a module-level Map that died with the process.)
import type { ToolExecutionRecord } from "./toolTypes.js";
import { repositoryManager } from "../runtime/repositories.js";

// Bounded, secret-free rendering of anything that goes into a record. Lifted verbatim out of
// toolExecutor.ts (which now imports it from here) so a tenant call and a controlled call redact
// identically — one implementation, not two that drift.
export const redactForLedger = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]").slice(0, 500);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(redactForLedger);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([k, v]) => [k, /authorization|token|secret|api[_-]?key|password/i.test(k) ? "[REDACTED]" : redactForLedger(v)]));
};

export const summarizeForLedger = (value: unknown): unknown => redactForLedger(value);

// Writes started and not yet settled. Bounded by concurrency, not by time: an entry leaves the moment
// its write finishes, so this never grows into a queue.
const inFlight = new Set<Promise<void>>();

export function recordToolExecution(record: ToolExecutionRecord): void {
  const write = (async () => {
    try {
      await repositoryManager.getToolExecutionRepository().record(record);
    } catch (error) {
      // Named, not swallowed silently, and carrying no payload: the record's own summaries are already
      // redacted but there is no reason to re-emit them on a failure path.
      console.warn(`tool_execution_ledger_write_failed toolExecutionId=${record.toolExecutionId} toolId=${record.toolId} reason=${error instanceof Error ? error.name : typeof error}`);
    }
  })();
  inFlight.add(write);
  void write.finally(() => inFlight.delete(write));
}

/**
 * Await every ledger write still in flight. Called by every reader before it answers, and worth
 * calling from a process shutdown path. Loops because a write can be started while an earlier one is
 * being awaited — one pass would leave the newest write unflushed, which is exactly the record a
 * reader asking right now is most likely to want.
 */
export async function flushToolExecutionLedger(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
