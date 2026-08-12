// §2.16 (handoff 2026-08-10) — the aggression vector engine.
//
// Aggression is a FOUR-DIAL vector (Wolf's explicit design, handoff §5): claim_strength, urgency,
// emotional_agitation, cta_density. Two quantities exist and must never be conflated:
//
//   TARGET  — computed by placement_resolver from (trafficSource, awarenessStage). Computed, never
//             hand-set: the mapping below is the single deterministic source of a target vector, and
//             the placement_resolver node's execution path (executor.ts,
//             metadata.placementResolverDeterministic) calls it directly — no model turn shapes a
//             dial value, and missing inputs BLOCK the node rather than falling back to a model.
//   CEILING — declared by the CLIENT contract. The resolved vector consumed downstream is
//             min(ceiling, target) COMPONENTWISE, and an ABSENT ceiling is a BLOCKER, not a default
//             (Wolf's explicit decision) — the engine must refuse to resolve rather than invent a
//             permissive ceiling. A partial ceiling (any dial missing/invalid) blocks the same way.
//
// SCALE. Every dial is a number in [0, 1]: 0 = fully soft (no urgency, editorial-neutral claims, no
// CTA pressure), 1 = maximum aggression the system will ever aim for. The same scale applies to the
// target, the ceiling, and the resolved vector.
//
// CEILING CARRIER CONTRACT (the client-side schema change is out of scope here; this is the shape the
// client side must satisfy): the client's raw object contract carries a top-level field
// `aggression_ceiling` (accepted spellings: aggression_ceiling | aggressionCeiling) whose value is an
// object with ALL FOUR dials as numbers in [0, 1]:
//   { "claim_strength": 0.6, "urgency": 0.4, "emotional_agitation": 0.5, "cta_density": 0.7 }
// contractReduction.ts extracts it into ReducedContract.aggressionCeiling; resolveAggressionVector
// reads it from there and refuses (typed blocker) when it is absent or any dial is missing,
// non-numeric, or out of range.
//
// TARGET MAPPING TABLE. target = clamp01(base[awarenessStage] + delta[trafficTemperature]) per dial.
//
//   awareness stage    claim_strength  urgency  emotional_agitation  cta_density
//   unaware                 0.2          0.1          0.3                0.1
//   problem_aware           0.3          0.2          0.4                0.2
//   solution_aware          0.5          0.4          0.4                0.4
//   product_aware           0.7          0.6          0.5                0.6
//   most_aware              0.8          0.8          0.4                0.8
//
//   traffic temperature    delta (all four dials)
//   cold  (search/SEO/organic social/discover)      -0.1
//   paid  (paid search/paid social/display ads)     +0.05
//   warm  (email/newsletter/direct/returning/sms)   +0.1
//
// Rationale: awareness stage sets the base — a problem-aware reader has not been sold a solution yet,
// so claims stay modest and CTAs sparse; a most-aware reader came to transact, so urgency and CTA
// density rise while emotional agitation actually eases off (they need a reason to act now, not to be
// worked up). Traffic temperature shifts the whole vector — cold search traffic has no relationship
// with the property (soften everything, e.g. cold search + problem-aware ⇒ claim 0.2 / urgency 0.1),
// warm owned-audience traffic already trusts it (e.g. warm email + product-aware ⇒ claim 0.8 /
// urgency 0.7), paid sits between (the click was bought, not earned, but it was intentful).
//
// An UNRECOGNIZED (but present) value normalizes to the most conservative bucket — cold / unaware —
// with the normalization recorded in the rationale: a computed conservative target beats both a
// brittle blocker on vocabulary and a silently permissive default. A MISSING value is different: it
// cannot be computed around and blocks the node (executor.ts).

import type { ReducedContract } from "./contractReduction.js";

export const AGGRESSION_DIALS = ["claim_strength", "urgency", "emotional_agitation", "cta_density"] as const;
export type AggressionDial = typeof AGGRESSION_DIALS[number];
export type AggressionVector = Record<AggressionDial, number>;

export const PLACEMENT_RESOLUTION_ARTIFACT = "placement_resolution.v1";

export type AwarenessStage = "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "most_aware";
export type TrafficTemperature = "cold" | "paid" | "warm";

const BASE_BY_AWARENESS: Record<AwarenessStage, AggressionVector> = {
  unaware: { claim_strength: 0.2, urgency: 0.1, emotional_agitation: 0.3, cta_density: 0.1 },
  problem_aware: { claim_strength: 0.3, urgency: 0.2, emotional_agitation: 0.4, cta_density: 0.2 },
  solution_aware: { claim_strength: 0.5, urgency: 0.4, emotional_agitation: 0.4, cta_density: 0.4 },
  product_aware: { claim_strength: 0.7, urgency: 0.6, emotional_agitation: 0.5, cta_density: 0.6 },
  most_aware: { claim_strength: 0.8, urgency: 0.8, emotional_agitation: 0.4, cta_density: 0.8 }
};

const DELTA_BY_TEMPERATURE: Record<TrafficTemperature, number> = { cold: -0.1, paid: 0.05, warm: 0.1 };

const TEMPERATURE_BY_SOURCE: Record<string, TrafficTemperature> = {
  cold_search: "cold", search: "cold", organic_search: "cold", seo: "cold", organic_social: "cold",
  social: "cold", discover: "cold", news: "cold", ai_answer: "cold",
  paid_search: "paid", paid_social: "paid", ads: "paid", display: "paid", ppc: "paid", affiliate: "paid",
  email: "warm", newsletter: "warm", direct: "warm", returning: "warm", referral: "warm",
  owned_audience: "warm", sms: "warm", push: "warm"
};

// W6.5 (2026-08-12) — the canonical value lists, exported so any JSON Schema that wants to validate a
// trafficSource/awarenessStage field (rather than accept it as an untyped free string) derives its
// `enum` from here instead of hand-copying a list that can silently drift out of sync with the mapping
// tables above. AWARENESS_STAGE_VALUES is the closed, five-value set computeAggressionTarget will
// normalize any OTHER string down to "unaware" for (never a schema-validation failure at that call
// site — see the module comment at the top of this file); RECOGNIZED_TRAFFIC_SOURCES is the token set
// TEMPERATURE_BY_SOURCE recognizes without falling back to "cold". Neither list should be imported to
// retroactively reject placement_resolver's own trafficSource/awarenessStage echo fields — those are
// deliberately tolerant free strings by design (an unrecognized value normalizes rather than blocks);
// these exports exist for OTHER schemas (contract_intelligence.v1, article_brief.v1) that want to
// validate a value they expect to already be one of the recognized ones.
export const AWARENESS_STAGE_VALUES: readonly AwarenessStage[] = Object.keys(BASE_BY_AWARENESS) as AwarenessStage[];
export const RECOGNIZED_TRAFFIC_SOURCES: readonly string[] = Object.keys(TEMPERATURE_BY_SOURCE);

const AWARENESS_STAGES = new Set<string>(AWARENESS_STAGE_VALUES);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeToken = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, "_");
const clamp01 = (value: number): number => Math.min(1, Math.max(0, Math.round(value * 100) / 100));

export type AggressionTargetComputation = {
  target: AggressionVector;
  trafficSource: string;
  awarenessStage: string;
  trafficTemperature: TrafficTemperature;
  normalizedAwarenessStage: AwarenessStage;
  rationale: string;
};

// The one place a target vector comes from. Pure and total for any two non-empty strings: recognized
// values map through the table; unrecognized values normalize to the most conservative bucket with
// the normalization named in the rationale.
export function computeAggressionTarget(trafficSource: string, awarenessStage: string): AggressionTargetComputation {
  const sourceToken = normalizeToken(trafficSource);
  const stageToken = normalizeToken(awarenessStage);
  const trafficTemperature = TEMPERATURE_BY_SOURCE[sourceToken] ?? "cold";
  const normalizedAwarenessStage = (AWARENESS_STAGES.has(stageToken) ? stageToken : "unaware") as AwarenessStage;
  const base = BASE_BY_AWARENESS[normalizedAwarenessStage];
  const delta = DELTA_BY_TEMPERATURE[trafficTemperature];
  const target = Object.fromEntries(AGGRESSION_DIALS.map((dial) => [dial, clamp01(base[dial] + delta)])) as AggressionVector;
  const normalizationNotes = [
    ...(TEMPERATURE_BY_SOURCE[sourceToken] ? [] : [`trafficSource "${trafficSource}" is not a recognized source; treated as cold (most conservative)`]),
    ...(AWARENESS_STAGES.has(stageToken) ? [] : [`awarenessStage "${awarenessStage}" is not a recognized stage; treated as unaware (most conservative)`])
  ];
  const rationale = [
    `Deterministic target: base vector for awareness stage "${normalizedAwarenessStage}" shifted ${delta >= 0 ? "+" : ""}${delta} on every dial for ${trafficTemperature} traffic ("${trafficSource}"), clamped to [0,1].`,
    ...normalizationNotes
  ].join(" ");
  return { target, trafficSource, awarenessStage, trafficTemperature, normalizedAwarenessStage, rationale };
}

export type PlacementSignals = { trafficSource?: string; awarenessStage?: string };

const readSignalFrom = (value: unknown, keys: string[]): string | undefined => {
  if (!isPlainObject(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
};

// Placement signals live in the run's request, not in engine configuration: read from each candidate
// carrier in order (an upstream stage output like input_triage's content_source.v1 envelope first,
// then the run's own initial input), at the top level or nested under `contentSource`. First hit wins
// per signal. Missing here means the node cannot compute a target and must block — never guess.
export function extractPlacementSignals(...carriers: unknown[]): PlacementSignals {
  const signals: PlacementSignals = {};
  for (const carrier of carriers) {
    for (const value of [carrier, isPlainObject(carrier) ? carrier.contentSource : undefined]) {
      signals.trafficSource ??= readSignalFrom(value, ["trafficSource", "traffic_source"]);
      signals.awarenessStage ??= readSignalFrom(value, ["awarenessStage", "awareness_stage"]);
    }
  }
  return signals;
}

export type PlacementResolution = {
  artifact: typeof PLACEMENT_RESOLUTION_ARTIFACT;
  summary: string;
  trafficSource: string;
  awarenessStage: string;
  target: AggressionVector;
  rationale: string;
  notes: string[];
};

// The full placement_resolution.v1 artifact, built deterministically. This is what the
// placement_resolver node's execution path emits (validated against the node's own outputSchema by
// the executor before it counts as completed).
export function buildPlacementResolution(trafficSource: string, awarenessStage: string): PlacementResolution {
  const computed = computeAggressionTarget(trafficSource, awarenessStage);
  return {
    artifact: PLACEMENT_RESOLUTION_ARTIFACT,
    summary: `Aggression TARGET computed deterministically from trafficSource "${trafficSource}" (${computed.trafficTemperature}) and awarenessStage "${computed.normalizedAwarenessStage}": ` +
      AGGRESSION_DIALS.map((dial) => `${dial}=${computed.target[dial]}`).join(", ") +
      " (0-1 scale). This is the TARGET only; the resolved vector is min(client ceiling, target) componentwise, and an absent ceiling blocks resolution.",
    trafficSource,
    awarenessStage,
    target: computed.target,
    rationale: computed.rationale,
    notes: ["Target computed by src/agent/workspace/aggressionVector.ts; dial values are never hand-set."]
  };
}

// Read a placement_resolution.v1 target back out of a stage output. Refuses placeholders (a mock
// run's dryRun-marked artifact must never feed a real resolution — same posture as
// readPublicationDecision) and anything without four in-range numeric dials.
export function readPlacementTarget(value: unknown): AggressionVector | undefined {
  if (!isPlainObject(value) || value.artifact !== PLACEMENT_RESOLUTION_ARTIFACT || value.dryRun === true) return undefined;
  const target = value.target;
  if (!isPlainObject(target)) return undefined;
  const dials = AGGRESSION_DIALS.map((dial) => [dial, target[dial]] as const);
  if (!dials.every(([, dialValue]) => typeof dialValue === "number" && Number.isFinite(dialValue) && dialValue >= 0 && dialValue <= 1)) return undefined;
  return Object.fromEntries(dials) as AggressionVector;
}

export type AggressionBlocker = { code: "aggression_ceiling_missing" | "aggression_ceiling_invalid"; message: string };
export type AggressionResolution =
  | { ok: true; resolved: AggressionVector; ceiling: AggressionVector; target: AggressionVector }
  | { ok: false; blocker: AggressionBlocker };

// resolved = min(ceiling, target) COMPONENTWISE. The ceiling comes from the reduced client contract
// (ReducedContract.aggressionCeiling, extracted from the raw contract's aggression_ceiling field —
// see the carrier contract at the top of this file). Absent ceiling ⇒ typed blocker, never a default;
// a ceiling missing any dial, or carrying a non-numeric/out-of-range dial, blocks identically — a
// partial ceiling is not a ceiling.
export function resolveAggressionVector(target: AggressionVector, contract: Pick<ReducedContract, "aggressionCeiling">): AggressionResolution {
  const raw = contract.aggressionCeiling;
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      blocker: {
        code: "aggression_ceiling_missing",
        message: "The client contract declares no aggression ceiling (expected top-level aggression_ceiling with all four dials as numbers in [0,1]). An absent ceiling is a blocker, not a default — the aggression vector cannot be resolved for this client until its contract carries one."
      }
    };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, blocker: { code: "aggression_ceiling_invalid", message: `The client contract's aggression ceiling is not an object (got ${JSON.stringify(raw).slice(0, 80)}); it must carry all four dials as numbers in [0,1].` } };
  }
  const bad = AGGRESSION_DIALS.filter((dial) => {
    const value = raw[dial];
    return typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1;
  });
  if (bad.length) {
    return { ok: false, blocker: { code: "aggression_ceiling_invalid", message: `The client contract's aggression ceiling is missing or malformed for dial(s): ${bad.join(", ")}. A partial ceiling is a blocker — every dial must be a number in [0,1].` } };
  }
  const ceiling = Object.fromEntries(AGGRESSION_DIALS.map((dial) => [dial, raw[dial] as number])) as AggressionVector;
  const resolved = Object.fromEntries(AGGRESSION_DIALS.map((dial) => [dial, Math.min(ceiling[dial], target[dial])])) as AggressionVector;
  return { ok: true, resolved, ceiling, target };
}
