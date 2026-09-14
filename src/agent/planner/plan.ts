// THE DETERMINISTIC HALF of `editorial_planner` (Track C, Wolf 2026-09-14).
//
// WHAT THE MODEL DECIDES, AND WHAT IT DOES NOT. The model turn proposes CANDIDATE BRIEFS — topics,
// angles, one sentence of instructions each. Everything that can spend money, publish a duplicate,
// or run away is decided HERE, in code, with no model in the loop: what counts as a duplicate, how
// many runs today is too many, what today has already cost, whether the last two runs failed, and
// what the request id must look like. A planner whose CAPS are model output is a planner whose caps
// are a suggestion, and the first bad night costs a day's budget.
//
// So the shape of this module is: candidates in, a `commission_plan.v1` out, and every rejection
// named. Nothing here does I/O, nothing here reads a clock it was not handed, and nothing here
// starts a run — which is what makes the whole policy testable without a tenant, a store or a model.
//
// THE FOUR GATES, in the order they run and for the reason they run in it:
//   1. EXCLUSIONS — the strategist's own veto, applied before anything else so an excluded topic
//      never consumes a slot it was never eligible for.
//   2. DEDUPE — against the published inventory AND the runs already in flight. Slug-normalized,
//      because "Ceramides, explained" and "ceramides-explained" are the same article twice, and the
//      second one is worse than nothing: it splits the site's own search ranking.
//   3. CAPS — runsPerDay, dailyBudgetUsd (priced at the p95 of what a run on THIS project has
//      actually cost, never at a hoped-for average), maxConcurrentRuns.
//   4. HALT — consecutive failures. Checked FIRST in practice (it short-circuits the whole plan),
//      but stated last because it is a property of the tenant, not of a candidate.
import { type AwarenessStage, type Commissioning, type CommissioningArchetype, type ReaderState, type TrafficSource } from "./commissioningTypes.js";

export const COMMISSION_PLAN_CONTRACT = "commission_plan.v1";
export const COMMISSIONED_BY = "editorial_planner";

/** A brief the model turn proposed, or a seed promoted into one. Pre-gate: nothing here is committed to. */
export type CandidateBrief = {
  topic: string;
  readerState: ReaderState;
  archetypeId: string;
  /** One sentence. Becomes `instructions` on the run, and the title in the tenant's requests inbox. */
  instructions: string;
  /** Why this one, in the planner's own words. Stamped on the run and shown to the operator. */
  rationale: string;
  trafficSource?: TrafficSource;
  awarenessStage?: AwarenessStage;
  /** Higher first. Seeds carry the strategist's own number; model candidates carry their rank. */
  priority: number;
  /** Present when the candidate came from a strategy seed rather than the model turn. */
  seedId?: string;
};

export type CommissionRequest = {
  requestId: string;
  contentSource: { contract: "content_source.v1"; kind: "commissioned_topic"; topic: string; readerState: ReaderState; archetypeId: string; archetypeJob: string };
  instructions: string;
  trafficSource: TrafficSource;
  awarenessStage: AwarenessStage;
  rationale: string;
  dedupeKey: string;
};

export type PlanRejection = { topic: string; reason: "excluded" | "duplicate_of_published" | "duplicate_of_open_run" | "duplicate_in_plan" | "unknown_archetype" | "request_id_unmintable" | "over_run_cap" | "over_budget" | "over_concurrency"; detail?: string };

export type CommissionPlan = {
  contract: typeof COMMISSION_PLAN_CONTRACT;
  projectId: string;
  planId: string;
  plannedAt: string;
  requests: CommissionRequest[];
  rejected: PlanRejection[];
  /** What the caps allowed, and why — the numbers an operator argues with. */
  caps: { runsPerDay: number; runsAlreadyToday: number; slotsByRunCount: number; dailyBudgetUsd: number; spentTodayUsd: number; pricedRunCostUsd: number; slotsByBudget: number; maxConcurrentRuns: number; /** Runs holding a slot: anything queued/running, plus the planner's OWN runs stuck at a human gate. */ openRuns: number; slotsByConcurrency: number; slots: number };
  halt?: PlannerHalt;
};

export type PlannerHalt = { halted: true; code: "planner_halted"; consecutiveFailures: number; threshold: number; message: string };

/** What the planner knows about this project's recent runs. Supplied by the caller; never fetched here. */
export type RunFact = {
  runId: string;
  status: string;
  startedAt: string;
  costUsd?: number;
  commissionedBy?: string;
  /** The slug or normalized title the run is producing, when known — an open run's claim on a topic. */
  topicKey?: string;
};

export type PlanInputs = {
  projectId: string;
  commissioning: Commissioning;
  candidates: CandidateBrief[];
  /**
   * Published inventory. `objectId` matters as much as the other two and often more: a tenant's
   * `object_list` answers with ids and no bodies (verified live on dr-lurie, 2026-09-14), and on
   * this fleet a content_item's id IS its request id — `req_plugin_azelaic_acid_20260904_01` — so
   * the topic is right there in the key even when nothing else came back.
   */
  inventory: { slug?: string; title?: string; objectId?: string }[];
  /** Every run for this project in the last 30 days, newest first. */
  recentRuns: RunFact[];
  /** p95 cost of a run on this project (nodeTimingAggregates / run-cost history). Falls back to MEASURED_RUN_COST_USD. */
  pricedRunCostUsd?: number;
  /** The request-id grammar this tenant declares, e.g. `^req_[a-z0-9_]+_\d{8}_\d{2}$`. */
  requestIdPattern?: string;
  now: Date;
  /** Injected so a plan is reproducible in a test; defaults to a time-seeded id. */
  planId?: string;
};

/**
 * The measured cost of one live publishing_conductor run (Wolf, 2026-09-13: ≈ $4 measured, $14.7
 * ceiling). Used ONLY when a project has no cost history of its own — a brand-new tenant must not
 * get an unbounded first day because nothing has run yet to price.
 */
export const MEASURED_RUN_COST_USD = 4;

/**
 * Shortest normalized exclusion that is allowed to veto anything. Three characters, because a
 * one-character exclusion matches almost every topic a publication could name and silently ends its
 * publishing — a configuration typo should not be able to do that quietly.
 */
export const MIN_EXCLUSION_KEY_LENGTH = 3;

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "cancelled"]);

/** Actively consuming the pipeline right now, whoever started it. */
const RUNNING_STATUSES = new Set(["queued", "running"]);

/** Not finished, but waiting on a PERSON rather than on the engine. */
const WAITING_ON_A_HUMAN_STATUSES = new Set(["paused", "blocked"]);

/**
 * What `maxConcurrentRuns` counts — and the rule is about WHO IS WAITING FOR WHOM.
 *
 * A run that is queued or running consumes the pipeline, so it counts however it started.
 *
 * A run stuck at a human gate counts only when the PLANNER started it. Both halves of that are
 * load-bearing, and each fixes a real failure the other one causes:
 *
 *   * A HUMAN's blocked run must not count. dr-lurie carried seven of them on 2026-09-14, the
 *     oldest a week old. Counting an editor's abandoned approval queue as concurrency would stop
 *     the site commissioning for ever because nobody clicked a button.
 *
 *   * The PLANNER's own blocked runs must count, for the mirror-image reason. Excluding them makes
 *     a tenant whose publish gate never clears invisible to every brake at once: the halt does not
 *     trip (blocked is not a failure), concurrency is always free, and the planner commissions a
 *     fresh pair of articles every morning into a queue nobody is draining — forever, publishing
 *     nothing. A backlog the planner created is a backlog the planner owns.
 */
const holdsAConcurrencySlot = (run: RunFact): boolean =>
  RUNNING_STATUSES.has(run.status) || (WAITING_ON_A_HUMAN_STATUSES.has(run.status) && run.commissionedBy === COMMISSIONED_BY);

/**
 * OPEN — not finished, whatever it is waiting for. A blocked run still has a draft article behind
 * it, so its TOPIC is claimed and re-commissioning it would be a duplicate. That is the one thing
 * these runs still get a vote on.
 */
const OPEN_STATUSES = new Set(["queued", "running", "paused", "blocked"]);
const SUCCESS_STATUSES = new Set(["completed", "published", "released"]);

/**
 * The normalization that decides what "the same article" means: lowercase, strip accents and
 * punctuation, collapse whitespace to single hyphens, and drop the handful of leading words a
 * headline adds and a slug does not ("What is niacinamide" and "niacinamide" are one topic).
 *
 * EQUALITY, NOT CONTAINMENT — for dedupe. It is tempting to treat "ceramides" as a duplicate of
 * "ceramides-for-a-damaged-barrier", since the first is a prefix of the second. Containment blocks
 * far more than it should: on a site whose strategy names a subject, every genuinely distinct piece
 * about that subject shares its stem, and a planner that refuses them all quietly stops publishing
 * while looking like it is working. So two topics collide only when they normalize to the SAME key.
 *
 * EXCLUSIONS ARE THE EXCEPTION and DO match by containment (see `buildCommissionPlan`): a
 * strategist writing "prescription tretinoin dosing" into `exclusions` means the subject, not one
 * phrasing of it, and over-refusing is the correct failure mode for an explicit veto.
 */
export const dedupeKeyOf = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[\s-]+/g, "-")
    .replace(/^(the|a|an|how-to|what-is|why|your|guide-to)-/, "")
    .replace(/^-+|-+$/g, "");

/**
 * The topic buried in a request id: `req_<flow>_<topic>_<yyyymmdd>_<nn>` → `<topic>`.
 *
 * This is the ONLY dedupe signal available on a tenant whose `object_list` returns ids and no
 * bodies, which is the shape dr-lurie actually answers with. Without it the planner reads a site
 * with 38 published articles as an empty one and cheerfully re-commissions every subject on it —
 * the single most expensive mistake available to this feature, and one that only shows up against
 * live data.
 *
 * Returns undefined for an id that is not of that shape, rather than guessing: a key derived from
 * a misparsed id is a false MATCH, which silently stops legitimate work.
 */
export const topicFromRequestId = (objectId: string): string | undefined => {
  const segment = requestIdTopicSegment(objectId);
  return segment ? segment.replace(/_/g, " ") : undefined;
};

const sameDayUtc = (iso: string, now: Date): boolean => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;
  return at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth() && at.getUTCDate() === now.getUTCDate();
};

/**
 * THE HALT. Consecutive COMMISSIONED failures, newest first, stopping at the first commissioned
 * success. Human-started runs are invisible to this count on purpose: a person retrying a broken
 * draft by hand must not reset — or trip — the planner's own circuit breaker.
 */
export const consecutiveCommissionedFailures = (recentRuns: readonly RunFact[]): number => {
  let count = 0;
  for (const run of recentRuns) {
    if (run.commissionedBy !== COMMISSIONED_BY) continue;
    if (SUCCESS_STATUSES.has(run.status)) break;
    if (TERMINAL_FAILURE_STATUSES.has(run.status)) count += 1;
    // A still-open commissioned run is neither a failure nor a success: it breaks the streak's
    // continuity without being counted, because tomorrow it may be either. `blocked` lands here
    // rather than in the failure set on purpose — a run waiting for an approval is a run waiting
    // for a person, and halting the planner over it would blame the engine for a human queue.
    else if (OPEN_STATUSES.has(run.status)) break;
  }
  return count;
};

/**
 * Mint a request id that satisfies the tenant's declared grammar. The conventional shape is
 * `req_<flow>_<topic>_<yyyymmdd>_<nn>`; `nn` is the candidate's position in TODAY's plan, offset past
 * the runs already commissioned today so two plans in one day cannot collide. A tenant with no
 * declared pattern still gets this shape — a readable id is worth more than an opaque one, and the
 * engine accepts any id where no pattern is declared.
 */
/**
 * The `<topic>` segment a request id carries for this topic — the SAME truncation `mintRequestId`
 * applies, exported because the dedupe depends on it.
 *
 * WHY THE TRUNCATION HAS TO BE SHARED. On a tenant whose `object_list` returns ids and no bodies,
 * the id is the only dedupe signal there is. Minting from a 40-character slug while comparing
 * against the full topic means the key recovered from yesterday's id can never equal today's key,
 * so any topic longer than 40 characters is re-commissioned every single day for ever — the
 * feature's worst failure mode, reached by nothing more exotic than a long headline. Comparing on
 * the MINTED form closes it exactly, in both directions.
 */
export const requestTopicSlug = (topic: string): string =>
  dedupeKeyOf(topic).replace(/-/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 40).replace(/^_+|_+$/g, "") || "topic";

/** The raw `<topic>` segment of a request id, untouched — the other side of `requestTopicSlug`. */
export const requestIdTopicSegment = (objectId: string): string | undefined =>
  /^req_[a-z0-9]+_(.+)_\d{8}_\d{2}$/.exec(objectId.trim().toLowerCase())?.[1];

export const mintRequestId = (topic: string, now: Date, sequence: number, flow = "planner"): string => {
  const yyyymmdd = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  return `req_${flow}_${requestTopicSlug(topic)}_${yyyymmdd}_${String(Math.min(99, Math.max(1, sequence))).padStart(2, "0")}`;
};

const compilePattern = (pattern: string | undefined): RegExp | undefined => {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
};

/**
 * Turn seeds into candidates. Called by the orchestrator BEFORE the model turn's output is appended,
 * so a tenant whose model turn returns nothing usable still commissions the work its strategist
 * already decided on. Seeds carry the strategist's own priority, which is why they sort above model
 * candidates at equal numbers.
 */
export const seedCandidates = (commissioning: Commissioning): CandidateBrief[] =>
  commissioning.seeds.map((seed) => {
    const archetype = commissioning.archetypes.find((entry) => entry.id === seed.archetypeId);
    return {
      topic: seed.topic,
      readerState: seed.readerState,
      archetypeId: seed.archetypeId,
      instructions: `Write for a reader at the ${seed.readerState} stage about ${seed.topic}.${archetype ? ` Their job: ${archetype.job}` : ""} Next step: name one concrete thing the reader should do after reading.`,
      rationale: `Strategy seed (priority ${seed.priority}) — the strategist named this topic for the ${seed.readerState} reader state.`,
      ...(seed.trafficSource ? { trafficSource: seed.trafficSource } : {}),
      ...(seed.awarenessStage ? { awarenessStage: seed.awarenessStage } : {}),
      priority: seed.priority,
      seedId: `${seed.archetypeId}:${dedupeKeyOf(seed.topic)}`
    };
  });

/**
 * THE PLAN. Pure: the same inputs always produce the same plan, including the request ids, which is
 * what makes `planner.plan` an honest preview of what `planner.commission` will do.
 */
export const buildCommissionPlan = (inputs: PlanInputs): CommissionPlan => {
  const { commissioning, now } = inputs;
  const planId = inputs.planId ?? `plan_${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}_${inputs.projectId}`;
  const base: Pick<CommissionPlan, "contract" | "projectId" | "planId" | "plannedAt"> = { contract: COMMISSION_PLAN_CONTRACT, projectId: inputs.projectId, planId, plannedAt: now.toISOString() };

  const failures = consecutiveCommissionedFailures(inputs.recentRuns);
  const pricedRunCostUsd = inputs.pricedRunCostUsd && inputs.pricedRunCostUsd > 0 ? inputs.pricedRunCostUsd : MEASURED_RUN_COST_USD;
  const runsAlreadyToday = inputs.recentRuns.filter((run) => run.commissionedBy === COMMISSIONED_BY && sameDayUtc(run.startedAt, now)).length;
  // WHAT TODAY HAS COST. A FINISHED run is billed at what it actually cost. A run still going is
  // billed at the p95 or at what it has spent so far, WHICHEVER IS LARGER — the usage ledger accrues
  // per node, so a run started at 06:00 and still writing has paid a fraction of its eventual bill,
  // and preferring that fraction is exactly backwards: it reads a day's work in progress as almost
  // free and hands the budget back slots it has already committed.
  const spentTodayUsd = inputs.recentRuns
    .filter((run) => run.commissionedBy === COMMISSIONED_BY && sameDayUtc(run.startedAt, now))
    .reduce((total, run) => {
      const billed = typeof run.costUsd === "number" && run.costUsd > 0 ? run.costUsd : 0;
      const finished = SUCCESS_STATUSES.has(run.status) || TERMINAL_FAILURE_STATUSES.has(run.status);
      return total + (finished ? billed || pricedRunCostUsd : Math.max(billed, pricedRunCostUsd));
    }, 0);
  const openRuns = inputs.recentRuns.filter(holdsAConcurrencySlot).length;

  const slotsByRunCount = Math.max(0, commissioning.runsPerDay - runsAlreadyToday);
  // Priced at p95, not at the average. The average is what a good day costs; the ceiling exists for
  // the other kind, and a budget that only holds on good days is not a budget.
  const slotsByBudget = Math.max(0, Math.floor((commissioning.dailyBudgetUsd - spentTodayUsd) / pricedRunCostUsd));
  const slotsByConcurrency = Math.max(0, commissioning.maxConcurrentRuns - openRuns);
  const slots = Math.min(slotsByRunCount, slotsByBudget, slotsByConcurrency);
  const caps = { runsPerDay: commissioning.runsPerDay, runsAlreadyToday, slotsByRunCount, dailyBudgetUsd: commissioning.dailyBudgetUsd, spentTodayUsd: Number(spentTodayUsd.toFixed(4)), pricedRunCostUsd, slotsByBudget, maxConcurrentRuns: commissioning.maxConcurrentRuns, openRuns, slotsByConcurrency, slots };

  if (failures >= commissioning.stopAfterConsecutiveFailures) {
    return {
      ...base,
      requests: [],
      rejected: [],
      caps: { ...caps, slots: 0 },
      halt: {
        halted: true,
        code: "planner_halted",
        consecutiveFailures: failures,
        threshold: commissioning.stopAfterConsecutiveFailures,
        message: `Commissioning stopped after ${failures} consecutive failed commissioned runs (threshold ${commissioning.stopAfterConsecutiveFailures}). Nothing is being commissioned for this site until the strategy is revised or commissioning is resumed.`
      }
    };
  }

  const publishedKeys = new Set<string>();
  // The minted-form keys, compared separately so a truncated id still matches the topic that
  // produced it. See requestTopicSlug.
  const publishedIdSlugs = new Set<string>();
  for (const item of inputs.inventory) {
    if (item.slug) publishedKeys.add(dedupeKeyOf(item.slug));
    if (item.title) publishedKeys.add(dedupeKeyOf(item.title));
    if (item.objectId) {
      const segment = requestIdTopicSegment(item.objectId);
      if (segment) {
        publishedIdSlugs.add(segment);
        publishedKeys.add(dedupeKeyOf(segment.replace(/_/g, " ")));
      }
    }
  }
  const openKeys = new Set<string>();
  for (const run of inputs.recentRuns) {
    if (OPEN_STATUSES.has(run.status) && run.topicKey) openKeys.add(dedupeKeyOf(run.topicKey));
  }
  // ONE DIRECTION ONLY, and never on a fragment. Matching `exclusion.includes(key)` as well looked
  // symmetric and inverted the rule: an exclusion of "prescription tretinoin dosing" then also
  // rejected the candidate "tretinoin", so writing a MORE precise veto banned MORE. And a one- or
  // two-character entry that survived normalization ("a") matched nearly every topic on the site,
  // which stops a publication dead with `reason: "excluded"` and nothing saying the exclusion is
  // the problem. A veto now refuses a candidate only when the candidate's own key CONTAINS it.
  const exclusions = commissioning.exclusions.map(dedupeKeyOf).filter((entry) => entry.length >= MIN_EXCLUSION_KEY_LENGTH);
  const archetypeById = new Map<string, CommissioningArchetype>(commissioning.archetypes.map((entry) => [entry.id, entry]));
  const pattern = compilePattern(inputs.requestIdPattern);

  const rejected: PlanRejection[] = [];
  const requests: CommissionRequest[] = [];
  const takenKeys = new Set<string>();

  // Sort is part of the CONTRACT, not a convenience: `planner.plan` shows an operator the order
  // `planner.commission` will spend in, and a tie broken by object order would make the preview a
  // different plan from the commission on a different day's inventory ordering.
  const ordered = [...inputs.candidates].sort((a, b) => b.priority - a.priority || a.topic.localeCompare(b.topic));

  for (const candidate of ordered) {
    const key = dedupeKeyOf(candidate.topic);
    if (!key) continue;

    const excludedBy = exclusions.find((exclusion) => key.includes(exclusion));
    if (excludedBy) {
      rejected.push({ topic: candidate.topic, reason: "excluded", detail: excludedBy });
      continue;
    }
    const archetype = archetypeById.get(candidate.archetypeId);
    if (!archetype) {
      rejected.push({ topic: candidate.topic, reason: "unknown_archetype", detail: candidate.archetypeId });
      continue;
    }
    if (publishedKeys.has(key) || publishedIdSlugs.has(requestTopicSlug(candidate.topic))) {
      rejected.push({ topic: candidate.topic, reason: "duplicate_of_published", detail: key });
      continue;
    }
    if (openKeys.has(key)) {
      rejected.push({ topic: candidate.topic, reason: "duplicate_of_open_run", detail: key });
      continue;
    }
    if (takenKeys.has(key)) {
      rejected.push({ topic: candidate.topic, reason: "duplicate_in_plan", detail: key });
      continue;
    }

    if (requests.length >= slots) {
      // Named by WHICH cap actually bound, so the rejection tells an operator what to raise —
      // "over_budget" and "over_run_cap" have different fixes and a generic "no slots" has none.
      // Ties resolve to the cheapest thing to change first: the run count, then the budget.
      const reason: PlanRejection["reason"] =
        slotsByRunCount === slots ? "over_run_cap" : slotsByBudget === slots ? "over_budget" : "over_concurrency";
      rejected.push({ topic: candidate.topic, reason, detail: `slots=${slots} (runCount=${slotsByRunCount}, budget=${slotsByBudget}, concurrency=${slotsByConcurrency})` });
      continue;
    }

    const requestId = mintRequestId(candidate.topic, now, runsAlreadyToday + requests.length + 1);
    // A minted id that does not satisfy the tenant's own grammar is refused HERE rather than by
    // start_dry_run twenty lines later: the plan an operator reads must contain only ids that can
    // actually start a run.
    if (pattern && !pattern.test(requestId)) {
      // Its OWN reason, not "unknown_archetype": this sends an operator to objectDialect.requestIdPattern,
      // and reusing the archetype reason sent them to edit the archetype list for an id-grammar fault.
      rejected.push({ topic: candidate.topic, reason: "request_id_unmintable", detail: `minted requestId "${requestId}" does not match ${inputs.requestIdPattern}` });
      continue;
    }

    takenKeys.add(key);
    requests.push({
      requestId,
      contentSource: { contract: "content_source.v1", kind: "commissioned_topic", topic: candidate.topic, readerState: candidate.readerState, archetypeId: archetype.id, archetypeJob: archetype.job },
      instructions: candidate.instructions,
      trafficSource: candidate.trafficSource ?? archetype.defaultTrafficSource,
      awarenessStage: candidate.awarenessStage ?? archetype.defaultAwarenessStage,
      rationale: candidate.rationale,
      dedupeKey: key
    });
  }

  return { ...base, requests, rejected, caps };
};

/** The blockage.v1 an operator sees when the planner has stopped itself. Shape pinned by the platform's BlockageCard. */
export const plannerHaltBlockage = (projectId: string, halt: PlannerHalt) => ({
  blockage_id: `blk_planner_halted_${projectId.replace(/[^a-z0-9]+/gi, "_")}`,
  contract: "blockage.v1",
  code: halt.code,
  kind: "limit" as const,
  message: halt.message,
  operator_action: "Revise the strategy's commissioning block, or resume commissioning to try again.",
  details: { consecutiveFailures: halt.consecutiveFailures, threshold: halt.threshold, projectId },
  remedies: [
    { id: "revise_strategy", type: "set_project_field", args: { field: "editorial_strategy.commissioning", projectId }, default: true },
    { id: "resume_planner", type: "resume", args: { scope: "planner", projectId } }
  ],
  scope: { node_id: COMMISSIONED_BY, run_id: `planner:${projectId}` }
});
