// Editorial strategy review (T21.37) — the first outer loop whose output is addressed to a HUMAN.
//
// WHAT WAS MISSING. T21.35 learns what KIND of piece works and writes the lesson into the per-node
// ACE playbooks of the writer and planning nodes. That changes how a brief is executed. It cannot
// change what the site DECIDES TO COMMISSION: the topic weights, the angle mix and the funnel-stage
// aggression that live on the governed `editorial_strategy` object are a human artefact, and nothing
// in the pipeline ever put evidence in front of the human who owns it. So a finding that has held up
// for weeks — "objection-first pieces hold attention twice as long" — could reshape every draft and
// still never reshape the plan.
//
// WHAT THIS DOES. Weekly, read two things:
//   * the `tracking:strategy.v1` observations T21.35 already writes (the cross-article grain), and
//   * the sink's `by=object` rollups for the window AND the window before it, grouped by funnel
//     stage and by topic, with the top and bottom performing object named inside each stage,
// and turn what has HELD UP into a proposed DELTA to that object: which topic weights to raise or
// lower, which angles to reach for or stop defaulting to, and where to push the offer harder or
// softer down the funnel.
//
// IT NEVER PATCHES. The output is a PROPOSAL: one `marginalia_create` thread on the strategy object
// itself — the tenant's own comment side-channel, which needs no lock and writes no body — carrying
// the delta and its evidence in the thread text, where the human who owns the object already works.
// Autonomous patching sits behind STRATEGY_REVIEW_AUTOPATCH, which is OFF by default and which
// nothing in this module turns on; the patch path is not built here at all, so there is no sequence
// of calls, flag or no flag, that mutates the object's body from this loop. See `autopatchState`.
//
// THE BAR IS T21.35'S BAR, UNCHANGED. A line only appears in the delta when its direction held
// across at least STRATEGY_PROMOTION_MIN_WINDOWS consecutive windows with STRATEGY_PROMOTION_MIN_N
// attributed events in EACH of them. For the angle mix that is exactly stableStrategySignals() — the
// same function that gates a playbook promotion. For topic weights and funnel-stage aggression,
// whose grain nobody has been recording over time, it is the same rule applied to two adjacent
// windows fetched side by side: same group, same direction, n >= 100 in both. One good week is a
// week, not a lesson — a proposal put in front of an editor has to be worth the read.
//
// NOTHING HERE THROWS. No observations, no sink, no `by=strategy` grain on this deployment, no
// configured strategy object, nothing over the bar, or a marginalia write the tenant refuses — every
// one of them ends as a named `no_proposal` result. A weekly schedule must be un-noisy on every day
// that has nothing to say.
//
// OUT OF SCOPE, DELIBERATELY. `append_scores` (doc 12 §15) is not built here. Variant judging stays
// with the optimizer's trial path. Neither is referenced by this module.
import {
  STRATEGY_COMPARABLE_KEYS,
  STRATEGY_METRIC_KEYS,
  STRATEGY_OBSERVATION_SOURCE,
  STRATEGY_PROMOTION_MIN_N,
  STRATEGY_PROMOTION_MIN_WINDOWS,
  renderStrategyFinding,
  stableStrategySignals,
  strategyFindings,
  strategySightingsFromObservations,
  strategySiteBaseline,
  strategySignalKeyOf,
  strategySubjectPhrase,
  strategyWindowKey,
  type StableStrategySignal,
  type StrategyComparableKey,
  type StrategyFinding,
  type StrategyGroup,
  type StrategyWindow
} from "./strategyLearning.js";
import { fetchRollupRows, metricsFromRow, trackingSinkConnectionState, type RollupFetchDeps } from "./trackingIngest.js";
import { isMcpErrorResult, describeMcpErrorResult } from "../projects/clientToolResult.js";
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import type { LearningObservation } from "../mcp/workspace/store.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";

// ── the operator policy flag ─────────────────────────────────────────────────

/**
 * THE POLICY FLAG. Autonomous patching of the governed strategy object is an operator decision, not
 * a code decision, so it is named here as an env var and read at call time — the same shape
 * autoPromote.ts's IMPROVEMENT_AUTO_PROMOTE has, for the same reason.
 *
 * It is OFF unless an operator sets it, and NOTHING in this commit sets it. Turning it on today
 * enables nothing: the patch path (checkout → patch → checkin on the strategy object) is not built
 * in this module, and the review reports `autopatch.applied: false` with a named reason in both flag
 * states. The flag exists so the eventual patch path has exactly one gate to be written behind, and
 * so an operator can see, in the run's own JSON, that it is off.
 */
export const STRATEGY_REVIEW_AUTOPATCH_ENV = "STRATEGY_REVIEW_AUTOPATCH";

const truthy = (value: string | undefined): boolean => /^(1|true|on|yes)$/i.test(value?.trim() ?? "");

export type AutopatchState = {
  /** The env var an operator would set. Reported so the flag never has to be grepped for. */
  flag: typeof STRATEGY_REVIEW_AUTOPATCH_ENV;
  enabled: boolean;
  /** Always false in this commit — see the module header and the constant's doc comment. */
  applied: false;
  reason: string;
};

export const strategyReviewAutopatchEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => truthy(env[STRATEGY_REVIEW_AUTOPATCH_ENV]);

/** The autopatch posture for one run: off by default, and inert even when on. */
export const autopatchState = (env: NodeJS.ProcessEnv = process.env): AutopatchState => {
  const enabled = strategyReviewAutopatchEnabled(env);
  return {
    flag: STRATEGY_REVIEW_AUTOPATCH_ENV,
    enabled,
    applied: false,
    reason: enabled
      ? `${STRATEGY_REVIEW_AUTOPATCH_ENV} is on, but this build has no autonomous patch path: the strategy review only ever proposes. The delta below is unapplied.`
      : `${STRATEGY_REVIEW_AUTOPATCH_ENV} is unset — autonomous patching is off. The delta below is a proposal for a human to accept, amend or reject.`
  };
};

// ── addressing the governed strategy object ──────────────────────────────────

/**
 * Where the governed `editorial_strategy` object lives, by env NAME.
 *
 * Deliberately configuration rather than a literal. The tenant MCP's `object_type` is a closed enum
 * of governed types and the reviewed object's type/id differ per tenant, so hard-coding either would
 * either fabricate a type the tenant does not serve or pin every tenant to one id. With any of the
 * three unset the run is a clean `no_strategy_object` no-op that NAMES the unset variables — the same
 * posture an unconfigured tracking sink gets.
 */
export const STRATEGY_OBJECT_PROJECT_ID_ENV = "EDITORIAL_STRATEGY_PROJECT_ID";
export const STRATEGY_OBJECT_TYPE_ENV = "EDITORIAL_STRATEGY_OBJECT_TYPE";
export const STRATEGY_OBJECT_ID_ENV = "EDITORIAL_STRATEGY_OBJECT_ID";

export type StrategyObjectRef = { projectId: string; objectType: string; objectId: string };
export type StrategyObjectRefState = { configured: boolean; missing: string[]; ref?: StrategyObjectRef };

/** Env-name-only view of the strategy object address; never returns an env var's VALUE for anything
 * but the (non-secret) object coordinates the proposal is addressed to. */
export function strategyObjectRefState(env: NodeJS.ProcessEnv = process.env): StrategyObjectRefState {
  const projectId = env[STRATEGY_OBJECT_PROJECT_ID_ENV]?.trim();
  const objectType = env[STRATEGY_OBJECT_TYPE_ENV]?.trim();
  const objectId = env[STRATEGY_OBJECT_ID_ENV]?.trim();
  const missing = [
    projectId ? undefined : STRATEGY_OBJECT_PROJECT_ID_ENV,
    objectType ? undefined : STRATEGY_OBJECT_TYPE_ENV,
    objectId ? undefined : STRATEGY_OBJECT_ID_ENV
  ].filter((name): name is string => Boolean(name));
  if (missing.length || !projectId || !objectType || !objectId) return { configured: false, missing };
  return { configured: true, missing: [], ref: { projectId, objectType, objectId } };
}

// ── the object grain: funnel stage and topic ─────────────────────────────────

const isFinite_ = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number, digits: number): number => Number(value.toFixed(digits));
const asLabel = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Read one label off a rollup row in any of the spellings a sink might use, including a nested
 * `object` envelope. Never invents a value: a row that carries none is not put in a bucket. */
const rowLabel = (row: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  const nested = isRecord(row.object) ? row.object : {};
  for (const key of keys) {
    const camel = key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
    const value = asLabel(row[key]) ?? asLabel(row[camel]) ?? asLabel(nested[key]) ?? asLabel(nested[camel]);
    if (value) return value;
  }
  return undefined;
};

/** The funnel stage an object row belongs to. */
export const funnelStageOf = (row: Record<string, unknown>): string | undefined => rowLabel(row, ["funnel_stage", "stage", "funnel"]);
/** The topic an object row belongs to. */
export const topicOf = (row: Record<string, unknown>): string | undefined => rowLabel(row, ["topic", "primary_topic", "topic_id", "taxonomy_term"]);
/** How a single object is NAMED in the evidence. Whatever identity the row carried, in preference
 * order; a row with no identity at all is still counted, it just cannot be cited by name. */
export const objectLabelOf = (row: Record<string, unknown>): string | undefined => rowLabel(row, ["slug", "object_id", "id", "title", "path", "url"]);

/**
 * The row's raw attributed-event count. `sessions` is deliberately NOT accepted as a substitute:
 * T21.35's bar is the count the RATES were computed from, and quietly swapping in a different
 * denominator here would make this loop's "n >= 100" a different, weaker claim than the one the
 * proposal text cites. A row that states no count contributes 0 to the bar.
 */
export const rowEventCount = (row: Record<string, unknown>): number => {
  const raw = row.n ?? row.count ?? row.event_count ?? (row as { eventCount?: unknown }).eventCount;
  const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  return isFinite_(value) && value > 0 ? value : 0;
};

/**
 * Collapse object rows into one group per label, with the same arithmetic strategyGroupsFromRows
 * uses on the strategy grain: counts sum, rates and dwell are n-weighted means, a metric no row
 * reported is ABSENT rather than zero. Rows carrying no label for this dimension are skipped — an
 * "unknown" bucket is a fabricated group.
 */
export function groupObjectRows(rows: Array<Record<string, unknown>>, labelOf: (row: Record<string, unknown>) => string | undefined): Map<string, StrategyGroup> {
  type Accumulator = StrategyGroup & { weighted: Map<string, { total: number; weight: number }> };
  const groups = new Map<string, Accumulator>();
  for (const row of rows) {
    const label = labelOf(row);
    if (!label) continue;
    const group: Accumulator = groups.get(label) ?? { n: 0, days: 0, metrics: {}, weighted: new Map() };
    const n = rowEventCount(row);
    const weight = n > 0 ? n : 1;
    group.n += n;
    group.days += 1;
    const metrics = metricsFromRow(row, STRATEGY_METRIC_KEYS);
    for (const metricKey of STRATEGY_METRIC_KEYS) {
      const value = metrics[metricKey];
      if (!isFinite_(value)) continue;
      if (metricKey === "pageviews" || metricKey === "exposures" || metricKey === "sessions" || metricKey === "revenue_cents") {
        group.metrics[metricKey] = (group.metrics[metricKey] ?? 0) + value;
      } else {
        const bucket = group.weighted.get(metricKey) ?? { total: 0, weight: 0 };
        bucket.total += value * weight;
        bucket.weight += weight;
        group.weighted.set(metricKey, bucket);
      }
    }
    groups.set(label, group);
  }
  const out = new Map<string, StrategyGroup>();
  for (const [label, accumulator] of groups) {
    const { weighted, ...group } = accumulator;
    for (const [metricKey, bucket] of weighted) {
      if (bucket.weight > 0) group.metrics[metricKey as StrategyComparableKey] = round(bucket.total / bucket.weight, metricKey === "p75_dwell_ms" ? 0 : 6);
    }
    out.set(label, group);
  }
  return out;
}

/**
 * The best and worst single object inside one group, on one metric — the "top and bottom content"
 * an editor asks for as soon as they read a stage-level claim. Rows that do not report the metric
 * are not ranked; a group with fewer than two ranked rows yields only what it has.
 */
export type RankedObject = { label?: string; value: number; n: number };
export function topAndBottomObjects(
  rows: Array<Record<string, unknown>>,
  labelOf: (row: Record<string, unknown>) => string | undefined,
  groupLabel: string,
  metric: StrategyComparableKey
): { top?: RankedObject; bottom?: RankedObject; ranked: number } {
  const ranked = rows
    .filter((row) => labelOf(row) === groupLabel)
    .map((row) => ({ label: objectLabelOf(row), value: metricsFromRow(row, [metric])[metric], n: rowEventCount(row) }))
    .filter((entry) => isFinite_(entry.value))
    .sort((a, b) => b.value - a.value);
  if (!ranked.length) return { ranked: 0 };
  return { top: ranked[0], bottom: ranked.length > 1 ? ranked[ranked.length - 1] : undefined, ranked: ranked.length };
}

// ── the delta ────────────────────────────────────────────────────────────────

export type StrategyDeltaDimension = "topic_weight" | "angle_mix" | "funnel_aggression";
export type StrategyDeltaDirection = "increase" | "decrease";

export type StrategyDeltaLine = {
  dimension: StrategyDeltaDimension;
  /** The thing the line is about: a topic id, a funnel stage, or the angle's subject phrase. */
  subject: string;
  direction: StrategyDeltaDirection;
  /** The strongest finding behind the line, in the most recent window. */
  driver: StrategyFinding;
  /** Consecutive windows the direction held (always >= STRATEGY_PROMOTION_MIN_WINDOWS). */
  windows: number;
  /** Summed attributed-event count across those windows (each of which cleared the n bar on its own). */
  n: number;
  /** The window the streak ends at. */
  through: string;
  /** Every fact a human needs to audit the line, already rendered. */
  evidence: string[];
  /** For angle-mix lines: the `tracking:strategy.v1` observation ids the line rests on. */
  observationIds?: string[];
};

export type StrategyDelta = {
  topicWeights: StrategyDeltaLine[];
  angleMix: StrategyDeltaLine[];
  funnelAggression: StrategyDeltaLine[];
};

const emptyDelta = (): StrategyDelta => ({ topicWeights: [], angleMix: [], funnelAggression: [] });
export const deltaLineCount = (delta: StrategyDelta): number => delta.topicWeights.length + delta.angleMix.length + delta.funnelAggression.length;

/** What was SEEN but did not clear the bar. Printed in the proposal so "not proposed" is a stated
 * fact with a number beside it, not a silence a reader has to interpret. */
export type BelowBarNote = { dimension: StrategyDeltaDimension; subject: string; reason: string };

const directionOf = (finding: StrategyFinding): StrategyDeltaDirection => (finding.direction === "above" ? "increase" : "decrease");

/** Biggest gap first, on the same |log ratio| ordering strategyFindings uses. */
const strongest = (findings: StrategyFinding[]): StrategyFinding | undefined =>
  [...findings].sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))[0];

/** The conversion half of the comparable set — the metrics a funnel stage's AGGRESSION moves. A
 * completion or dwell difference says the piece was read, not that the offer was pushed too hard. */
export const FUNNEL_AGGRESSION_METRICS: readonly StrategyComparableKey[] = ["purchase_rate", "buy_click_rate", "cta_ctr"];
/** The reader-behaviour half, carried as counter-evidence beside an aggression line. */
export const FUNNEL_RETENTION_METRICS: readonly StrategyComparableKey[] = ["completion_rate", "p75_dwell_ms"];

// ── angle mix, from T21.35's own observations ────────────────────────────────

type ObservationSighting = { observationId: string; signalKey: string; windowKey: string; windowTo: string };

/**
 * Index the stored `tracking:strategy.v1` observations by signal and window, so a promoted signal
 * can cite the exact entries it rests on. Reads the same structured metadata
 * strategySightingsFromObservations reads (never the rendered sentence), and keeps the observation
 * id that function has no reason to carry.
 */
export function observationSightings(observations: LearningObservation[], projectId?: string): ObservationSighting[] {
  const out: ObservationSighting[] = [];
  for (const observation of observations) {
    const metadata = isRecord(observation.metadata) ? observation.metadata : {};
    if (metadata.source !== STRATEGY_OBSERVATION_SOURCE) continue;
    if (projectId && asLabel(metadata.projectId) !== projectId) continue;
    const window = metadata.window as StrategyWindow | undefined;
    if (!window || !asLabel(window.from) || !asLabel(window.to)) continue;
    const strategy = asLabel(metadata.strategy);
    const intent = asLabel(metadata.intent);
    if (!strategy && !intent) continue;
    for (const finding of Array.isArray(metadata.findings) ? (metadata.findings as StrategyFinding[]) : []) {
      if (!finding || !STRATEGY_COMPARABLE_KEYS.includes(finding.metric)) continue;
      out.push({
        observationId: observation.id,
        signalKey: strategySignalKeyOf({ ...(strategy ? { strategy } : {}), ...(intent ? { intent } : {}), metric: finding.metric }),
        windowKey: strategyWindowKey(window),
        windowTo: window.to
      });
    }
  }
  return out;
}

/** The observation ids behind one stable signal: its newest `windows` distinct windows, ending at
 * `through`. Exactly the streak stableStrategySignals walked back over. */
export function citedObservationIds(signal: StableStrategySignal, sightings: ObservationSighting[]): string[] {
  const key = strategySignalKeyOf(signal);
  const mine = sightings.filter((sighting) => sighting.signalKey === key && sighting.windowTo <= signal.through);
  const windows = [...new Set(mine.map((sighting) => sighting.windowKey))].sort().slice(-signal.windows);
  return mine.filter((sighting) => windows.includes(sighting.windowKey)).map((sighting) => sighting.observationId);
}

/** One angle-mix line per stable strategy signal — the same signals, at the same bar, that T21.35
 * would promote into a playbook. Nothing new is computed; the evidence is restated for a reader. */
export function angleMixLines(signals: StableStrategySignal[], sightings: ObservationSighting[]): StrategyDeltaLine[] {
  return signals
    .map((signal) => {
      const observationIds = citedObservationIds(signal, sightings);
      return {
        dimension: "angle_mix" as const,
        subject: strategySubjectPhrase(signal),
        direction: directionOf(signal.latest),
        driver: signal.latest,
        windows: signal.windows,
        n: Math.round(signal.n),
        through: signal.through,
        evidence: [
          `${renderStrategyFinding(signal.latest)} in the window ending ${signal.through} (group ${signal.latest.value} vs site ${signal.latest.siteFigure}, ratio ${signal.latest.ratio}×).`,
          `Held the same direction across ${signal.windows} consecutive observed windows, n=${Math.round(signal.n)} in total, each window at or above the n>=${STRATEGY_PROMOTION_MIN_N} bar.`,
          observationIds.length
            ? `Observations: ${observationIds.join(", ")} (source ${STRATEGY_OBSERVATION_SOURCE}).`
            : `Observations: source ${STRATEGY_OBSERVATION_SOURCE} (no entry ids recorded on the stored metadata).`
        ],
        observationIds
      };
    })
    .sort((a, b) => Math.abs(Math.log(b.driver.ratio)) - Math.abs(Math.log(a.driver.ratio)));
}

// ── topic weights and funnel aggression, from two adjacent object windows ────

export type ObjectWindowSlice = { window: StrategyWindow; rows: Array<Record<string, unknown>> };

type DimensionSpec = {
  dimension: StrategyDeltaDimension;
  labelOf: (row: Record<string, unknown>) => string | undefined;
  /** Metrics the line's DIRECTION may be decided from. */
  driverMetrics: readonly StrategyComparableKey[];
  /** Metrics reported alongside but never used to decide direction. */
  contextMetrics: readonly StrategyComparableKey[];
  noun: string;
};

const TOPIC_SPEC: DimensionSpec = { dimension: "topic_weight", labelOf: topicOf, driverMetrics: STRATEGY_COMPARABLE_KEYS, contextMetrics: [], noun: "topic" };
const FUNNEL_SPEC: DimensionSpec = { dimension: "funnel_aggression", labelOf: funnelStageOf, driverMetrics: FUNNEL_AGGRESSION_METRICS, contextMetrics: FUNNEL_RETENTION_METRICS, noun: "funnel stage" };

const renderRanked = (entry: RankedObject | undefined, metric: StrategyComparableKey): string =>
  entry ? `${entry.label ?? "an object the sink did not name"} (${metric} ${entry.value}, n=${Math.round(entry.n)})` : "none reported";

/**
 * Lines for one dimension, from the CURRENT window and the one before it.
 *
 * The bar is T21.35's, applied to a grain nobody has been recording over time: the same group, the
 * same metric, the same direction, in BOTH windows, each at or above n >= STRATEGY_PROMOTION_MIN_N.
 * Two adjacent windows is exactly STRATEGY_PROMOTION_MIN_WINDOWS; a longer history would need a
 * stored series, which this loop deliberately does not invent.
 *
 * Everything that was seen and did not clear the bar comes back in `belowBar` with the number that
 * failed it — a proposal that hides its near-misses is not auditable.
 */
export function dimensionLines(
  spec: DimensionSpec,
  current: ObjectWindowSlice,
  prior: ObjectWindowSlice | undefined
): { lines: StrategyDeltaLine[]; belowBar: BelowBarNote[] } {
  const lines: StrategyDeltaLine[] = [];
  const belowBar: BelowBarNote[] = [];
  const currentGroups = groupObjectRows(current.rows, spec.labelOf);
  if (!currentGroups.size) return { lines, belowBar };

  if (!prior) {
    for (const label of currentGroups.keys()) {
      belowBar.push({ dimension: spec.dimension, subject: label, reason: `only one window was readable (${strategyWindowKey(current.window)}); the bar is ${STRATEGY_PROMOTION_MIN_WINDOWS} consecutive windows.` });
    }
    return { lines, belowBar };
  }

  const priorGroups = groupObjectRows(prior.rows, spec.labelOf);
  const currentBaseline = strategySiteBaseline(current.rows);
  const priorBaseline = strategySiteBaseline(prior.rows);

  for (const [label, group] of currentGroups) {
    const previous = priorGroups.get(label);
    if (!previous) {
      belowBar.push({ dimension: spec.dimension, subject: label, reason: `absent from the prior window ${strategyWindowKey(prior.window)}; the bar is ${STRATEGY_PROMOTION_MIN_WINDOWS} consecutive windows.` });
      continue;
    }
    if (group.n < STRATEGY_PROMOTION_MIN_N || previous.n < STRATEGY_PROMOTION_MIN_N) {
      belowBar.push({ dimension: spec.dimension, subject: label, reason: `n=${Math.round(group.n)} this window and n=${Math.round(previous.n)} the window before; the bar is n>=${STRATEGY_PROMOTION_MIN_N} in each.` });
      continue;
    }

    const currentFindings = strategyFindings(group, currentBaseline);
    const priorFindings = strategyFindings(previous, priorBaseline);
    const held = currentFindings.filter((finding) => {
      if (!spec.driverMetrics.includes(finding.metric)) return false;
      return priorFindings.some((earlier) => earlier.metric === finding.metric && earlier.direction === finding.direction);
    });
    const driver = strongest(held);
    if (!driver) {
      belowBar.push({ dimension: spec.dimension, subject: label, reason: `no metric held the same direction in both windows (${currentFindings.length} material difference(s) this window, ${priorFindings.length} the window before).` });
      continue;
    }

    const priorDriver = priorFindings.find((finding) => finding.metric === driver.metric)!;
    const rank = topAndBottomObjects(current.rows, spec.labelOf, label, driver.metric);
    const context = currentFindings.filter((finding) => spec.contextMetrics.includes(finding.metric));

    lines.push({
      dimension: spec.dimension,
      subject: label,
      direction: directionOf(driver),
      driver,
      windows: STRATEGY_PROMOTION_MIN_WINDOWS,
      n: Math.round(group.n + previous.n),
      through: current.window.to,
      evidence: [
        `${renderStrategyFinding(driver)} in ${strategyWindowKey(current.window)} (${driver.value} vs site ${driver.siteFigure}, ratio ${driver.ratio}×, n=${Math.round(group.n)}).`,
        `Same direction in ${strategyWindowKey(prior.window)}: ${renderStrategyFinding(priorDriver)} (${priorDriver.value} vs site ${priorDriver.siteFigure}, ratio ${priorDriver.ratio}×, n=${Math.round(previous.n)}).`,
        `Top content in this ${spec.noun} this window: ${renderRanked(rank.top, driver.metric)}. Bottom: ${renderRanked(rank.bottom, driver.metric)}. ${rank.ranked} object(s) ranked on ${driver.metric}.`,
        ...(context.length ? [`Alongside it this window: ${context.map(renderStrategyFinding).join(", ")}.`] : [])
      ]
    });
  }

  return {
    lines: lines.sort((a, b) => Math.abs(Math.log(b.driver.ratio)) - Math.abs(Math.log(a.driver.ratio))),
    belowBar
  };
}

// ── the proposal text ────────────────────────────────────────────────────────

const DIRECTION_VERB: Record<StrategyDeltaDimension, Record<StrategyDeltaDirection, string>> = {
  topic_weight: { increase: "Raise the weight on topic", decrease: "Lower the weight on topic" },
  angle_mix: { increase: "Give more of the mix to", decrease: "Give less of the mix to" },
  funnel_aggression: { increase: "Push harder at funnel stage", decrease: "Ease off at funnel stage" }
};

const renderLine = (line: StrategyDeltaLine): string =>
  [`- ${DIRECTION_VERB[line.dimension][line.direction]} ${line.subject}.`, ...line.evidence.map((entry) => `  ${entry}`)].join("\n");

const SECTIONS: Array<{ heading: string; pick: (delta: StrategyDelta) => StrategyDeltaLine[] }> = [
  { heading: "TOPIC WEIGHTS", pick: (delta) => delta.topicWeights },
  { heading: "ANGLE MIX", pick: (delta) => delta.angleMix },
  { heading: "FUNNEL-STAGE AGGRESSION", pick: (delta) => delta.funnelAggression }
];

/**
 * THE PROPOSAL TEMPLATE — the whole of what a human sees, in the marginalia thread itself.
 *
 *   Editorial strategy review — proposal (nothing has been changed)
 *   <window line>
 *   <autopatch line>
 *
 *   TOPIC WEIGHTS / ANGLE MIX / FUNNEL-STAGE AGGRESSION
 *   - <verb> <subject>.
 *     <evidence line>
 *     …
 *
 *   Bar: …
 *   Not proposed (seen, below the bar): …
 *
 * Every claim carries its window, its ratio and its n on the same line, because a proposal a human
 * cannot audit inside the thread is not a proposal — it is an instruction with a citation elsewhere.
 */
export function renderStrategyProposal(params: {
  delta: StrategyDelta;
  window: StrategyWindow;
  priorWindow?: StrategyWindow;
  belowBar: BelowBarNote[];
  autopatch: AutopatchState;
  objectRef: StrategyObjectRef;
}): string {
  const { delta, window, priorWindow, belowBar, autopatch, objectRef } = params;
  const parts: string[] = [
    "Editorial strategy review — proposal (nothing has been changed)",
    "",
    `Object: ${objectRef.objectType}/${objectRef.objectId} on project ${objectRef.projectId}.`,
    `Window ${strategyWindowKey(window)}${priorWindow ? `, compared against ${strategyWindowKey(priorWindow)}` : " (no prior window was readable)"}.`,
    `Evidence: ${STRATEGY_OBSERVATION_SOURCE} observations (angle mix) and the tracking sink's by=object rollups grouped by topic and funnel stage.`,
    autopatch.reason
  ];
  for (const section of SECTIONS) {
    const lines = section.pick(delta);
    if (!lines.length) continue;
    parts.push("", section.heading, ...lines.map(renderLine));
  }
  parts.push(
    "",
    `Bar: every line above held the same direction across at least ${STRATEGY_PROMOTION_MIN_WINDOWS} consecutive windows with n>=${STRATEGY_PROMOTION_MIN_N} attributed events in each — the same bar T21.35 uses before a finding may change a node's playbook.`
  );
  if (belowBar.length) {
    parts.push("", "Not proposed (seen, below the bar):", ...belowBar.map((note) => `- ${note.subject} [${note.dimension}]: ${note.reason}`));
  }
  return parts.join("\n");
}

// ── the review ───────────────────────────────────────────────────────────────

/** Why a run produced no proposal. Each value is a fact about the world, not a failure. */
export type StrategyReviewSkipReason =
  | "sink_unconfigured"
  | "grain_unavailable"
  | "no_strategy_object"
  | "no_rows"
  | "no_observations"
  | "below_stability_bar"
  | "marginalia_write_failed";

/**
 * The Slack seam. This repo has NO Slack path today — there is no webhook client, no notifier and no
 * Slack config anywhere in `src/`, and building one is explicitly not this task's job. So the
 * notification is a dependency: when a Slack path lands, it is passed in here and the proposal is
 * announced; until then every run reports `attempted: false` with that as its stated reason and
 * still succeeds. A notifier that throws is caught — an announcement failing must never turn a
 * written proposal into a failed run.
 */
export type StrategyReviewNotifier = (message: { text: string; objectRef: StrategyObjectRef; threadId?: string }) => Promise<void> | void;
export type NotificationState = { attempted: boolean; delivered: boolean; reason: string };

export const NO_SLACK_PATH_REASON = "no Slack path is configured in this repo; nothing to notify. The proposal stands on its own in the marginalia thread.";

export type MarginaliaState = { attempted: boolean; ok: boolean; tool: "marginalia_create"; threadId?: string; error?: string };

export type StrategyReviewResult = {
  status: "proposed" | "no_proposal";
  reason?: StrategyReviewSkipReason;
  /** Human sentence for `reason`, always present when there is a reason. */
  detail?: string;
  window: StrategyWindow;
  priorWindow?: StrategyWindow;
  /** Rows the sink returned per window, so "no lines" can be told from "no data". */
  rows: { current: number; prior: number };
  observations: number;
  delta: StrategyDelta;
  belowBar: BelowBarNote[];
  proposalText?: string;
  marginalia?: MarginaliaState;
  notification: NotificationState;
  autopatch: AutopatchState;
  errors: Array<{ scope: string; error: string }>;
};

export type StrategyReviewParams = {
  /** The tracking partition (the sink's TRACKING_PROJECT_ID) — NOT the CMS project id. */
  projectId: string;
  from: string;
  to: string;
};

export type StrategyReviewDeps = RollupFetchDeps & {
  learningRepository: LearningRepository;
  projectRepository: ProjectRepository;
  /** Test seam and future transport swap. Defaults to the tenant MCP through ProjectMcpAdapter. */
  callProjectTool?: (ref: StrategyObjectRef, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Absent by default — see StrategyReviewNotifier. */
  notify?: StrategyReviewNotifier;
};

const GRAIN_UNAVAILABLE_STATUS = 503;

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The window of equal length immediately before this one. Used to apply the two-window half of the
 * bar to a grain with no stored history. An unparseable window yields none, and the run then reports
 * every group as below the bar rather than guessing at adjacency.
 */
export function precedingWindow(window: StrategyWindow): StrategyWindow | undefined {
  const from = Date.parse(`${window.from}T00:00:00Z`);
  const to = Date.parse(`${window.to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return undefined;
  const span = to - from;
  return { from: isoDay(new Date(from - span)), to: window.from };
}

const defaultCallProjectTool = (projectRepository: ProjectRepository) =>
  async (ref: StrategyObjectRef, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    const config = await projectRepository.get(ref.projectId);
    if (!config) return { ok: false, error: `unknown_project: no registered project "${ref.projectId}" to reach the strategy object through.` };
    const call = await new ProjectMcpAdapter(config).callTool(tool, args);
    return call.ok ? { ok: true, result: call.result } : { ok: false, error: call.error ?? `${tool} failed` };
  };

/** The thread id out of whatever envelope the tenant used. Absent is fine — the proposal is written
 * either way, and a missing id is never reported as a failure. */
const threadIdOf = (result: unknown): string | undefined => {
  const raw = isRecord(result) ? result : {};
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : {};
  const thread = isRecord(structured.thread) ? structured.thread : isRecord(raw.thread) ? raw.thread : {};
  return asLabel(thread.thread_id) ?? asLabel(thread.threadId) ?? asLabel(thread.id) ?? asLabel(structured.thread_id) ?? asLabel(structured.threadId);
};

const emptyResult = (window: StrategyWindow, env: NodeJS.ProcessEnv): StrategyReviewResult => ({
  status: "no_proposal",
  window,
  rows: { current: 0, prior: 0 },
  observations: 0,
  delta: emptyDelta(),
  belowBar: [],
  notification: { attempted: false, delivered: false, reason: NO_SLACK_PATH_REASON },
  autopatch: autopatchState(env),
  errors: []
});

/**
 * The weekly pass.
 *
 * Read the `tracking:strategy.v1` observations and the sink's `by=object` rollups for this window
 * and the one before it, keep only what cleared T21.35's bar, and — if anything did — open ONE
 * marginalia thread on the governed strategy object carrying the delta and its evidence.
 *
 * NEVER throws. Every way this can produce nothing is a named `no_proposal`:
 *   sink_unconfigured   — TRACKING_SINK_URL / TRACKING_SINK_TOKEN unset on this deployment.
 *   grain_unavailable   — the sink answered 503 (a grain not migrated here yet).
 *   no_strategy_object  — the EDITORIAL_STRATEGY_* address is not configured.
 *   no_rows             — the sink answered, with nothing in the window.
 *   no_observations     — nothing has ever been recorded at the strategy grain for this partition.
 *   below_stability_bar — things were seen; none held up. `belowBar` says which, with the numbers.
 *   marginalia_write_failed — the delta stands, the tenant refused the thread. Nothing else ran.
 */
export async function reviewEditorialStrategy(params: StrategyReviewParams, deps: StrategyReviewDeps): Promise<StrategyReviewResult> {
  const env = deps.env ?? process.env;
  const window: StrategyWindow = { from: params.from.slice(0, 10), to: params.to.slice(0, 10) };
  const result = emptyResult(window, env);

  const connection = trackingSinkConnectionState(env);
  if (!connection.urlConfigured || !connection.tokenConfigured) {
    result.reason = "sink_unconfigured";
    result.detail = `The tracking sink is not configured (${connection.urlEnvVar} / ${connection.tokenEnvVar}) — no-op, not a failure.`;
    return result;
  }

  const objectRefState = strategyObjectRefState(env);
  if (!objectRefState.ref) {
    result.reason = "no_strategy_object";
    result.detail = `No governed strategy object to propose against (${objectRefState.missing.join(", ")} unset) — no-op, not a failure. Setting these is an operator task.`;
    return result;
  }
  const objectRef = objectRefState.ref;

  // ── evidence: the strategy observations ──
  let observations: LearningObservation[] = [];
  try {
    observations = await deps.learningRepository.listObservations();
  } catch (error) {
    result.errors.push({ scope: "observations", error: error instanceof Error ? error.message : String(error) });
  }
  const sightings = strategySightingsFromObservations(observations, params.projectId);
  result.observations = sightings.length;
  const stable = stableStrategySignals(sightings);
  const angleLines = angleMixLines(stable, observationSightings(observations, params.projectId));
  for (const sighting of sightings) {
    if (sighting.n >= STRATEGY_PROMOTION_MIN_N) continue;
    result.belowBar.push({ dimension: "angle_mix", subject: strategySubjectPhrase(sighting), reason: `n=${Math.round(sighting.n)} in ${strategyWindowKey(sighting.window)}; the bar is n>=${STRATEGY_PROMOTION_MIN_N}.` });
  }

  // ── evidence: the object grain, this window and the one before it ──
  const priorWindow = precedingWindow(window);
  result.priorWindow = priorWindow;

  const currentPage = await fetchRollupRows({ by: "object", projectId: params.projectId, from: window.from, to: window.to }, deps);
  if (!currentPage.ok) {
    if (currentPage.status === GRAIN_UNAVAILABLE_STATUS) {
      result.reason = "grain_unavailable";
      result.detail = "The tracking sink's by=object grain answered 503 — not deployed on this tenant's sink yet. No-op, not a failure.";
      return result;
    }
    result.errors.push({ scope: "rollups:current", error: currentPage.error });
  }
  const currentSlice: ObjectWindowSlice = { window, rows: currentPage.ok ? currentPage.rows : [] };
  result.rows.current = currentSlice.rows.length;

  let priorSlice: ObjectWindowSlice | undefined;
  if (priorWindow) {
    const priorPage = await fetchRollupRows({ by: "object", projectId: params.projectId, from: priorWindow.from, to: priorWindow.to }, deps);
    if (priorPage.ok) {
      priorSlice = { window: priorWindow, rows: priorPage.rows };
      result.rows.prior = priorPage.rows.length;
    } else if (priorPage.status !== GRAIN_UNAVAILABLE_STATUS) {
      // A prior window we could not read is an absence of evidence, never counter-evidence: the
      // object-grain lines simply do not clear the two-window half of the bar this run.
      result.errors.push({ scope: "rollups:prior", error: priorPage.error });
    }
  }

  const topic = dimensionLines(TOPIC_SPEC, currentSlice, priorSlice);
  const funnel = dimensionLines(FUNNEL_SPEC, currentSlice, priorSlice);
  result.delta = { topicWeights: topic.lines, angleMix: angleLines, funnelAggression: funnel.lines };
  result.belowBar.push(...topic.belowBar, ...funnel.belowBar);

  if (!deltaLineCount(result.delta)) {
    if (!sightings.length && !currentSlice.rows.length) {
      result.reason = currentPage.ok ? "no_rows" : "no_observations";
      result.detail = currentPage.ok
        ? `The sink returned no by=object rows for ${strategyWindowKey(window)} and no ${STRATEGY_OBSERVATION_SOURCE} observations exist for partition "${params.projectId}". Nothing to review.`
        : `No ${STRATEGY_OBSERVATION_SOURCE} observations exist for partition "${params.projectId}" and the by=object rollups could not be read. Nothing to review.`;
      return result;
    }
    if (!sightings.length && !result.belowBar.length) {
      result.reason = "no_observations";
      result.detail = `No ${STRATEGY_OBSERVATION_SOURCE} observations exist for partition "${params.projectId}" yet — T21.35's daily pass has recorded nothing to review.`;
      return result;
    }
    result.reason = "below_stability_bar";
    result.detail = `Nothing held up: ${result.belowBar.length} candidate(s) were seen and none cleared the bar (the same direction across >=${STRATEGY_PROMOTION_MIN_WINDOWS} consecutive windows at n>=${STRATEGY_PROMOTION_MIN_N} each). No proposal was written. See belowBar for each candidate and the number that failed it.`;
    return result;
  }

  // ── the proposal ──
  const proposalText = renderStrategyProposal({ delta: result.delta, window, priorWindow: priorSlice?.window, belowBar: result.belowBar, autopatch: result.autopatch, objectRef });
  result.proposalText = proposalText;

  const call = deps.callProjectTool ?? defaultCallProjectTool(deps.projectRepository);
  let marginalia: MarginaliaState = { attempted: true, ok: false, tool: "marginalia_create" };
  try {
    const response = await call(objectRef, "marginalia_create", { object_type: objectRef.objectType, object_id: objectRef.objectId, body: proposalText });
    if (!response.ok) {
      marginalia = { ...marginalia, error: response.error ?? "marginalia_create failed" };
    } else if (isMcpErrorResult(response.result)) {
      // The transport succeeded and the CLIENT refused — quoted through the one reader this repo has
      // for that, never re-worded and never trusted as an instruction.
      marginalia = { ...marginalia, error: `client_refused: ${describeMcpErrorResult(response.result as Record<string, unknown>)}` };
    } else {
      marginalia = { ...marginalia, ok: true, ...(threadIdOf(response.result) ? { threadId: threadIdOf(response.result) } : {}) };
    }
  } catch (error) {
    marginalia = { ...marginalia, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  result.marginalia = marginalia;

  if (!marginalia.ok) {
    result.reason = "marginalia_write_failed";
    result.detail = `The delta was computed but the proposal could not be written to ${objectRef.objectType}/${objectRef.objectId}: ${marginalia.error}. Nothing else ran; the strategy object is untouched.`;
    return result;
  }

  // ── the announcement (optional, and never load-bearing) ──
  if (deps.notify) {
    try {
      await deps.notify({ text: proposalText, objectRef, ...(marginalia.threadId ? { threadId: marginalia.threadId } : {}) });
      result.notification = { attempted: true, delivered: true, reason: "announced through the notifier this deployment supplied." };
    } catch (error) {
      result.notification = { attempted: true, delivered: false, reason: `the notifier failed (${error instanceof Error ? error.name : typeof error}); the proposal itself was written.` };
    }
  }

  result.status = "proposed";
  return result;
}
