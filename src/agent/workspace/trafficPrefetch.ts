// THE TRAFFIC PREFETCH (2026-09-09) — sibling of costPrefetch.ts, for the same reason and with the
// same posture. `monetization_strategy` was inventing `expectedMonthlyTraffic` and
// `assumedConversionRate` because nothing put measured ones in front of it. Now the conductor does,
// deterministically, before the agent loop starts.
//
// WHY THE FEEDBACK LEDGER AND NOT THE SINK. The tracking sink is reached by a SCHEDULED job
// (entrypoints/trackingIngestJob.ts) that writes engagement rows into the local feedback store. A
// prefetch that called the sink itself would put a network hop, a credential and a 15s timeout inside
// a node dispatch, and would return a different number every time it ran. Reading what the job already
// wrote costs one local list and is reproducible — the same choice costPrefetch.ts makes against the
// node timing ledger.
//
// PROJECT SCOPING. Feedback rows carry the CMS-AGENT project id (`dr-lurie`), stamped by S-07 — never
// the sink's own partition id (`drlurie`). run.projectId is the CMS-Agent id, so it filters directly.
// A record written before S-07 carries no projectId; those are EXCLUDED rather than counted, because a
// traffic figure attributed to the wrong property is worse than one that says it has no data.
//
// THIS CAN NEVER FAIL A NODE. Every failure path resolves to the insufficient_data estimate (traffic
// 0, conversion null, a floor that cannot block) plus a named run-visible warning — the same
// loud-degradation convention `contract_prefetch_failed`, `voice_prefetch_fallback`,
// `site_prefetch_degraded` and `cost_prefetch_degraded` use.
import { repositoryManager } from "../runtime/repositories.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import { estimateTrafficFromHistory, TRAFFIC_WINDOW_DAYS, type TrafficEstimate } from "./trafficHistory.js";

export type TrafficPrefetchWarningCode = "traffic_history_unavailable" | "traffic_history_insufficient" | "traffic_history_truncated" | "threw";

// THE PAGE CAP, AND WHY IT IS CHECKED RATHER THAN ASSUMED (caught in review of this change, 2026-09-09).
// `listFeedback` DEFAULTS TO THE NEWEST 100 RECORDS — a paging default, not a window. Calling it
// without a limit would have silently truncated the aggregation on any tenant with more than 100
// outcome rows, under-reporting sessions and handing back a measured-LOOKING traffic figure computed
// from a partial read. An undercounted volume shrinks expectedValue, and on an earned block that halts
// a run that should have been written — which is the exact defect class this module exists to end,
// reintroduced by the fix for it.
//
// So the limit is explicit, and saturation is CHECKED rather than assumed fatal. `listFeedback` returns
// newest-first, so a saturated read still reaches back as far as its oldest returned row: when that row
// predates the estimate's own window, the window is fully covered and truncation cost this estimate
// nothing. Only a saturated read that does NOT reach back far enough is incomplete, and only that case
// withholds. Treating every saturated read as fatal would have been simpler and wrong — a busy
// multi-tenant ledger exceeds any cap eventually, and the feature would have died quietly for every
// tenant at once, which is exactly the kind of silent-nothing failure this area keeps producing.
export const FEEDBACK_PAGE_LIMIT = 2000;

export type TrafficPrefetchResult = {
  estimate: TrafficEstimate;
  warningCode?: TrafficPrefetchWarningCode;
  warning?: string;
};

export type TrafficPrefetchParams = { projectId: string; now?: Date };
export type TrafficPrefetchDeps = { evaluationRepository?: EvaluationRepository };

/** The key this estimate travels under in the node's input. A constant so the executor, the node op
 *  and the tests all mean the same field. */
export const TRAFFIC_ESTIMATE_INPUT_KEY = "trafficEstimate";

const insufficient = (reason: string): TrafficEstimate => ({ ...estimateTrafficFromHistory({ records: [] }), rationale: reason });

export async function getTrafficEstimate(params: TrafficPrefetchParams, deps: TrafficPrefetchDeps = {}): Promise<TrafficPrefetchResult> {
  const store = deps.evaluationRepository ?? repositoryManager.getEvaluationRepository();
  try {
    const all = await store.listFeedback({ kind: "outcome", limit: FEEDBACK_PAGE_LIMIT });
    const now = params.now ?? new Date();
    const windowStart = new Date(now.getTime() - TRAFFIC_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const oldestSeen = all.length ? all[all.length - 1].createdAt : undefined;
    const windowCovered = all.length < FEEDBACK_PAGE_LIMIT || (oldestSeen !== undefined && oldestSeen <= windowStart);
    if (!windowCovered) {
      return {
        estimate: insufficient(`The engagement read came back at its ${FEEDBACK_PAGE_LIMIT}-record page cap without reaching back ${TRAFFIC_WINDOW_DAYS} days (oldest row seen: ${oldestSeen}), so rows inside this estimate's own window are missing from it. A traffic figure computed from a partial window would look measured and not be, so none is reported: expectedMonthlyTraffic is 0 and the volume side cannot earn a block.`),
        warningCode: "traffic_history_truncated",
        warning: `feedback outcome read hit the ${FEEDBACK_PAGE_LIMIT}-record cap for project "${params.projectId}" without covering the ${TRAFFIC_WINDOW_DAYS}-day window; the traffic estimate is withheld rather than computed from it.`
      };
    }
    // Own-property rows only. An unstamped record cannot be proved to belong to this project, and a
    // traffic figure borrowed from another tenant would be a fabrication with a measured-looking label.
    const mine = all.filter((record) => record.projectId === params.projectId);
    const estimate = estimateTrafficFromHistory({ records: mine, now });
    if (estimate.basis === "insufficient_data") {
      return {
        estimate,
        warningCode: "traffic_history_insufficient",
        warning: `No usable engagement history for project "${params.projectId}" (${estimate.sessions} session(s) across ${estimate.sampleRecords} record(s) in the last ${estimate.windowDays} days). The EV floor's volume side is unmeasured and cannot earn a block.`
      };
    }
    return { estimate };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      estimate: insufficient(`The feedback ledger could not be read (${message}), so no engagement history is available. expectedMonthlyTraffic is 0 and the EV floor's volume side cannot earn a block.`),
      warningCode: "traffic_history_unavailable",
      warning: message
    };
  }
}
