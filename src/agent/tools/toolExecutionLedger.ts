// W3.2.1 — the ledger's WRITE side, shared by the controlled-tool executor and the tenant choke
// point so both produce the same record in the same store through the same failure policy.
//
// THE FAILURE POLICY IS THE POINT. `recordToolExecution` never throws and never rejects. An audit
// write is not part of the operation it describes: a publish that succeeded and a ledger write that
// failed is one bad outcome, not two, and turning the second into an exception would let a
// transient store error abort a tenant call that had already landed. The failure is reported to the
// process log (once, without payloads) and the caller proceeds.
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

export async function recordToolExecution(record: ToolExecutionRecord): Promise<void> {
  try {
    await repositoryManager.getToolExecutionRepository().record(record);
  } catch (error) {
    // Named, not swallowed silently, and carrying no payload: the record's own summaries are already
    // redacted but there is no reason to re-emit them on a failure path.
    console.warn(`tool_execution_ledger_write_failed toolExecutionId=${record.toolExecutionId} toolId=${record.toolId} reason=${error instanceof Error ? error.name : typeof error}`);
  }
}
