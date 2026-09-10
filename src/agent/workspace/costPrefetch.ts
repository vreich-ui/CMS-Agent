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
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { NodeTimingRepository } from "../repository/interfaces/NodeTimingRepository.js";
import { estimateRunCostFromHistory, type RunCostEstimate } from "./runCostHistory.js";

// W0.5 — `ev_floor_history_pooled` joins the set: the estimate WAS produced and is usable, but it was
// taken across every tenant running this workflow because the named tenant had too little history of
// its own. That is a degradation, not a failure, and it follows the same loud-degradation convention
// as the codes beside it — a floor derived from another site's economics should never be silent.
export type CostPrefetchWarningCode = "cost_history_unavailable" | "cost_history_insufficient" | "ev_floor_history_pooled" | "threw";

export type CostPrefetchResult = {
  estimate: RunCostEstimate;
  warningCode?: CostPrefetchWarningCode;
  warning?: string;
};

// Bounded twice: one page for the tenant and one pooled page. The pure qualifier reports how many
// candidates it rejected; fetching more to make that number look better would turn a dispatch into a
// growing whole-history join.
export const MAX_RUN_COST_HISTORY_CANDIDATES = 50;
export type CostPrefetchParams = {
  runId: string;
  workflowId: string;
  projectId?: string;
  // Additive caller evidence. Until the conductor supplies the current route-era map, no historical
  // run can prove it executed today's workflow and the result stays safely `no_history`.
  currentRouteEras?: Readonly<Record<string, string>>;
  now?: Date;
};
export type CostPrefetchDeps = { nodeTimingRepository?: NodeTimingRepository; executionRepository?: ExecutionRepository };

// The key this estimate travels under in the node's input. Named as a constant so the executor, the
// node prompt op and the tests all mean the same field.
export const RUN_COST_ESTIMATE_INPUT_KEY = "runCostEstimate";

// The empty-ledger estimate, with the reason swapped in. Derived from the same pure function rather
// than hand-built, so "no history" has exactly one shape however it was arrived at.
const noHistory = (reason: string): RunCostEstimate => ({ ...estimateRunCostFromHistory({ records: [] }), rationale: reason });

export async function getRunCostEstimate(params: CostPrefetchParams, deps: CostPrefetchDeps = {}): Promise<CostPrefetchResult> {
  const timingStore = deps.nodeTimingRepository ?? repositoryManager.getNodeTimingRepository();
  const executionStore = deps.executionRepository ?? repositoryManager.getExecutionRepository();
  try {
    const stamp = (estimate: RunCostEstimate): RunCostEstimate => ({ ...estimate, workflowId: params.workflowId, evaluatedAt: (params.now ?? new Date()).toISOString() });
    if (!params.currentRouteEras || !Object.keys(params.currentRouteEras).length) {
      const estimate = stamp(estimateRunCostFromHistory({ records: [], candidates: [], currentRouteEras: params.currentRouteEras, excludeRunId: params.runId, projectId: params.projectId }));
      return {
        estimate,
        warningCode: "cost_history_insufficient",
        warning: `No current route-era evidence was supplied for workflow "${params.workflowId}", so historical timing rows cannot be claimed as this workflow's completed cost. The EV floor is $0 and cannot block anything.`
      };
    }

    // Project candidates are fetched independently so tenant history wins when it is sufficient.
    // The pooled page is separately bounded and is only a labeled fallback in the pure qualifier.
    const [projectPage, pooledPage] = await Promise.all([
      params.projectId
        ? executionStore.listRunsPage({ workflowId: params.workflowId, projectId: params.projectId, status: "completed", limit: MAX_RUN_COST_HISTORY_CANDIDATES })
        : Promise.resolve({ runs: [] }),
      executionStore.listRunsPage({ workflowId: params.workflowId, status: "completed", limit: MAX_RUN_COST_HISTORY_CANDIDATES })
    ]);
    const candidates = new Map([...projectPage.runs, ...pooledPage.runs].map((run) => [run.runId, run]));
    const timingRows = await Promise.all([...candidates.values()].map((run) => timingStore.list({ runId: run.runId })));
    const estimate = stamp(estimateRunCostFromHistory({
      records: timingRows.flat(),
      candidates: [...candidates.values()],
      currentRouteEras: params.currentRouteEras,
      excludeRunId: params.runId,
      projectId: params.projectId
    }));
    if (estimate.basis === "no_history") {
      return {
        estimate,
        warningCode: "cost_history_insufficient",
        warning: `No usable run-cost history for workflow "${params.workflowId}"${params.projectId ? ` on project "${params.projectId}"` : ""} (${estimate.sampleRuns} prior run(s) with recorded cost). The EV floor for this run is $0 and cannot block anything.`
      };
    }
    if (estimate.scope === "pooled" && params.projectId) {
      return {
        estimate,
        warningCode: "ev_floor_history_pooled",
        warning: `The EV floor for this run was derived from POOLED history across every tenant running workflow "${params.workflowId}" — project "${params.projectId}" has too few attributable prior runs of its own. The figure ($${estimate.estimatedRunCostUsd}) reflects other sites' economics as much as this one's; it is used because a measured pooled number beats no number, not because it is this site's cost.`
      };
    }
    return { estimate };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      estimate: { ...noHistory(`The node timing ledger could not be read (${message}), so no run-cost history is available. estimatedRunCostUsd is 0 and the EV floor blocks nothing.`), workflowId: params.workflowId, evaluatedAt: (params.now ?? new Date()).toISOString() },
      warningCode: "cost_history_unavailable",
      warning: message
    };
  }
}
