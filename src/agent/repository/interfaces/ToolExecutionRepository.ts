import type { RepositoryHealth } from "../RepositoryHealth.js";
import type { ToolExecutionFilters, ToolExecutionRecord } from "../../tools/toolTypes.js";

// W3.2.1 — THE DURABLE TOOL EXECUTION LEDGER.
//
// Until this existed, `records` in toolExecutor.ts was a module-level Map: every audit record died
// with the process that made it, which is why `tool.get_execution` and `tool.list_executions` answered
// [] for every past conductor run and had to be given a fallback that reads per-call STUBS off the run
// record. The stubs carry toolId/status/durationMs and nothing else — no caller, no routeId, no
// project — and they only exist for calls a model runner made. An engine-invoked tenant verb left no
// trace anywhere at all.
//
// SHAPE, AND WHY IT IS INDEXED THE WAY IT IS. This programme has hit the same defect three times
// (W0.3, W1.4, W2.1): a repository read that looks scoped but lists a whole prefix and downloads
// every object under it. `tool.list_executions` filters by run and by node, so BOTH are prefixes here
// and neither is a post-read filter. The record is small and immutable — written exactly once, never
// updated — so the by-node copy is the record itself rather than a pointer that would need a join:
// two small writes at call time buy an O(matching) read on either axis.
//
// The unindexed case is named rather than hidden: a list with NEITHER runId nor nodeId (a bare toolId
// filter, or no filter at all) does walk the whole by-run prefix. That is the same shape
// tool.list_executions' existing run-record fallback already has (it lists every run), it is an
// operator query and not a hot path, and it is bounded by `limit`.
export interface ToolExecutionRepository {
  record(record: ToolExecutionRecord): Promise<ToolExecutionRecord>;
  // `runId` is a HINT, not a filter: with it the lookup is one key read; without it the caller is
  // asking for an unbounded by-id scan, which this repository deliberately does not perform — it
  // returns undefined and lets the caller fall back to the run-record stubs, which is exactly what
  // tool.get_execution already did before a durable ledger existed.
  get(toolExecutionId: string, runId?: string): Promise<ToolExecutionRecord | undefined>;
  list(filters?: ToolExecutionFilters): Promise<ToolExecutionRecord[]>;
  clear(): void;
  health(): Promise<RepositoryHealth>;
}
