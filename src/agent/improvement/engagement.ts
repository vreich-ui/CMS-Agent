// Engagement evidence for the optimizer (T21.22) — the missing half of the outer loop.
//
// T21.7 got real reader behaviour into the store: the tracking sink's per-producer rollups land as
// feedback OUTCOME records (source `tracking:engagement.v1`). Nothing then READ them. analyzeNode
// only COUNTED outcome records and proposeImprovement diagnosed purely from `worstCriteria[0]` —
// rubric scores — so completion rate, CTA CTR, purchase rate and dwell influenced nothing.
//
// That gap is not cosmetic. A rubric evaluation is a judgement of the artifact against a written
// standard; it structurally cannot observe the case that matters most, which is content that scores
// WELL on the rubric and still fails with readers. This module is what makes that case visible:
// aggregate the node's own engagement records over the analysis window, fetch the SITE MEDIAN for the
// same window (one row per published object, from the same sink through the same client), and name
// the shortfall.
//
// Three rules hold this honest, and the tests pin all three:
//   1. FLOOR — below `ENGAGEMENT_MIN_SESSIONS` sessions the block reports `insufficient_data` with
//      the n it has, no median is fetched and no diagnosis is attempted. Reader-behaviour rates on a
//      handful of sessions are noise, and a mutation proposed from noise is worse than none.
//   2. NEVER FABRICATE — a metric no record reported is absent, not zero; a median with no rows to
//      compute from is absent, not assumed. Comparisons exist only where both sides were measured.
//   3. NEVER DEGRADE — an unconfigured or unreachable sink yields NO block at all, so the optimizer
//      behaves exactly as it did before this landed. Nothing here throws.
import {
  TRACKING_OUTCOME_SOURCE,
  TRACKING_PROJECT_ID_ENV,
  fetchRollupRows,
  trackingMetricsFromRow,
  trackingSinkConnectionState,
  type RollupFetchDeps
} from "./trackingIngest.js";
import type { FeedbackRecord } from "./improvementTypes.js";

/** The engagement.v1 metrics this evidence block carries. A subset of TRACKING_METRIC_KEYS: revenue
 * is Monetizer's view of the same content and `exposures` is an impression count that means different
 * things per surface — neither belongs in a reader-behaviour comparison. */
export const ENGAGEMENT_METRIC_KEYS = ["pageviews", "sessions", "completion_rate", "cta_ctr", "purchase_rate", "p75_dwell_ms"] as const;
export type EngagementMetricKey = typeof ENGAGEMENT_METRIC_KEYS[number];

/** The metrics a site median is meaningful for. Counts (pageviews/sessions) measure how much traffic
 * an object got, not how well it did with it — comparing a node's total pageviews against a
 * per-object median compares a sum against a single object and says nothing. Rates and dwell are
 * per-reader and comparable; on all four, higher is better. */
export const ENGAGEMENT_COMPARABLE_KEYS = ["completion_rate", "cta_ctr", "purchase_rate", "p75_dwell_ms"] as const;
export type EngagementComparableKey = typeof ENGAGEMENT_COMPARABLE_KEYS[number];

/** Sessions required in the window before engagement is analyzed at all (rule 1 above). */
export const ENGAGEMENT_MIN_SESSIONS = 50;
/** A metric counts as a shortfall at or below this fraction of the site median. Plain "below the
 * median" is a coin flip — half of everything is below a median — so a named cause needs a margin. */
export const ENGAGEMENT_SHORTFALL_RATIO = 0.8;
/** What "the node scores well on its rubric" means for the good-rubric/bad-engagement cause. */
export const RUBRIC_HEALTHY_MIN_MEAN_SCORE = 0.7;
export const RUBRIC_HEALTHY_MIN_PASS_RATE = 0.8;

/** The named cause of an engagement shortfall the rubric cannot see. Kept as an id, not prose, so it
 * can be filtered, counted and asserted rather than grepped out of a diagnosis sentence. */
export const ENGAGEMENT_CAUSE = "engagement_below_site_median";

export type EngagementShortfall = { metric: EngagementComparableKey; value: number; median: number; ratio: number };

export type EngagementBlock = {
  /** `analyzed` = above the floor and compared against a site median. `insufficient_data` = the floor
   * was not met; the measured metrics are still reported, but nothing is diagnosed from them. */
  status: "analyzed" | "insufficient_data";
  source: typeof TRACKING_OUTCOME_SOURCE;
  window: { from: string; to: string };
  /** Outcome records aggregated. Not a session count — see `sessions`. */
  n: number;
  pageviews?: number;
  sessions?: number;
  completion_rate?: number;
  cta_ctr?: number;
  purchase_rate?: number;
  p75_dwell_ms?: number;
  /** Per-object medians over the SAME window, and how many objects they were computed from. Absent
   * below the floor (not fetched) and whenever the sink could not answer. */
  siteMedian?: { n: number; metrics: Partial<Record<EngagementMetricKey, number>> };
  /** Comparable metrics at or below ENGAGEMENT_SHORTFALL_RATIO of the median, worst ratio first. */
  belowMedian?: EngagementShortfall[];
};

const isFinite_ = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The node's `tracking:engagement.v1` outcome records inside the window. `from`/`to` are the
 * analysis window analyzeNode was given; an open end means "everything on that side". */
export function engagementOutcomeRecords(feedback: FeedbackRecord[], from?: string, to?: string): FeedbackRecord[] {
  return feedback.filter((record) => {
    if (record.kind !== "outcome" || record.outcome?.source !== TRACKING_OUTCOME_SOURCE) return false;
    if (from && record.createdAt < from) return false;
    if (to && record.createdAt > to) return false;
    return true;
  });
}

/**
 * Aggregate N outcome records onto one metric vector.
 *
 * Counts (pageviews, sessions) SUM. Rates are session-WEIGHTED means — an unweighted mean lets a
 * 3-session row outvote a 3,000-session one, which is how a node with one freak page looks either
 * excellent or catastrophic. A record that reports no sessions carries weight 1 rather than being
 * dropped, so it still contributes without dominating.
 *
 * `p75_dwell_ms` is the session-weighted mean of the per-row p75s. A true window p75 is NOT
 * recoverable from pre-aggregated rollups (you would need the raw distribution), and this is stated
 * wherever the number is rendered rather than being quietly presented as a real percentile.
 *
 * A metric no record reported comes back UNDEFINED — never 0. "Nobody measured it" and "it measured
 * zero" are different facts and a proposal built on the second when the first is true is fabricated.
 */
export function aggregateEngagement(records: FeedbackRecord[]): Partial<Record<EngagementMetricKey, number>> {
  const sums = new Map<EngagementMetricKey, number>();
  const weighted = new Map<EngagementMetricKey, { total: number; weight: number }>();
  for (const record of records) {
    const metrics = record.outcome?.metrics ?? {};
    const sessions = metrics.sessions;
    const weight = isFinite_(sessions) && sessions > 0 ? sessions : 1;
    for (const key of ENGAGEMENT_METRIC_KEYS) {
      const value = metrics[key];
      if (!isFinite_(value)) continue;
      if (key === "pageviews" || key === "sessions") {
        sums.set(key, (sums.get(key) ?? 0) + value);
      } else {
        const bucket = weighted.get(key) ?? { total: 0, weight: 0 };
        bucket.total += value * weight;
        bucket.weight += weight;
        weighted.set(key, bucket);
      }
    }
  }
  const out: Partial<Record<EngagementMetricKey, number>> = {};
  for (const [key, value] of sums) out[key] = value;
  for (const [key, bucket] of weighted) if (bucket.weight > 0) out[key] = round(bucket.total / bucket.weight, key === "p75_dwell_ms" ? 0 : 6);
  return out;
}

/** Per-metric median across the sink's `by=object` rows — one row per published object on the site.
 * Rows are projected through the ingest bridge's own row reader, so casing and nesting are handled
 * identically on both sides of the comparison. A metric no row reported has no median. */
export function medianRollupMetrics(rows: Array<Record<string, unknown>>): Partial<Record<EngagementMetricKey, number>> {
  const out: Partial<Record<EngagementMetricKey, number>> = {};
  const projected = rows.map((row) => trackingMetricsFromRow(row));
  for (const key of ENGAGEMENT_METRIC_KEYS) {
    const values = projected.map((metrics) => metrics[key]).filter(isFinite_).sort((a, b) => a - b);
    if (!values.length) continue;
    const middle = values.length >> 1;
    out[key] = values.length % 2 ? values[middle]! : round((values[middle - 1]! + values[middle]!) / 2, key === "p75_dwell_ms" ? 0 : 6);
  }
  return out;
}

/** Comparable metrics that sit at or below ENGAGEMENT_SHORTFALL_RATIO of the site median, worst
 * first. A metric missing on either side produces no entry — there is nothing to compare. */
export function engagementShortfalls(
  measured: Partial<Record<EngagementMetricKey, number>>,
  median: Partial<Record<EngagementMetricKey, number>>
): EngagementShortfall[] {
  const shortfalls: EngagementShortfall[] = [];
  for (const metric of ENGAGEMENT_COMPARABLE_KEYS) {
    const value = measured[metric];
    const reference = median[metric];
    if (!isFinite_(value) || !isFinite_(reference) || reference <= 0) continue;
    const ratio = round(value / reference, 3);
    if (ratio <= ENGAGEMENT_SHORTFALL_RATIO) shortfalls.push({ metric, value, median: reference, ratio });
  }
  return shortfalls.sort((a, b) => a.ratio - b.ratio);
}

const METRIC_LABELS: Record<EngagementMetricKey, string> = {
  pageviews: "pageviews",
  sessions: "sessions",
  completion_rate: "completion rate",
  cta_ctr: "CTA CTR",
  purchase_rate: "purchase rate",
  p75_dwell_ms: "p75 dwell"
};

/** Render one metric the way a human reads it: rates as percentages, dwell in seconds, counts plain. */
export const formatEngagementMetric = (metric: EngagementMetricKey, value: number): string => {
  if (metric === "p75_dwell_ms") return `${round(value / 1000, 1)}s`;
  if (metric === "pageviews" || metric === "sessions") return String(Math.round(value));
  return `${round(value * 100, 1)}%`;
};

/** "completion rate 12% vs site median 31%; CTA CTR 0.4% vs 1.9%" — the concrete comparison, in the
 * order that matters (worst shortfall first). Empty when there is nothing comparable. */
export function renderEngagementComparison(block: EngagementBlock): string {
  const median = block.siteMedian?.metrics ?? {};
  const ordered = [
    ...(block.belowMedian ?? []).map((shortfall) => shortfall.metric),
    ...ENGAGEMENT_COMPARABLE_KEYS.filter((metric) => !(block.belowMedian ?? []).some((shortfall) => shortfall.metric === metric))
  ];
  const parts: string[] = [];
  for (const metric of ordered) {
    const value = block[metric];
    const reference = median[metric];
    if (!isFinite_(value) || !isFinite_(reference)) continue;
    parts.push(`${METRIC_LABELS[metric]} ${formatEngagementMetric(metric, value)} vs site median ${formatEngagementMetric(metric, reference)}`);
  }
  return parts.join("; ");
}

/**
 * The engagement-evidence block for the reflective prompt. Deliberately phrased as MEASURED READER
 * BEHAVIOUR against the site's own median rather than as a score, because a reflector handed a number
 * with no reference point optimizes it as if it were another rubric criterion. Returns "" whenever
 * there is nothing above the floor to say — the caller then includes nothing at all.
 */
export function renderEngagementEvidence(block: EngagementBlock | undefined): string {
  if (!block || block.status !== "analyzed") return "";
  const comparison = renderEngagementComparison(block);
  if (!comparison) return "";
  const scale = [
    block.sessions !== undefined ? `${Math.round(block.sessions)} sessions` : undefined,
    block.pageviews !== undefined ? `${Math.round(block.pageviews)} pageviews` : undefined,
    `${block.n} rollup record${block.n === 1 ? "" : "s"}`
  ].filter(Boolean).join(", ");
  return [
    `Engagement evidence (${TRACKING_OUTCOME_SOURCE}, window ${block.window.from}..${block.window.to}; ${scale}), measured on PUBLISHED output and compared against the median of ${block.siteMedian?.n ?? 0} objects on the same site over the same window:`,
    `  ${comparison}.`,
    "This is what readers DID, not what a rubric scored. p75 dwell is a session-weighted mean of per-object p75s, not a true window percentile. Treat a shortfall here as evidence about the writing's pull on a reader — the opening, the promise it makes, the reason to keep going and to act — not as a rubric criterion to satisfy harder."
  ].join("\n");
}

/** Whether the node's RUBRIC evidence says it is doing fine — the precondition for the
 * good-rubric/bad-engagement cause. No evaluations at all is not "doing fine": with no rubric
 * evidence there is no claim to contradict, and the ordinary criterion path applies. */
export function rubricLooksHealthy(analysis: { sampleSize: number; meanScore?: number; passRate?: number }): boolean {
  if (analysis.sampleSize < 1) return false;
  if (!isFinite_(analysis.meanScore) || analysis.meanScore < RUBRIC_HEALTHY_MIN_MEAN_SCORE) return false;
  return analysis.passRate === undefined || analysis.passRate >= RUBRIC_HEALTHY_MIN_PASS_RATE;
}

export type EngagementDiagnosis = {
  cause: typeof ENGAGEMENT_CAUSE;
  /** The comparison, ready to read: "completion rate 12% vs site median 31%; …". */
  comparison: string;
  shortfalls: EngagementShortfall[];
  /** Full evidence-citing sentence for the proposal's rationale. */
  rationale: string;
};

/**
 * The diagnosis rubric evals structurally cannot produce: the node passes its written standard and
 * still loses the reader. Fires ONLY above the floor, ONLY with a real median to compare against, and
 * ONLY when the rubric itself is healthy — if the rubric is already unhappy, the criterion path owns
 * the diagnosis and this evidence rides along as context instead of becoming the named cause.
 */
export function diagnoseEngagement(
  analysis: { sampleSize: number; meanScore?: number; passRate?: number },
  block: EngagementBlock | undefined
): EngagementDiagnosis | undefined {
  if (!block || block.status !== "analyzed" || !block.belowMedian?.length) return undefined;
  if (!rubricLooksHealthy(analysis)) return undefined;
  const comparison = renderEngagementComparison(block);
  if (!comparison) return undefined;
  const rubricHealth = `rubric health is good (mean ${analysis.meanScore} over ${analysis.sampleSize} evaluation${analysis.sampleSize === 1 ? "" : "s"}${analysis.passRate === undefined ? "" : `, pass rate ${round(analysis.passRate * 100, 0)}%`})`;
  return {
    cause: ENGAGEMENT_CAUSE,
    comparison,
    shortfalls: block.belowMedian,
    rationale: `${ENGAGEMENT_CAUSE}: ${rubricHealth} but published engagement is below the site median — ${comparison} (${block.n} ${TRACKING_OUTCOME_SOURCE} record${block.n === 1 ? "" : "s"}, ${Math.round(block.sessions ?? 0)} sessions, window ${block.window.from}..${block.window.to}). A rubric evaluation cannot observe this: the artifact satisfies its written standard and still loses the reader.`
  };
}

export type EngagementBlockParams = {
  /** The node's feedback records; filtered to engagement outcomes inside the window here. */
  feedback: FeedbackRecord[];
  from?: string;
  to?: string;
  /** The sink partition to take the median from. Falls back to TRACKING_PROJECT_ID. */
  projectId?: string;
};

/**
 * Build the `engagement` block for one node, or return UNDEFINED and leave the optimizer exactly as
 * it was. Undefined means, in order: the sink connection is not configured on this deployment; the
 * node has no engagement records in the window; there is no project partition to read a median from;
 * or the sink could not answer. Never throws, never fabricates, and makes no network call at all
 * below the session floor.
 */
export async function buildEngagementBlock(params: EngagementBlockParams, deps: RollupFetchDeps = {}): Promise<EngagementBlock | undefined> {
  const env = deps.env ?? process.env;
  const connection = trackingSinkConnectionState(env);
  if (!connection.urlConfigured || !connection.tokenConfigured) return undefined;

  const records = engagementOutcomeRecords(params.feedback, params.from, params.to);
  if (!records.length) return undefined;

  const stamps = records.map((record) => record.createdAt).sort();
  const window = { from: params.from ?? stamps[0]!, to: params.to ?? stamps[stamps.length - 1]! };
  const measured = aggregateEngagement(records);
  const base: EngagementBlock = { status: "insufficient_data", source: TRACKING_OUTCOME_SOURCE, window, n: records.length, ...measured };

  // Below the floor nothing is diagnosed and nothing is fetched — the block exists purely to say so,
  // with the n it has, which is the difference between "no signal yet" and "signal says you are fine".
  if ((measured.sessions ?? 0) < ENGAGEMENT_MIN_SESSIONS) return base;

  const projectId = params.projectId?.trim() || env[TRACKING_PROJECT_ID_ENV]?.trim();
  if (!projectId) return undefined;
  const page = await fetchRollupRows({ by: "object", projectId, from: window.from, to: window.to }, deps);
  if (!page.ok || !page.rows.length) return undefined;

  const median = medianRollupMetrics(page.rows);
  return {
    ...base,
    status: "analyzed",
    siteMedian: { n: page.rows.length, metrics: median },
    belowMedian: engagementShortfalls(measured, median)
  };
}
