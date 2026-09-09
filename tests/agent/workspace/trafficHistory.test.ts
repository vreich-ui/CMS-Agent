import { describe, expect, it } from "vitest";
import { estimateTrafficFromHistory, TRAFFIC_WINDOW_DAYS } from "../../../src/agent/workspace/trafficHistory.js";
import { computeEvFloor } from "../../../src/agent/workspace/evFloor.js";
import { ENGAGEMENT_MIN_SESSIONS } from "../../../src/agent/improvement/engagement.js";
import { TRACKING_OUTCOME_SOURCE } from "../../../src/agent/improvement/trackingIngest.js";
import type { FeedbackRecord } from "../../../src/agent/improvement/improvementTypes.js";
import { FEEDBACK_PAGE_LIMIT, getTrafficEstimate } from "../../../src/agent/workspace/trafficPrefetch.js";
import type { EvaluationRepository } from "../../../src/agent/repository/interfaces/EvaluationRepository.js";

// TIER 1 (2026-09-09). The cost fix measured the EV floor's denominator and left its two biggest
// multipliers — traffic and conversion rate — authored by a model turn. These pin that they now come
// from the tracking sink's ingested engagement rows, and that an unmeasured volume can no longer
// reach the one estimateBasis that halts a run.

const NOW = new Date("2026-09-09T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const row = (sessions: number, over: Record<string, number> = {}, createdAt = daysAgo(10)): FeedbackRecord => ({
  feedbackId: `fb_${sessions}_${createdAt}`,
  kind: "outcome",
  projectId: "dr-lurie",
  outcome: { source: TRACKING_OUTCOME_SOURCE, metrics: { sessions, pageviews: sessions * 2, ...over } },
  createdAt
});

describe("estimateTrafficFromHistory — expectedMonthlyTraffic is measured, not asserted", () => {
  it("normalizes measured sessions in the window to a monthly figure and names the basis", () => {
    // 900 sessions over the 90-day window -> 900/90*30 = 300 a month.
    const estimate = estimateTrafficFromHistory({ records: [row(400), row(300), row(200)], now: NOW });

    expect(estimate.basis).toBe("tracking_engagement");
    expect(estimate.sessions).toBe(900);
    expect(estimate.expectedMonthlyTraffic).toBe(300);
    expect(estimate.windowDays).toBe(TRAFFIC_WINDOW_DAYS);
    expect(estimate.rationale).toContain("Sessions, not pageviews");
  });

  it("carries the measured purchase rate as observedConversionRate, session-weighted", () => {
    // engagement.ts weights rates by sessions: (0.02*900 + 0.10*100) / 1000 = 0.028.
    const estimate = estimateTrafficFromHistory({ records: [row(900, { purchase_rate: 0.02 }), row(100, { purchase_rate: 0.1 })], now: NOW });

    expect(estimate.observedConversionRate).toBeCloseTo(0.028, 6);
  });

  it("leaves observedConversionRate NULL — never 0 — when no record reported a purchase rate", () => {
    const estimate = estimateTrafficFromHistory({ records: [row(900)], now: NOW });

    expect(estimate.observedConversionRate).toBeNull();
    expect(estimate.rationale).toContain("an unmeasured rate is not a zero one");
  });

  it("refuses below engagement.ts's own session floor: 0 traffic, named, never a placeholder magnitude", () => {
    const estimate = estimateTrafficFromHistory({ records: [row(ENGAGEMENT_MIN_SESSIONS - 1)], now: NOW });

    expect(estimate.basis).toBe("insufficient_data");
    expect(estimate.expectedMonthlyTraffic).toBe(0);
    expect(estimate.observedConversionRate).toBeNull();
    expect(estimate.rationale).toContain("cannot block");
  });

  it("ignores rows outside the window — last quarter's traffic is not this quarter's", () => {
    const estimate = estimateTrafficFromHistory({ records: [row(5000, {}, daysAgo(200)), row(60)], now: NOW });

    expect(estimate.sessions).toBe(60);
    expect(estimate.expectedMonthlyTraffic).toBe(20);
  });

  it("is total on an empty ledger", () => {
    expect(estimateTrafficFromHistory({ records: [], now: NOW })).toMatchObject({ basis: "insufficient_data", expectedMonthlyTraffic: 0, sessions: 0 });
  });
});

describe("an invented traffic figure can no longer earn a block", () => {
  const liveRevenue = { runCostUsd: 3.86, floorMultiplier: 1.25, payoutUsd: 20, conversionRate: 0.001, estimatedVolume: 100, runCostBasis: "workflow_history" } as const;

  it("THE TIER-1 GUARD: a live payout with an ASSUMED volume is 'mixed', not 'monetizer_data'", () => {
    const floor = computeEvFloor({ ...liveRevenue, revenueBasis: "monetizer_data" });

    expect(floor.verdict).toBe("block");
    expect(floor.volumeBasis).toBe("stated_assumption");
    // Not monetizer_data -> ev_floor_blocked does not fire -> the article is written.
    expect(floor.estimateBasis).toBe("mixed");
  });

  it("reaches monetizer_data only when the volume was measured too", () => {
    const floor = computeEvFloor({ ...liveRevenue, revenueBasis: "monetizer_data", volumeBasis: "tracking_engagement" });

    expect(floor.volumeBasis).toBe("tracking_engagement");
    expect(floor.estimateBasis).toBe("monetizer_data");
    expect(floor.rationale).toContain("volumeBasis = tracking_engagement");
  });

  it("measured traffic alone does not earn a block either — the payout still has to be live", () => {
    const floor = computeEvFloor({ ...liveRevenue, volumeBasis: "tracking_engagement" });

    expect(floor.estimateBasis).toBe("mixed");
  });

  it("an omitted volumeBasis is treated as assumed, so forgetting the field cannot earn a block", () => {
    expect(computeEvFloor({ ...liveRevenue, revenueBasis: "monetizer_data" }).volumeBasis).toBe("stated_assumption");
  });
});

// The page cap. `listFeedback` DEFAULTS to the newest 100 records, so an unlimited call would have
// silently truncated the window and reported a measured-looking figure from a partial read — the exact
// defect class this change exists to end, reintroduced by the fix for it. Caught in review.
describe("getTrafficEstimate — a truncated read never becomes a measured number", () => {
  const repoWith = (records: FeedbackRecord[]): EvaluationRepository =>
    ({ listFeedback: async (filters?: { limit?: number }) => records.slice(0, filters?.limit ?? 100) } as unknown as EvaluationRepository);

  it("passes an explicit limit rather than inheriting the 100-record paging default", async () => {
    let seenLimit: number | undefined;
    const repo = { listFeedback: async (filters?: { limit?: number }) => { seenLimit = filters?.limit; return []; } } as unknown as EvaluationRepository;

    await getTrafficEstimate({ projectId: "dr-lurie", now: NOW }, { evaluationRepository: repo });

    expect(seenLimit).toBe(FEEDBACK_PAGE_LIMIT);
  });

  it("withholds when a saturated read does NOT reach back across the window", async () => {
    const recent = Array.from({ length: FEEDBACK_PAGE_LIMIT }, (_, i) => row(100, {}, daysAgo(1 + (i % 5))));
    const result = await getTrafficEstimate({ projectId: "dr-lurie", now: NOW }, { evaluationRepository: repoWith(recent) });

    expect(result.warningCode).toBe("traffic_history_truncated");
    expect(result.estimate).toMatchObject({ basis: "insufficient_data", expectedMonthlyTraffic: 0 });
  });

  it("still computes when a saturated read DOES reach back past the window — truncation cost it nothing", async () => {
    // Newest-first, oldest row older than the 90-day window: everything inside the window is present.
    const spanning = [...Array.from({ length: FEEDBACK_PAGE_LIMIT - 1 }, (_, i) => row(100, {}, daysAgo(10))), row(100, {}, daysAgo(200))];
    const result = await getTrafficEstimate({ projectId: "dr-lurie", now: NOW }, { evaluationRepository: repoWith(spanning) });

    expect(result.warningCode).toBeUndefined();
    expect(result.estimate.basis).toBe("tracking_engagement");
  });
});
