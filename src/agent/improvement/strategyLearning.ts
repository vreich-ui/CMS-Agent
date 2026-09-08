// Strategy-level learning (T21.35) — the third and last thing the tracking sink can teach, and the
// only one that outlives a single piece of content.
//
// WHAT WAS MISSING. The two existing outer loops are both PER-ARTIFACT. T21.7 pulls `by=producer`
// rollups and files them as feedback outcomes against the node/run that made one object; T21.22 reads
// those back and tells one node it is below the site median. Both answer "how did THIS do?". Neither
// can answer the question an editor actually asks — "what KIND of piece works here?" — because
// nothing in the pipeline ever grouped published performance by the STRATEGY and INTENT the piece was
// written to. A finding like "the pieces that open on the reader's objection hold attention twice as
// long" is invisible to a per-object view no matter how many objects it sees.
//
// WHAT THIS DOES. Pull the sink's `by=strategy` grain (one row per strategy/intent/day), aggregate it
// per strategy/intent over the window, compare each group against the SITE-WIDE figure for the SAME
// window, and write the material differences down as `learning_record_observation` entries with
// source `tracking:strategy.v1`. Then — and only when a finding has held up — promote it into the
// per-node ACE playbooks of the writer and planning nodes, through the same applyPlaybookDelta the
// curator uses.
//
// THE BAR FOR TEACHING SOMETHING. An observation is cheap; a playbook item changes what every future
// piece is written to. So promotion needs BOTH:
//   * n >= STRATEGY_PROMOTION_MIN_N — the sink's own raw attributed-event count for the group, NOT
//     sessions. A rate computed off 12 events is a rumour.
//   * the same direction in >= STRATEGY_PROMOTION_MIN_WINDOWS consecutive windows — one good week is
//     a week, not a lesson.
// Countering is deliberately CHEAPER than promoting: a single later window that contradicts a
// promoted item, at the same n bar, counters it. Being slow to unlearn a wrong lesson is worse than
// being slow to learn a right one.
//
// SAFETY, same posture as trackingIngest.ts / engagement.ts. Read-only against the sink; one GET
// through the ONE client (fetchRollupRows), the pinned query contract untouched. Reached by env NAMES
// only. NEVER throws: an unconfigured sink, an unreachable sink, a 503 from a grain whose migration
// has not run on this deployment, zero rows, or a repository that refuses a write all end as a
// no-observation result. Nothing is ever fabricated: a metric the sink did not report is absent, not
// zero, and a group with nothing to compare against produces no finding.
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ImprovementRepository } from "../repository/interfaces/ImprovementRepository.js";
import type { LearningObservation } from "../mcp/workspace/store.js";
import { applyPlaybookDelta } from "./playbook.js";
import type { PlaybookDelta, PlaybookItem, PlaybookItemKind } from "./improvementTypes.js";
import { fetchRollupRows, metricsFromRow, trackingSinkConnectionState, type RollupFetchDeps } from "./trackingIngest.js";

const now = () => new Date().toISOString();

/** Observation `source` stamped on every entry this module writes; the contract the promotion pass
 * (and any later reader) filters on. */
export const STRATEGY_OBSERVATION_SOURCE = "tracking:strategy.v1";

/** The strategy.v1 metric set, in wire (snake_case) spelling. `buy_click_rate` is this grain's own —
 * engagement.v1 has no such column — which is why the row projector takes its key list rather than
 * hard-coding one. Anything else on a row is ignored. */
export const STRATEGY_METRIC_KEYS = [
  "pageviews",
  "exposures",
  "sessions",
  "completion_rate",
  "cta_ctr",
  "buy_click_rate",
  "purchase_rate",
  "revenue_cents",
  "p75_dwell_ms"
] as const;
export type StrategyMetricKey = typeof STRATEGY_METRIC_KEYS[number];

/** The metrics a strategy group is COMPARED on. Counts are excluded for the same reason engagement.ts
 * excludes them: pageviews and sessions measure how much traffic a group got, not how well it did
 * with it, and a window total is not comparable to a per-cell median at all. Every key here is
 * scale-free (a rate, or a per-reader duration) and higher is better on all of them. */
export const STRATEGY_COMPARABLE_KEYS = ["completion_rate", "cta_ctr", "buy_click_rate", "purchase_rate", "p75_dwell_ms"] as const;
export type StrategyComparableKey = typeof STRATEGY_COMPARABLE_KEYS[number];

/** Raw attributed-event count a group needs before it can promote or counter anything. The sink's own
 * `n`, NOT `sessions`: n is what the rates were actually computed from. */
export const STRATEGY_PROMOTION_MIN_N = 100;
/** Consecutive windows a finding must hold the same direction across before it becomes a lesson. */
export const STRATEGY_PROMOTION_MIN_WINDOWS = 2;
/** A group's metric is materially ABOVE the site-wide figure at or over this ratio, and materially
 * BELOW it at or under STRATEGY_MATERIAL_BELOW_RATIO. Plain "different from the middle" is a coin
 * flip — half of everything is — so a finding worth writing down needs a margin. The low side mirrors
 * engagement.ts's ENGAGEMENT_SHORTFALL_RATIO so the two loops call the same gap the same size. */
export const STRATEGY_MATERIAL_ABOVE_RATIO = 1.2;
export const STRATEGY_MATERIAL_BELOW_RATIO = 0.8;

/**
 * The nodes a promoted strategy lesson is written to: the WRITER and the PLANNING nodes — the ones
 * that decide what shape a piece takes and then take it. Deliberately an explicit list rather than a
 * node-kind query: `kind` is a loose label (placement_resolver is `strategy` and runs on a
 * deterministic engine path, where a bullet lesson would be injected into nothing), and a lesson
 * landing in a node that cannot act on it is prompt budget spent on noise.
 */
export const STRATEGY_PLAYBOOK_TARGET_NODES = [
  "brief_architect",     // planning — decides the piece's structure
  "angle_strategy",      // planning — decides the angle
  "objection_mapping",   // planning — decides which objections the piece takes on
  "narrative_movement",  // planning — decides how the piece moves
  "reader_insight",      // planning — decides who it is written to
  "draft_writer"         // the writer
] as const;

// ── row → group ──────────────────────────────────────────────────────────────

export type StrategyGroupKey = { strategy?: string; intent?: string };
export type StrategyGroup = StrategyGroupKey & {
  /** Sink `n` summed over the group's rows: the raw attributed-event count the rates rest on. */
  n: number;
  /** Days the group actually appeared on inside the window. */
  days: number;
  metrics: Partial<Record<StrategyMetricKey, number>>;
};

const isFinite_ = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number, digits: number): number => Number(value.toFixed(digits));
const asLabel = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Stable identity for one strategy/intent group. A row with neither is not a group anyone can learn
 * about, and is dropped rather than collected under a fabricated "unknown" bucket. */
export const strategyGroupKeyOf = (key: StrategyGroupKey): string => `${key.strategy ?? ""}|${key.intent ?? ""}`;

/** Read the sink's `n` off a row. Absent or non-numeric means the row states no backing count, which
 * is treated as 0 — never as "probably enough". */
const rowCount = (row: Record<string, unknown>): number => {
  const raw = row.n ?? row.count ?? (row as { eventCount?: unknown }).eventCount;
  const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  return isFinite_(value) && value > 0 ? value : 0;
};

/**
 * Collapse the window's rows into one row per strategy/intent.
 *
 * Counts SUM. Rates and dwell are n-WEIGHTED means — n is the sink's own count of the events each
 * rate was computed from, so it is the only correct weight; an unweighted mean lets a 4-event day
 * outvote a 4,000-event one. A row that states no n carries weight 1 rather than being dropped, so it
 * still contributes without dominating. A metric no row reported is ABSENT from the group, not zero.
 *
 * `p75_dwell_ms` is a weighted mean of per-row p75s, not a true window percentile — that is not
 * recoverable from pre-aggregated rollups, and it is said wherever the number is rendered rather than
 * quietly presented as a real percentile.
 */
export function strategyGroupsFromRows(rows: Array<Record<string, unknown>>): StrategyGroup[] {
  type Accumulator = StrategyGroup & { weighted: Map<StrategyMetricKey, { total: number; weight: number }> };
  const groups = new Map<string, Accumulator>();
  for (const row of rows) {
    const strategy = asLabel(row.strategy);
    const intent = asLabel(row.intent);
    if (!strategy && !intent) continue;
    const key = strategyGroupKeyOf({ strategy, intent });
    const group: Accumulator = groups.get(key) ?? { ...(strategy ? { strategy } : {}), ...(intent ? { intent } : {}), n: 0, days: 0, metrics: {}, weighted: new Map() };
    const n = rowCount(row);
    const weight = n > 0 ? n : 1;
    group.n += n;
    group.days += 1;
    const metrics = metricsFromRow(row, STRATEGY_METRIC_KEYS) as Partial<Record<StrategyMetricKey, number>>;
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
    groups.set(key, group);
  }
  return [...groups.values()].map(({ weighted, ...group }) => {
    for (const [metricKey, bucket] of weighted) if (bucket.weight > 0) group.metrics[metricKey] = round(bucket.total / bucket.weight, metricKey === "p75_dwell_ms" ? 0 : 6);
    return group;
  });
}

/**
 * The site-wide figure for the SAME window: the per-metric median across every strategy/intent/day
 * cell the sink returned. A median rather than a mean because one runaway cell should not redefine
 * "typical", and across ROWS rather than groups because a row is the sink's own unit of measurement.
 *
 * Only comparable (scale-free) metrics get one — see STRATEGY_COMPARABLE_KEYS. A metric no row
 * reported has NO site figure, and therefore produces no comparison at all.
 *
 * A group being compared is itself among the rows the median is taken over (exactly as a node's own
 * objects are among the site's in engagement.ts). With few groups that pulls the median toward the
 * group; the material-ratio margin is what keeps that from manufacturing a finding.
 */
export function strategySiteBaseline(rows: Array<Record<string, unknown>>): Partial<Record<StrategyComparableKey, number>> {
  const projected = rows.map((row) => metricsFromRow(row, STRATEGY_COMPARABLE_KEYS));
  const out: Partial<Record<StrategyComparableKey, number>> = {};
  for (const metricKey of STRATEGY_COMPARABLE_KEYS) {
    const values = projected.map((metrics) => metrics[metricKey]).filter(isFinite_).sort((a, b) => a - b);
    if (!values.length) continue;
    const middle = values.length >> 1;
    out[metricKey] = values.length % 2 ? values[middle]! : round((values[middle - 1]! + values[middle]!) / 2, metricKey === "p75_dwell_ms" ? 0 : 6);
  }
  return out;
}

// ── findings ─────────────────────────────────────────────────────────────────

export type StrategyDirection = "above" | "below";
export type StrategyFinding = {
  metric: StrategyComparableKey;
  direction: StrategyDirection;
  value: number;
  siteFigure: number;
  ratio: number;
  /** Percentage-POINT difference, for the rate metrics only (dwell is a duration, not a rate). */
  deltaPoints?: number;
};

/** Comparable metrics that sit materially away from the site-wide figure, biggest gap first. A metric
 * missing on either side yields no finding — there is nothing to compare. */
export function strategyFindings(group: StrategyGroup, baseline: Partial<Record<StrategyComparableKey, number>>): StrategyFinding[] {
  const findings: StrategyFinding[] = [];
  for (const metric of STRATEGY_COMPARABLE_KEYS) {
    const value = group.metrics[metric];
    const siteFigure = baseline[metric];
    if (!isFinite_(value) || !isFinite_(siteFigure) || siteFigure <= 0) continue;
    const ratio = round(value / siteFigure, 3);
    if (ratio < STRATEGY_MATERIAL_ABOVE_RATIO && ratio > STRATEGY_MATERIAL_BELOW_RATIO) continue;
    findings.push({
      metric,
      direction: ratio >= STRATEGY_MATERIAL_ABOVE_RATIO ? "above" : "below",
      value,
      siteFigure,
      ratio,
      ...(metric === "p75_dwell_ms" ? {} : { deltaPoints: round((value - siteFigure) * 100, 1) })
    });
  }
  return findings.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
}

// ── rendering ────────────────────────────────────────────────────────────────

const METRIC_LABELS: Record<StrategyComparableKey, string> = {
  completion_rate: "completion",
  cta_ctr: "CTA CTR",
  buy_click_rate: "buy-click rate",
  purchase_rate: "purchase rate",
  p75_dwell_ms: "p75 dwell"
};

/** 18 → "18", 3.25 → "3.3". Trailing ".0" is noise in a sentence a human reads. */
const num = (value: number): string => String(round(value, 1)).replace(/\.0$/, "");

/** "p75 dwell 2.1× site median" for a duration; "completion +18 pts" for a rate. */
export const renderStrategyFinding = (finding: StrategyFinding): string =>
  finding.metric === "p75_dwell_ms"
    ? `${METRIC_LABELS[finding.metric]} ${num(finding.ratio)}× site median`
    : `${METRIC_LABELS[finding.metric]} ${(finding.deltaPoints ?? 0) >= 0 ? "+" : ""}${num(finding.deltaPoints ?? 0)} pts`;

/** "intent `objection_handling` (strategy `objection_first`)" — whichever halves the row actually
 * carried. Never invents the missing half. */
export function strategySubjectPhrase(key: StrategyGroupKey): string {
  if (key.intent && key.strategy) return `intent \`${key.intent}\` (strategy \`${key.strategy}\`)`;
  if (key.intent) return `intent \`${key.intent}\``;
  return `strategy \`${key.strategy}\``;
}

export type StrategyWindow = { from: string; to: string };
export const strategyWindowKey = (window: StrategyWindow): string => `${window.from}..${window.to}`;

/**
 * THE OBSERVATION TEMPLATE.
 *
 *   `<subject>: <finding>, <finding> (n=<n>, window <from>..<to>)`
 *
 * e.g. "intent `objection_handling` (strategy `objection_first`): p75 dwell 2.1× site median,
 * completion +18 pts (n=412, window 2026-08-24..2026-08-30)".
 *
 * Phrased as the CROSS-ARTICLE finding it is — a claim about a kind of piece, carrying the window it
 * was measured over and the count it rests on, both of which a later reader needs to decide whether
 * to believe it.
 */
/**
 * The `from:` clause names the metrics this claim actually rests on.
 *
 * It is derived from the FINDINGS, not from the row's metric map, and the
 * difference matters. `metricsFromRow` keeps a metric whose value is 0, and on
 * the strategy grain most of the nine ARE 0 structurally — `pageview` and
 * `exposure` are article-level and carry no node_id, so they cannot reach a node
 * grain at all, and the three per-exposure rates therefore have no denominator
 * (kugel-data migration 012's header; ATTRIBUTION.md §5). Listing "the metrics
 * this row had values for" would present those structural zeroes as
 * measurements, which is the exact confusion KI-29 describes: the wire cannot
 * say "unavailable", so every missing measure arrives as 0.
 *
 * A finding only exists where a comparison was possible and material, so the
 * findings' own metrics are the honest answer to "what was this learned from".
 */
export const renderStrategyObservation = (
  key: StrategyGroupKey,
  findings: StrategyFinding[],
  n: number,
  window: StrategyWindow
): string => {
  const from = [...new Set(findings.map((finding) => finding.metric))].sort();
  return `${strategySubjectPhrase(key)}: ${findings.map(renderStrategyFinding).join(", ")} (n=${Math.round(n)}, window ${window.from}..${window.to}${
    from.length ? `, from: ${from.join(", ")}` : ""
  })`;
};

// ── playbook item text ───────────────────────────────────────────────────────

// The craft instruction behind each metric — what a writer would actually DO differently. Keyed by
// the metric because that is the only thing the measurement licenses: the sink can say readers
// stayed longer on this kind of piece, it cannot say why, so the lesson names the behaviour the
// metric measures and the craft that moves it, and never invents a mechanism nobody observed.
const METRIC_CRAFT: Record<StrategyComparableKey, string> = {
  completion_rate: "make the opening promise the one the piece actually keeps, and keep it in order — a reader who finishes is a reader who was never made to wait for it",
  cta_ctr: "put the next step where the reader is already convinced, in the words they would use themselves",
  buy_click_rate: "let the offer follow the argument instead of interrupting it",
  purchase_rate: "let the offer follow the argument instead of interrupting it, and be concrete about what changes after the purchase",
  p75_dwell_ms: "give the reader a reason to stay past the first screen: the question they arrived with, answered where they can watch it being answered"
};

const effectClause = (finding: StrategyFinding): string => {
  const pts = num(Math.abs(finding.deltaPoints ?? 0));
  const more = finding.direction === "above";
  switch (finding.metric) {
    case "p75_dwell_ms": return more ? `holds attention ${num(finding.ratio)}× the site typical` : `holds attention at only ${num(finding.ratio)}× the site typical`;
    case "completion_rate": return `is read to the end ${pts} pts ${more ? "more" : "less"} often than the site typical`;
    case "cta_ctr": return `earns ${pts} pts ${more ? "more" : "fewer"} CTA clicks than the site typical`;
    case "buy_click_rate": return `earns ${pts} pts ${more ? "more" : "fewer"} buy clicks than the site typical`;
    case "purchase_rate": return `converts ${pts} pts ${more ? "above" : "below"} the site typical`;
  }
};

/**
 * The STABLE half of a promoted item's text: subject + direction + the craft instruction, with no
 * measurement in it. It is how an item promoted in one window is found again in the next — to be
 * reinforced (helpfulCount) or countered (harmfulCount) — without matching on numbers that move every
 * window. The effect sentence is appended after it, so the item still reads as a claim with evidence.
 */
export const strategyPlaybookItemPrefix = (key: StrategyGroupKey, metric: StrategyComparableKey, direction: StrategyDirection): string =>
  direction === "above"
    ? `Reach for ${strategySubjectPhrase(key)} when the brief allows it — ${METRIC_CRAFT[metric]};`
    : `Do not default to ${strategySubjectPhrase(key)} — ${METRIC_CRAFT[metric]};`;

/**
 * THE PLAYBOOK ITEM TEMPLATE.
 *
 *   `<prefix> it <effect>. (<source>, <k> consecutive windows through <to>, n=<n>.)`
 *
 * e.g. "Reach for intent `objection_handling` (strategy `objection_first`) when the brief allows it —
 * give the reader a reason to stay past the first screen: the question they arrived with, answered
 * where they can watch it being answered; it holds attention 2.1× the site typical.
 * (tracking:strategy.v1, 2 consecutive windows through 2026-08-31, n=838.)"
 *
 * Guidance first, evidence in parentheses — the opposite order from an observation, because this text
 * is injected into a writer's prompt and has to read as an instruction, not as a dashboard row.
 */
export const renderStrategyPlaybookItem = (signal: StableStrategySignal): string =>
  `${strategyPlaybookItemPrefix(signal, signal.metric, signal.direction)} it ${effectClause(signal.latest)}. (${STRATEGY_OBSERVATION_SOURCE}, ${signal.windows} consecutive windows through ${signal.through}, n=${Math.round(signal.n)}.)`;

/** `above` findings are things to DO (a strategy); `below` findings are things to stop doing (a
 * pitfall). Those are two of the playbook's three existing kinds — no new vocabulary. */
export const strategyPlaybookItemKind = (direction: StrategyDirection): PlaybookItemKind => (direction === "above" ? "strategy" : "pitfall");

// ── observations → stable signals ────────────────────────────────────────────

export type StrategySignalKey = StrategyGroupKey & { metric: StrategyComparableKey };
export const strategySignalKeyOf = (signal: StrategySignalKey): string => `${strategyGroupKeyOf(signal)}|${signal.metric}`;

export type StrategySignalSighting = StrategySignalKey & { direction: StrategyDirection; n: number; window: StrategyWindow; finding: StrategyFinding };
export type StableStrategySignal = StrategySignalKey & {
  direction: StrategyDirection;
  /** Consecutive windows the direction held, at or above the n bar, ending at `through`. */
  windows: number;
  /** Summed n over that streak. */
  n: number;
  through: string;
  latest: StrategyFinding;
};

const readMetadata = (observation: LearningObservation): Record<string, unknown> => (observation.metadata && typeof observation.metadata === "object" ? observation.metadata : {}) as Record<string, unknown>;

/**
 * Recover the sightings this module wrote from stored observations. Reads the STRUCTURED metadata,
 * never the rendered sentence — the sentence is for humans and is allowed to change; the metadata is
 * the contract. Anything that is not a well-formed `tracking:strategy.v1` entry for this project is
 * skipped rather than guessed at.
 */
export function strategySightingsFromObservations(observations: LearningObservation[], projectId?: string): StrategySignalSighting[] {
  const sightings: StrategySignalSighting[] = [];
  for (const observation of observations) {
    const metadata = readMetadata(observation);
    if (metadata.source !== STRATEGY_OBSERVATION_SOURCE) continue;
    if (projectId && asLabel(metadata.projectId) !== projectId) continue;
    const window = metadata.window as StrategyWindow | undefined;
    if (!window || !asLabel(window.from) || !asLabel(window.to)) continue;
    const n = isFinite_(metadata.n) ? metadata.n : 0;
    const strategy = asLabel(metadata.strategy);
    const intent = asLabel(metadata.intent);
    if (!strategy && !intent) continue;
    for (const finding of Array.isArray(metadata.findings) ? (metadata.findings as StrategyFinding[]) : []) {
      if (!finding || !STRATEGY_COMPARABLE_KEYS.includes(finding.metric) || (finding.direction !== "above" && finding.direction !== "below")) continue;
      sightings.push({ ...(strategy ? { strategy } : {}), ...(intent ? { intent } : {}), metric: finding.metric, direction: finding.direction, n, window, finding });
    }
  }
  return sightings;
}

/**
 * The ordered sequence of windows this project actually observed. "Consecutive" below means adjacent
 * in THIS sequence, not calendar-adjacent: a day the daily job did not run (an outage, a deploy, a
 * sink that was still unmigrated) must not silently reset evidence that is otherwise unbroken, and a
 * gap is not counter-evidence — it is an absence of evidence.
 */
export const strategyWindowSequence = (sightings: StrategySignalSighting[]): string[] =>
  [...new Set(sightings.map((sighting) => strategyWindowKey(sighting.window)))].sort();

/**
 * Findings that have EARNED a playbook item: the same direction, at or above the n bar, across at
 * least STRATEGY_PROMOTION_MIN_WINDOWS windows adjacent in the observed sequence, ending at the most
 * recent window the signal was seen in. A window below the n bar breaks the streak — it is not
 * evidence for or against, and treating it as either would let a quiet day either promote or unlearn.
 */
export function stableStrategySignals(sightings: StrategySignalSighting[]): StableStrategySignal[] {
  const sequence = strategyWindowSequence(sightings);
  const position = new Map(sequence.map((key, index) => [key, index]));
  const bySignal = new Map<string, StrategySignalSighting[]>();
  for (const sighting of sightings) bySignal.set(strategySignalKeyOf(sighting), [...(bySignal.get(strategySignalKeyOf(sighting)) ?? []), sighting]);

  const stable: StableStrategySignal[] = [];
  for (const group of bySignal.values()) {
    const qualified = group
      .filter((sighting) => sighting.n >= STRATEGY_PROMOTION_MIN_N)
      .sort((a, b) => position.get(strategyWindowKey(a.window))! - position.get(strategyWindowKey(b.window))!);
    if (qualified.length < STRATEGY_PROMOTION_MIN_WINDOWS) continue;
    // Walk back from the latest qualified sighting while the window index steps down by one and the
    // direction holds. That streak, and only it, is the evidence the item may cite.
    const streak: StrategySignalSighting[] = [qualified[qualified.length - 1]!];
    for (let index = qualified.length - 2; index >= 0; index--) {
      const candidate = qualified[index]!;
      const head = streak[0]!;
      if (candidate.direction !== head.direction) break;
      if (position.get(strategyWindowKey(candidate.window))! !== position.get(strategyWindowKey(head.window))! - 1) break;
      streak.unshift(candidate);
    }
    if (streak.length < STRATEGY_PROMOTION_MIN_WINDOWS) continue;
    const latest = streak[streak.length - 1]!;
    stable.push({
      ...(latest.strategy ? { strategy: latest.strategy } : {}),
      ...(latest.intent ? { intent: latest.intent } : {}),
      metric: latest.metric,
      direction: latest.direction,
      windows: streak.length,
      n: streak.reduce((sum, sighting) => sum + sighting.n, 0),
      through: latest.window.to,
      latest: latest.finding
    });
  }
  return stable;
}

/**
 * Sightings in the newest observed window that CONTRADICT a direction previously promoted: same
 * subject, same metric, opposite direction, at or above the n bar. One such window is enough — see
 * the module header on why countering is cheaper than promoting.
 */
export function contradictingStrategySightings(sightings: StrategySignalSighting[]): StrategySignalSighting[] {
  const sequence = strategyWindowSequence(sightings);
  const newest = sequence[sequence.length - 1];
  if (!newest) return [];
  return sightings.filter((sighting) => strategyWindowKey(sighting.window) === newest && sighting.n >= STRATEGY_PROMOTION_MIN_N);
}

// ── promotion ────────────────────────────────────────────────────────────────

export type StrategyPromotionOutcome = {
  promoted: Array<{ nodeId: string; signal: string; text: string }>;
  reinforced: Array<{ nodeId: string; signal: string; itemId: string }>;
  countered: Array<{ nodeId: string; signal: string; itemId: string }>;
  errors: Array<{ scope: string; error: string }>;
};

const findItemByPrefix = (items: PlaybookItem[], prefix: string): PlaybookItem | undefined => items.find((item) => item.text.startsWith(prefix));

/**
 * Fold stable signals — and this window's contradictions — into the writer/planning playbooks.
 *
 * Every write goes through applyPlaybookDelta, which is the ONE mechanism this repo has for this:
 *   * a signal with no item yet becomes an `add` (dedup and the item/char budget apply as always);
 *   * a signal whose item already exists is `markHelpful` — the pre-existing reinforcement counter;
 *   * a signal that contradicts an existing item is `markHarmful` — the pre-existing COUNTER. It
 *     lowers net helpfulness, which is what orders items in the injected prompt and what the budget
 *     evicts by, so a contradicted lesson sinks and then goes. No second demotion mechanism is
 *     invented here, and nothing is deleted behind an operator's back.
 *
 * Never throws: a repository that refuses one node's playbook is recorded and the rest still run.
 */
export async function promoteStrategySignals(
  sightings: StrategySignalSighting[],
  deps: { improvementRepository: ImprovementRepository },
  nodeIds: readonly string[] = STRATEGY_PLAYBOOK_TARGET_NODES
): Promise<StrategyPromotionOutcome> {
  const outcome: StrategyPromotionOutcome = { promoted: [], reinforced: [], countered: [], errors: [] };
  const stable = stableStrategySignals(sightings);
  const contradictions = contradictingStrategySightings(sightings);
  if (!stable.length && !contradictions.length) return outcome;

  for (const nodeId of nodeIds) {
    try {
      const existing = await deps.improvementRepository.getPlaybook(nodeId);
      const items = existing?.items ?? [];
      const delta: PlaybookDelta = {};
      const add: NonNullable<PlaybookDelta["add"]> = [];
      const markHelpful: string[] = [];
      const markHarmful = new Set<string>();
      const promotedThisPass: Array<{ signal: string; text: string }> = [];

      for (const signal of stable) {
        const prefix = strategyPlaybookItemPrefix(signal, signal.metric, signal.direction);
        const current = findItemByPrefix(items, prefix);
        if (current) {
          markHelpful.push(current.itemId);
          outcome.reinforced.push({ nodeId, signal: strategySignalKeyOf(signal), itemId: current.itemId });
          continue;
        }
        const text = renderStrategyPlaybookItem(signal);
        add.push({ text, kind: strategyPlaybookItemKind(signal.direction), provenance: { source: "tracking" } });
        promotedThisPass.push({ signal: strategySignalKeyOf(signal), text });
      }

      for (const sighting of contradictions) {
        const opposite: StrategyDirection = sighting.direction === "above" ? "below" : "above";
        const counteredItem = findItemByPrefix(items, strategyPlaybookItemPrefix(sighting, sighting.metric, opposite));
        if (!counteredItem) continue;
        markHarmful.add(counteredItem.itemId);
        outcome.countered.push({ nodeId, signal: strategySignalKeyOf(sighting), itemId: counteredItem.itemId });
      }

      if (add.length) delta.add = add;
      if (markHelpful.length) delta.markHelpful = markHelpful;
      if (markHarmful.size) delta.markHarmful = [...markHarmful];
      if (!delta.add && !delta.markHelpful && !delta.markHarmful) continue;

      await deps.improvementRepository.savePlaybook(applyPlaybookDelta(existing, nodeId, delta, now()));
      for (const entry of promotedThisPass) outcome.promoted.push({ nodeId, ...entry });
    } catch (error) {
      outcome.errors.push({ scope: nodeId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}

// ── the ingest ───────────────────────────────────────────────────────────────

export type StrategyLearningParams = { projectId: string; from: string; to: string };
export type StrategyLearningDeps = RollupFetchDeps & {
  learningRepository: LearningRepository;
  improvementRepository: ImprovementRepository;
};

export type StrategyLearningResult = {
  /** Rows the sink returned, so "0 observations" can be told apart from "0 rows". */
  rows: number;
  /**
   * Of those rows, how many carried a `strategy` or an `intent`. The gap between
   * `rows` and `rowsLabelled` is the whole KI-08 failure mode: the sink can serve
   * a full window of perfectly good rows whose labels are all NULL, and every one
   * of them is dropped by `strategyGroupsFromRows`. Without this number that
   * looks identical to a quiet week.
   */
  rowsLabelled: number;
  groups: number;
  observations: Array<{ id: string; strategy?: string; intent?: string; n: number; findings: number; observation: string }>;
  promotion: StrategyPromotionOutcome;
  /** Set when the pull did not happen at all and that is NOT a failure: the sink is not configured on
   * this deployment, or its `by=strategy` grain has not been migrated yet (503). */
  skipped?: "sink_unconfigured" | "grain_unavailable";
  errors: Array<{ scope?: string; error: string }>;
};

const emptyResult = (): StrategyLearningResult => ({ rows: 0, rowsLabelled: 0, groups: 0, observations: [], promotion: { promoted: [], reinforced: [], countered: [], errors: [] }, errors: [] });

/** The sink's `by=strategy` grain answers 503 until kugel-data serves it (migration 012, 2026-09).
 * That is a grain that does not exist on this deployment yet, not a failure — the same no-op an
 * absent sink gets, with nothing surfaced to the caller as an error.
 *
 * This used to name "migration 008". It was never 008: kugel-data's 008 is
 * `008_experiment_keyed_by_control_item.sql` and its migrations were already at 011, so anyone who
 * checked whether 008 had run got "yes" and concluded the grain should be working. */
const GRAIN_UNAVAILABLE_STATUS = 503;

/**
 * GET `${TRACKING_SINK_URL}/rollups?by=strategy` for the project/window, write the material
 * cross-article findings down as `tracking:strategy.v1` observations, then promote whatever has held
 * up into the writer/planning playbooks.
 *
 * NEVER throws. Unconfigured sink, unreachable sink, 503 grain, zero rows, a group with nothing
 * comparable, a repository that refuses a write — all end as a result with no observations and
 * today's behaviour unchanged.
 */
export async function ingestStrategyRollups(params: StrategyLearningParams, deps: StrategyLearningDeps): Promise<StrategyLearningResult> {
  const result = emptyResult();
  const env = deps.env ?? process.env;
  const connection = trackingSinkConnectionState(env);
  if (!connection.urlConfigured || !connection.tokenConfigured) {
    result.skipped = "sink_unconfigured";
    return result;
  }

  const page = await fetchRollupRows({ by: "strategy", projectId: params.projectId, from: params.from, to: params.to }, deps);
  if (!page.ok) {
    if (page.status === GRAIN_UNAVAILABLE_STATUS) {
      result.skipped = "grain_unavailable";
      return result;
    }
    result.errors.push({ error: page.error });
    return result;
  }

  result.rows = page.rows.length;
  result.rowsLabelled = page.rows.filter((row) => asLabel(row.strategy) || asLabel(row.intent)).length;
  if (!page.rows.length) return result;

  const window: StrategyWindow = { from: params.from.slice(0, 10), to: params.to.slice(0, 10) };
  const groups = strategyGroupsFromRows(page.rows);
  result.groups = groups.length;
  const baseline = strategySiteBaseline(page.rows);

  for (const group of groups) {
    const findings = strategyFindings(group, baseline);
    if (!findings.length) continue;
    const observation = renderStrategyObservation(group, findings, group.n, window);
    try {
      const saved = await deps.learningRepository.recordObservation(observation, {
        source: STRATEGY_OBSERVATION_SOURCE,
        projectId: params.projectId,
        ...(group.strategy ? { strategy: group.strategy } : {}),
        ...(group.intent ? { intent: group.intent } : {}),
        window,
        n: group.n,
        days: group.days,
        metrics: group.metrics,
        siteFigures: baseline,
        findings
      });
      result.observations.push({ id: saved.id, ...(group.strategy ? { strategy: group.strategy } : {}), ...(group.intent ? { intent: group.intent } : {}), n: group.n, findings: findings.length, observation });
    } catch (error) {
      result.errors.push({ scope: strategyGroupKeyOf(group), error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Promotion reads the store back (this window's entries included), so the stability rule is applied
  // to the full observed history and not just to what this run happened to fetch.
  try {
    const stored = await deps.learningRepository.listObservations();
    result.promotion = await promoteStrategySignals(strategySightingsFromObservations(stored, params.projectId), deps);
  } catch (error) {
    result.errors.push({ scope: "promotion", error: error instanceof Error ? error.message : String(error) });
  }
  return result;
}
