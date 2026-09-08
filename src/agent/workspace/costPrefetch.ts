// THE COST PREFETCH (2026-09-08) — the run-cost figure delivered TO monetization_strategy, so it has
// nothing left to invent.
//
// Same F1 pattern as contractPrefetch.ts / voicePrefetch.ts / sitePrefetch.ts, and here for the same
// reason those exist: a fact a node needs is fetched by DETERMINISTIC CONDUCTOR CODE before the agent
// loop starts, rather than left for the model to discover, estimate, or — as happened on
// run_1788769566432_5qnafb — simply make up ($800 against an actual $3.86).
//
// WHY A PREFETCH RATHER THAN A TOOL. `monetize.ev_floor` already exists and already reads a real cost
// server-side, and it is still not enough on its own: a tool is something the model CHOOSES to call,
// with arguments the model chooses. The node's own output on the defective run carried a hand-authored
// estimatedRunCost and no evidence the tool was consulted at all. A prefetched fact is in the node's
// input whether or not it calls anything, which is the difference between "the model was offered a
// real number" and "the model could not have used a different one honestly".
//
// THIS CAN NEVER FAIL A NODE. Every failure path resolves to the no_history estimate ($0 floor, which
// blocks nothing) plus a named run-visible warning — the same loud-degradation convention
// `contract_prefetch_failed`, `voice_prefetch_fallback` and `site_prefetch_degraded` use. An EV floor
// is an optimization on spend; it must never be the reason a run cannot proceed.
import { repositoryManager } from "../runtime/repositories.js";
import type { NodeTimingRepository } from "../repository/interfaces/NodeTimingRepository.js";
import { estimateRunCostFromHistory, type RunCostEstimate } from "./runCostHistory.js";

export type CostPrefetchWarningCode = "cost_history_unavailable" | "cost_history_insufficient" | "threw";

export type CostPrefetchResult = {
  estimate: RunCostEstimate;
  warningCode?: CostPrefetchWarningCode;
  warning?: string;
};

export type CostPrefetchParams = { runId: string; workflowId: string };
export type CostPrefetchDeps = { nodeTimingRepository?: NodeTimingRepository };

// The key this estimate travels under in the node's input. Named as a constant so the executor, the
// node prompt op and the tests all mean the same field.
export const RUN_COST_ESTIMATE_INPUT_KEY = "runCostEstimate";

// The empty-ledger estimate, with the reason swapped in. Derived from the same pure function rather
// than hand-built, so "no history" has exactly one shape however it was arrived at.
const noHistory = (reason: string): RunCostEstimate => ({ ...estimateRunCostFromHistory({ records: [] }), rationale: reason });

export async function getRunCostEstimate(params: CostPrefetchParams, deps: CostPrefetchDeps = {}): Promise<CostPrefetchResult> {
  const store = deps.nodeTimingRepository ?? repositoryManager.getNodeTimingRepository();
  try {
    const records = await store.list({ workflowId: params.workflowId });
    const estimate = estimateRunCostFromHistory({ records, excludeRunId: params.runId });
    if (estimate.basis === "no_history") {
      return {
        estimate,
        warningCode: "cost_history_insufficient",
        warning: `No usable run-cost history for workflow "${params.workflowId}" (${estimate.sampleRuns} prior run(s) with recorded cost). The EV floor for this run is $0 and cannot block anything.`
      };
    }
    return { estimate };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      estimate: noHistory(`The node timing ledger could not be read (${message}), so no run-cost history is available. estimatedRunCostUsd is 0 and the EV floor blocks nothing.`),
      warningCode: "cost_history_unavailable",
      warning: message
    };
  }
}
