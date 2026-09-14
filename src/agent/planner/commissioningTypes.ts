// The CONSUMER side of `editorial_strategy.commissioning` (Track C, Wolf 2026-09-14).
//
// The platform owns the contract (packages/core/schema/bodies/editorial-strategy-v1.ts); this is the
// engine's reading of it. Declared locally rather than imported for the reason every cross-plane
// type in this repo is: the two repos deploy independently, so a shared import would make a platform
// release able to break an engine build, and a type the engine cannot compile is a tenant the engine
// cannot plan for.
//
// READ DEFENSIVELY, WRITE NOTHING. Every field arrives over MCP from a tenant that may be running an
// older platform, may have been hand-edited, or may have no commissioning block at all. So this
// module's job is to turn "whatever came back from object_get" into either a policy the planner can
// clamp itself to, or a stated reason it cannot plan — never an exception and never a guess.
//
// THE DEFAULTS ARE THE SAFE END OF EVERY RANGE. A malformed number does not fall back to the
// tenant's intent; it falls back to the most conservative value, because the failure mode of reading
// "10" as "1" is a quiet day and the failure mode of reading "1" as "10" is ten articles and a bill.

export const READER_STATES = ["recognition", "understanding", "investigation", "selection"] as const;
export type ReaderState = (typeof READER_STATES)[number];

export const TRAFFIC_SOURCES = ["organic_search", "organic_social", "paid_search", "paid_social", "email", "direct", "referral"] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

export const AWARENESS_STAGES = ["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"] as const;
export type AwarenessStage = (typeof AWARENESS_STAGES)[number];

export type CommissioningArchetype = { id: string; job: string; defaultTrafficSource: TrafficSource; defaultAwarenessStage: AwarenessStage };
export type CommissioningSeed = { topic: string; readerState: ReaderState; archetypeId: string; trafficSource?: TrafficSource; awarenessStage?: AwarenessStage; priority: number };
export type ReaderStateMix = Record<ReaderState, number>;

export type Commissioning = {
  enabled: boolean;
  runsPerDay: number;
  dailyBudgetUsd: number;
  maxConcurrentRuns: number;
  stopAfterConsecutiveFailures: number;
  readerStateMix: ReaderStateMix;
  archetypes: CommissioningArchetype[];
  seeds: CommissioningSeed[];
  exclusions: string[];
};

/** The conservative floor every malformed or absent value falls back to. Never the tenant's intent — see the header. */
export const COMMISSIONING_DEFAULTS = {
  enabled: false,
  runsPerDay: 1,
  dailyBudgetUsd: 10,
  maxConcurrentRuns: 1,
  stopAfterConsecutiveFailures: 2,
  readerStateMix: { recognition: 0.25, understanding: 0.25, investigation: 0.25, selection: 0.25 } as ReaderStateMix
} as const;

/** Hard engine ceilings. A strategy cannot raise itself past these, however it is edited. */
export const COMMISSIONING_CEILINGS = { runsPerDay: 20, dailyBudgetUsd: 200, maxConcurrentRuns: 5 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const clampedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const clampedNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

const trimmed = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const readMix = (value: unknown): ReaderStateMix => {
  if (!isRecord(value)) return { ...COMMISSIONING_DEFAULTS.readerStateMix };
  const mix = {} as ReaderStateMix;
  for (const state of READER_STATES) mix[state] = clampedNumber(value[state], 0, 0, 1);
  // An all-zero mix names no reader state at all, which would make every candidate equally
  // off-strategy. That is indistinguishable from "not configured", so it IS not configured.
  return READER_STATES.some((state) => mix[state] > 0) ? mix : { ...COMMISSIONING_DEFAULTS.readerStateMix };
};

const readArchetypes = (value: unknown): CommissioningArchetype[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const archetypes: CommissioningArchetype[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = trimmed(entry.id);
    const job = trimmed(entry.job);
    const trafficSource = oneOf(entry.defaultTrafficSource, TRAFFIC_SOURCES);
    const awarenessStage = oneOf(entry.defaultAwarenessStage, AWARENESS_STAGES);
    // All four or none. A half-read archetype would be commissioned against a placement vector
    // nobody chose, which `placement_resolver` would happily turn into a real aggression setting.
    if (!id || !job || !trafficSource || !awarenessStage || seen.has(id)) continue;
    seen.add(id);
    archetypes.push({ id, job, defaultTrafficSource: trafficSource, defaultAwarenessStage: awarenessStage });
  }
  return archetypes;
};

const readSeeds = (value: unknown, archetypes: CommissioningArchetype[]): CommissioningSeed[] => {
  if (!Array.isArray(value)) return [];
  const known = new Set(archetypes.map((archetype) => archetype.id));
  const seeds: CommissioningSeed[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const topic = trimmed(entry.topic);
    const readerState = oneOf(entry.readerState, READER_STATES);
    const archetypeId = trimmed(entry.archetypeId);
    // A seed pointing at an archetype this strategy does not define is dropped rather than
    // commissioned against a guessed reader. The platform refuses that shape at write; a tenant on
    // an older platform can still have one on record, and this is where it stops.
    if (!topic || !readerState || !archetypeId || !known.has(archetypeId)) continue;
    seeds.push({
      topic,
      readerState,
      archetypeId,
      ...(oneOf(entry.trafficSource, TRAFFIC_SOURCES) ? { trafficSource: oneOf(entry.trafficSource, TRAFFIC_SOURCES)! } : {}),
      ...(oneOf(entry.awarenessStage, AWARENESS_STAGES) ? { awarenessStage: oneOf(entry.awarenessStage, AWARENESS_STAGES)! } : {}),
      priority: typeof entry.priority === "number" && Number.isFinite(entry.priority) ? entry.priority : 0
    });
  }
  return seeds;
};

/**
 * Read a strategy body's `commissioning` block. Returns `undefined` when the tenant has none — which
 * is not an error anywhere in this system, and is the state of every site until an operator decides
 * otherwise.
 */
export const readCommissioning = (strategyBody: unknown): Commissioning | undefined => {
  if (!isRecord(strategyBody)) return undefined;
  const raw = strategyBody.commissioning;
  if (!isRecord(raw)) return undefined;
  const archetypes = readArchetypes(raw.archetypes);
  return {
    enabled: raw.enabled === true,
    runsPerDay: clampedInt(raw.runsPerDay, COMMISSIONING_DEFAULTS.runsPerDay, 0, COMMISSIONING_CEILINGS.runsPerDay),
    dailyBudgetUsd: clampedNumber(raw.dailyBudgetUsd, COMMISSIONING_DEFAULTS.dailyBudgetUsd, 0, COMMISSIONING_CEILINGS.dailyBudgetUsd),
    maxConcurrentRuns: clampedInt(raw.maxConcurrentRuns, COMMISSIONING_DEFAULTS.maxConcurrentRuns, 1, COMMISSIONING_CEILINGS.maxConcurrentRuns),
    stopAfterConsecutiveFailures: clampedInt(raw.stopAfterConsecutiveFailures, COMMISSIONING_DEFAULTS.stopAfterConsecutiveFailures, 1, 20),
    readerStateMix: readMix(raw.readerStateMix),
    archetypes,
    seeds: readSeeds(raw.seeds, archetypes),
    exclusions: Array.isArray(raw.exclusions) ? raw.exclusions.map(trimmed).filter((entry): entry is string => Boolean(entry)) : []
  };
};
