// EV-FLOOR TRAFFIC HISTORY (2026-09-09) — the second half of the same defect the run-cost estimate
// closed, and the more dangerous half.
//
// WHAT WAS STILL INVENTED. `expectedValue = expectedCommission x assumedConversionRate x
// expectedMonthlyTraffic`. runCostHistory.ts made the COST side measured. Both surviving revenue
// multipliers were still authored by a model turn: `expectedMonthlyTraffic` (the defective run said
// 400) and `assumedConversionRate` appear NOWHERE in this repository outside the node's own schema —
// no engine reader, no measured source, nothing to check them against.
//
// WHY THAT GOT WORSE, NOT BETTER, WHEN THE COST FIX LANDED. `ev_floor_blocked` halts a run on
// `estimateBasis: "monetizer_data"`, and that label is applied by the node. With the monetizer back
// up, a run can honestly label monetizer_data — the payout genuinely IS live — while traffic and
// conversion remain fabricated, and stop a real article on a number nobody measured. The cost figure
// was 200x wrong; an invented traffic figure has no ceiling on how wrong it can be, and it multiplies.
//
// THE MEASURED SOURCE ALREADY EXISTS. The tenant sites emit engagement telemetry to the tracking sink;
// T21.7's bridge (improvement/trackingIngest.ts) pulls per-producer rollups and records them as
// feedback OUTCOME rows (source `tracking:engagement.v1`), and T21.22 (improvement/engagement.ts) made
// them readable and aggregable. This module does not add a second reader, a second aggregation or a
// second metric vocabulary — it reuses `engagementOutcomeRecords` and `aggregateEngagement` verbatim
// and only answers the one question the EV floor asks: how much traffic does a piece on this property
// actually get in a month, and how often does it convert.
//
// READS THE LEDGER, NEVER THE SINK. Like runCostHistory.ts, this is a pure function over records the
// scheduled ingest job has already written locally. No network in a node dispatch path, no sink
// credential anywhere near the conductor, and the same figure every time it is recomputed.
//
// SESSIONS, NOT PAGEVIEWS. `expectedMonthlyTraffic` is multiplied by a per-visit conversion rate, so
// the honest unit is the visit. Pageviews double-count a reader who scrolls to a second page and would
// inflate the floor's numerator for free.
//
// THE FLOOR IS THE ONE ENGAGEMENT.TS ALREADY SET. ENGAGEMENT_MIN_SESSIONS (50) — below it,
// engagement.ts refuses to diagnose anything because reader-behaviour rates on a handful of sessions
// are noise. A floor computed from that noise would be worse than no floor, so this refuses too: basis
// "insufficient_data", traffic 0, conversion null. Never a placeholder magnitude, for the same reason
// runCostHistory.ts's fallback is 0 rather than a round number.
import { ENGAGEMENT_MIN_SESSIONS, aggregateEngagement, engagementOutcomeRecords } from "../improvement/engagement.js";
import type { FeedbackRecord } from "../improvement/improvementTypes.js";

/** Where the volume figure came from. The EV floor's `estimateBasis` can only reach "monetizer_data"
 *  on the measured one — see evFloor.ts. */
export type TrafficBasis = "tracking_engagement" | "insufficient_data";

export const TRAFFIC_WINDOW_DAYS = 90;
const DAYS_PER_MONTH = 30;

export type TrafficEstimate = {
  artifact: "traffic_estimate.v1";
  // Sessions per month, normalized from the observed window. 0 when there is not enough data —
  // never a placeholder.
  expectedMonthlyTraffic: number;
  // The measured purchase rate (session-weighted, as engagement.ts computes it), or null when no
  // record reported one. NULL, NOT ZERO: "nobody measured it" and "it measured zero" are different
  // facts, and the floor must not treat the first as the second.
  observedConversionRate: number | null;
  basis: TrafficBasis;
  windowDays: number;
  sessions: number;
  pageviews: number | null;
  sampleRecords: number;
  rationale: string;
};

export type EstimateTrafficFromHistoryInput = {
  records: readonly FeedbackRecord[];
  // Window end; defaults to now. Supplied by tests and by the prefetch so the figure is reproducible.
  now?: Date;
  windowDays?: number;
  minSessions?: number;
};

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

// Pure and total. An empty ledger, an unstamped record, a window with no rows — all yield a
// well-formed estimate. Nothing here reads a repository, a network or a model.
export function estimateTrafficFromHistory(input: EstimateTrafficFromHistoryInput): TrafficEstimate {
  const windowDays = Number.isFinite(input.windowDays) && (input.windowDays as number) > 0 ? Math.floor(input.windowDays as number) : TRAFFIC_WINDOW_DAYS;
  const minSessions = Number.isFinite(input.minSessions) && (input.minSessions as number) >= 0 ? Math.floor(input.minSessions as number) : ENGAGEMENT_MIN_SESSIONS;
  const to = input.now ?? new Date();
  const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const records = engagementOutcomeRecords([...input.records], from.toISOString(), to.toISOString());
  const metrics = aggregateEngagement(records);
  const sessions = Number.isFinite(metrics.sessions) ? (metrics.sessions as number) : 0;
  const pageviews = Number.isFinite(metrics.pageviews) ? (metrics.pageviews as number) : null;
  const purchaseRate = Number.isFinite(metrics.purchase_rate) ? (metrics.purchase_rate as number) : null;

  if (sessions < minSessions) {
    return {
      artifact: "traffic_estimate.v1",
      expectedMonthlyTraffic: 0,
      observedConversionRate: null,
      basis: "insufficient_data",
      windowDays,
      sessions,
      pageviews,
      sampleRecords: records.length,
      rationale: `Not enough measured traffic for this property: ${sessions} session(s) across ${records.length} engagement record(s) in the last ${windowDays} days, below the ${minSessions} that engagement.ts requires before reader-behaviour figures mean anything. expectedMonthlyTraffic is 0 and observedConversionRate is null — the EV floor built on them cannot block, which is the only honest outcome when nobody has measured the traffic.`
    };
  }

  const expectedMonthlyTraffic = Math.round((sessions / windowDays) * DAYS_PER_MONTH);
  return {
    artifact: "traffic_estimate.v1",
    expectedMonthlyTraffic,
    observedConversionRate: purchaseRate === null ? null : round(purchaseRate, 6),
    basis: "tracking_engagement",
    windowDays,
    sessions,
    pageviews,
    sampleRecords: records.length,
    rationale: `expectedMonthlyTraffic = ${sessions} measured session(s) over ${windowDays} days, normalized to ${DAYS_PER_MONTH} days = ${expectedMonthlyTraffic}, from ${records.length} tracking:engagement.v1 outcome record(s). ${purchaseRate === null ? "No record reported purchase_rate, so observedConversionRate is null — an unmeasured rate is not a zero one." : `observedConversionRate = ${round(purchaseRate, 6)}, the session-weighted measured purchase rate.`} Sessions, not pageviews: the floor multiplies this by a per-visit conversion rate.`
  };
}
