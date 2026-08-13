// Node timing ledger (T6, Wave 3 — SHIPS DARK). Every node completion the executor and the
// node.execute runtime already reach is recorded here as {nodeId, durationMs, costUsd, outcome} and
// folded into a per-nodeId aggregate (EMA, p50, p95, count). Nothing in this file is read by any
// decision path yet — workflow.get_run_cost's plan block (mcp/workspace/tools.ts) is the ONE
// read-only consumer this wave adds. No scheduling, budgeting or stall-detection behaviour changes as
// a result of this file existing.
//
// Evidence (run_1786557897658_elj34j, verified live 2026-08-12): 12.8 min wall, ~7.3 min model work, a
// serial review quartet taking ~113s, and a mid-loop budget estimator that false-stopped a node. Every
// one of those is a decision currently made from a static guess (a fixed per-node budget reservation,
// a serial review ordering nobody has re-measured) because no per-node history exists to decide it
// from measured reality instead. This file creates that history. It creates nothing else: no consumer
// here changes what any node does, when it runs, or when a run halts.
//
// FOLLOW-UPS — explicitly NOT this task, and explicitly gated on two runs of accumulated data before
// anyone wires them live (a single run's aggregate is one sample per node, indistinguishable from
// noise; two runs is the first point an EMA and a p95 mean anything at all):
//   1. Driver packing — using durationMs aggregates to pack independent nodes into a single
//      conductor-job wall-clock budget instead of dispatching one at a time.
//   2. Estimator calibration — replacing the mid-loop budget estimator's static per-node guess (the
//      false-stop this evidence names) with the measured p50/EMA for that nodeId.
//   3. Per-node stall thresholds at p95 * 2 — replacing runStallHeartbeat's one-size timeout with a
//      per-nodeId threshold derived from this ledger's own p95.
// None of the three may be switched on until this ledger holds two runs' worth of samples for the
// nodes they'd gate; switching early would let a cold, near-empty aggregate make exactly the kind of
// static-guess decision this task exists to replace.

import type { ExecutionStatus } from "./executionTypes.js";
import { repositoryManager } from "../runtime/repositories.js";
import { summarizeModelUsage } from "../observability/modelUsage.js";
import type { NodeTimingRepository } from "../repository/interfaces/NodeTimingRepository.js";

// A node itself is never "queued", "running" or "paused" once execution has REACHED a recordable
// outcome — those three are mid-flight run statuses, not node completion outcomes. Reusing
// ExecutionStatus (rather than inventing a parallel vocabulary) means this file's outcome and
// NodeExecutionState.status can never drift apart about what a terminal node state is called.
export type NodeTimingOutcome = Exclude<ExecutionStatus, "queued" | "running" | "paused">;

export type NodeTimingRecord = {
  timingId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  durationMs: number;
  costUsd: number;
  outcome: NodeTimingOutcome;
  recordedAt: string;
};

export type NodeTimingFilters = {
  runId?: string;
  workflowId?: string;
  nodeId?: string;
  from?: string;
  to?: string;
};

export type RecordNodeTimingInput = Omit<NodeTimingRecord, "timingId" | "recordedAt"> & Partial<Pick<NodeTimingRecord, "timingId" | "recordedAt">>;

const makeTimingId = () => `timing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Pure: stamps timingId/recordedAt only when the caller omits them, so a repository round-trip (or a
// test) can supply both deterministically. Mirrors recordModelUsage's own stamping contract
// (modelUsage.ts) — same shape of "optional in, always-present out".
export function buildNodeTimingRecord(input: RecordNodeTimingInput): NodeTimingRecord {
  return {
    ...input,
    timingId: input.timingId ?? makeTimingId(),
    recordedAt: input.recordedAt ?? new Date().toISOString()
  };
}

export const NODE_TIMING_EMA_ALPHA = 0.3;

// Standard exponential moving average: EMA_0 = first sample (no smoothing possible with nothing to
// smooth against); EMA_n = alpha*sample_n + (1-alpha)*EMA_{n-1}. Pure and order-sensitive — callers
// must fold samples in chronological (recordedAt-ascending) order, the same convention
// modelUsage.ts's summarizeModelUsage relies on for its own per-node buckets.
export function foldEma(previous: number | undefined, sample: number, alpha: number = NODE_TIMING_EMA_ALPHA): number {
  return previous === undefined ? sample : alpha * sample + (1 - alpha) * previous;
}

// Percentile definition: NEAREST-RANK (no interpolation). rank = ceil(p/100 * n), 1-based, clamped to
// [1, n]; the result is sortedAscending[rank - 1]. Chosen over a linear-interpolation method because
// it needs no interpolation, is cheap to recompute on every read, and — the reason it is stated here
// instead of assumed — its behaviour on the tiny sample counts an early node history actually has is
// well-defined without a special case:
//   n=1: rank = ceil(p/100) = 1 for every p in (0,100], so p50 AND p95 both return the single sample.
//   n=2, ascending [a, b]: p50 -> rank=ceil(0.5*2)=1 -> a (the smaller); p95 -> rank=ceil(0.95*2)=2 ->
//     b (the larger). A linear-interpolation definition would instead blend a and b at p50 — the case
//     this comment exists to rule out. See the n=1/n=2 tests in nodeTimings.test.ts.
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.min(sortedAscending.length, Math.max(1, Math.ceil((p / 100) * sortedAscending.length)));
  return sortedAscending[rank - 1];
}

export type NodeTimingAggregate = {
  nodeId: string;
  count: number;
  emaDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
};

// Pure aggregator — the ONLY place EMA/p50/p95 arithmetic happens, so it is testable against known
// samples independent of any repository or MCP wiring. Records are grouped by nodeId, sorted by
// recordedAt (EMA is order-sensitive; percentile is not, so it gets its own separate value-sort),
// then folded. Takes every record passed in — callers window/filter (e.g. by workflowId, by runId)
// before calling this, exactly as summarizeModelUsage's callers filter before summarizing.
export function aggregateNodeTimingsByNode(records: readonly NodeTimingRecord[]): Record<string, NodeTimingAggregate> {
  const byNode = new Map<string, NodeTimingRecord[]>();
  for (const record of records) {
    const list = byNode.get(record.nodeId);
    if (list) list.push(record); else byNode.set(record.nodeId, [record]);
  }
  const result: Record<string, NodeTimingAggregate> = {};
  for (const [nodeId, nodeRecords] of byNode) {
    const chronological = [...nodeRecords].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    let ema: number | undefined;
    for (const record of chronological) ema = foldEma(ema, record.durationMs);
    const sortedDurations = chronological.map((record) => record.durationMs).sort((a, b) => a - b);
    result[nodeId] = {
      nodeId,
      count: chronological.length,
      emaDurationMs: Math.round(ema ?? 0),
      p50DurationMs: percentile(sortedDurations, 50),
      p95DurationMs: percentile(sortedDurations, 95)
    };
  }
  return result;
}

export type RecordNodeTimingCompletionInput = {
  runId: string;
  workflowId: string;
  nodeId: string;
  durationMs: number;
  outcome: NodeTimingOutcome;
};

// Impure convenience wrapper — the ONE place a node completion becomes a persisted NodeTimingRecord.
// costUsd is read back from the usage ledger this SAME (runId, nodeId) pair already wrote — or
// didn't: a deterministic completion has no usage record and costUsd naturally comes back 0, no
// special case needed (same as R-20's $0-event convention). Best-effort is the CALLER's job: both
// call sites (executor.ts's executeRunnableNode dispatch and nodeRuntime.ts's executeNode) wrap this
// in .catch(() => undefined) — a timing-repository failure must never fail the run or node execution
// it is merely observing.
export async function recordNodeTimingCompletion(input: RecordNodeTimingCompletionInput, store: NodeTimingRepository = repositoryManager.getNodeTimingRepository()): Promise<NodeTimingRecord> {
  const usage = await summarizeModelUsage({ runId: input.runId, nodeId: input.nodeId });
  return store.record(buildNodeTimingRecord({ ...input, costUsd: usage.totalCostUsdEstimate }));
}
