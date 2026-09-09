// §W5 (2026-08-12, docs/plan/WORK-ORDER-2026-08-12-determinism.md) — deterministic EV-floor
// arithmetic for monetization_strategy.
//
// The finding that drove this module: on run run_1786468126136_ev9goe, monetization_strategy
// INVENTED estimatedRunCost:$250 (actual run cost was $5.56 — 45x off) because nothing fed the node
// real cost data; a model turn guessed a round number rather than reading it. This module is pure
// arithmetic and never talks to a model or a network — the one non-deterministic input (the run's
// actual accrued cost) is supplied by the caller (monetize.ev_floor in toolRegistry.ts), which reads
// it server-side via summarizeModelUsage's totalCostUsdEstimate — the same figure the existing
// workflow_get_run_cost capability reports — instead of letting a model turn fabricate it.
//
// EV floor: an offer is worth aiming a brief at only once its expected value is projected to clear
// the floor (runCostUsd x floorMultiplier; floorMultiplier defaults to 1 — break-even against what
// the run has actually cost so far). expectedValueUsd is payoutUsd x conversionRate x
// estimatedVolume, computed ONLY when all three are supplied; when any is missing this returns null
// rather than a fabricated number, alongside the always-computable breakEvenConversions/floorUsd so a
// caller can still reason about the offer without inventing a volume estimate.

// 2026-09-08 — THE SAME DEFECT, RECURRED, AND THE TWO FIELDS THAT CLOSE IT FOR GOOD.
// On run_1788769566432_5qnafb the node emitted estimatedRunCost:800 against a $3.86 run. W5 fixed the
// arithmetic; the INPUT was still a model turn. runCostHistory.ts now derives the figure from measured
// history and the conductor prefetches it (costPrefetch.ts), so this module gains only what it needs to
// STATE THAT PROVENANCE in its own artifact:
//
//   runCostBasis  — where runCostUsd came from. "A historical mean is not a stated assumption."
//   estimateBasis — whether the WHOLE estimate rests on live data. This is the field the
//                   `ev_floor_blocked` skip predicate gates on (skipPredicates.ts), and the reason it
//                   is derived HERE rather than authored by a node: a block is allowed to stop a run
//                   only when it was EARNED — cost measured AND revenue from a live Monetizer query.
//                   With Monetizer down, every money run yields "mixed" at best, the predicate never
//                   fires, and the publishing pipeline stays up. That is the whole safety property.
//   verdict       — the artifact's own conclusion, so a node copies a value instead of re-deriving one.

// Where runCostUsd came from. Only the two MEASURED bases ("workflow_history", "accrued_run_cost")
// count toward an earned block; "caller_override" is a test/dry-estimate path and "no_history" is the
// honest absence of a figure.
export type RunCostBasis = "workflow_history" | "accrued_run_cost" | "caller_override" | "no_history";

// Where the revenue side came from. There is no third value on purpose: either a live Monetizer query
// supplied the payout this run, or it is an assumption.
export type RevenueBasis = "monetizer_data" | "stated_assumption";

// 2026-09-09 — WHERE THE VOLUME CAME FROM, and why it needed its own axis.
//
// The cost fix left `expectedValue`'s two biggest multipliers — traffic and conversion rate — still
// authored by a model turn, and that got MORE dangerous once a block could halt a run: with the
// monetizer back up, a node could honestly label the whole estimate "monetizer_data" (the payout
// really is live) while the volume it multiplied by was invented, and stop a real article on a number
// nobody measured. `revenueBasis` cannot express that difference — a payout and a traffic figure come
// from two different systems — so the volume gets its own basis, and an EARNED block now requires
// BOTH to be measured. trafficHistory.ts supplies the measured one from the tracking sink's ingested
// engagement rows.
export type VolumeBasis = "tracking_engagement" | "stated_assumption";

// The basis of the estimate AS A WHOLE — the vocabulary the skip predicate reads.
export type EstimateBasis = "monetizer_data" | "mixed" | "stated_assumption";

// The ONE value that makes a block enforceable. Named here, next to the derivation, so the predicate
// and the artifact can never drift about which word means "earned".
export const EARNED_BLOCK_ESTIMATE_BASIS: EstimateBasis = "monetizer_data";

export type EvFloorVerdict = "proceed" | "block" | "unknown";

const MEASURED_RUN_COST_BASES: readonly RunCostBasis[] = ["workflow_history", "accrued_run_cost"];

export type EvFloorInput = {
  // Real, non-fabricated run cost in USD — the caller is expected to have obtained this from
  // workflow_get_run_cost's ledger.totalCostUsdEstimate (or an equivalent live source), never a
  // model-guessed figure.
  runCostUsd: number;
  // The selected offer's payout per conversion, if one has been selected. Omit for a no-offer
  // decision; breakEvenConversions/expectedValueUsd are then not computable (null, not zero).
  payoutUsd?: number;
  // Probability of conversion per unit of estimatedVolume, in [0, 1].
  conversionRate?: number;
  // Expected clicks/views/sessions the offer will see over the horizon being evaluated.
  estimatedVolume?: number;
  // Multiple of runCostUsd the offer must clear to pass. Default 1 (break-even); >1 demands margin.
  floorMultiplier?: number;
  // Provenance of runCostUsd. Omitted means the caller did not say, which is treated as unmeasured —
  // never as measured, because an unstated provenance must never be able to earn a block.
  runCostBasis?: RunCostBasis;
  // Provenance of payoutUsd/conversionRate. Omitted means stated_assumption.
  revenueBasis?: RevenueBasis;
  // Provenance of estimatedVolume. Omitted means stated_assumption — an unstated provenance is never
  // treated as measured, so a caller that simply forgets this field cannot earn a block with it.
  volumeBasis?: VolumeBasis;
};

export type EvFloorResult = {
  artifact: "ev_floor.v1";
  runCostUsd: number;
  floorMultiplier: number;
  floorUsd: number;
  payoutUsd: number | null;
  conversionRate: number | null;
  estimatedVolume: number | null;
  expectedValueUsd: number | null;
  breakEvenConversions: number | null;
  // null (not false) when expectedValueUsd could not be computed — a missing input is not "does not
  // meet the floor", it is "unknown", and the two must never be conflated.
  meetsFloor: boolean | null;
  // Provenance, carried on the artifact so no reader has to ask the node where a number came from.
  runCostBasis: RunCostBasis;
  revenueBasis: RevenueBasis;
  volumeBasis: VolumeBasis;
  estimateBasis: EstimateBasis;
  // "block" only when the floor was actually computed and missed. A null meetsFloor is "unknown",
  // never "block" — the two must not be conflated, here least of all: `verdict` is what a skip
  // predicate reads, and reading "unknown" as "block" would take the pipeline offline.
  verdict: EvFloorVerdict;
  rationale: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const finiteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const unitInterval = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// Pure and total: any input (including all-optional fields omitted) yields a well-formed result.
// Never throws, never guesses a missing number — a field that cannot be computed is null.
export function computeEvFloor(input: EvFloorInput): EvFloorResult {
  const runCostUsd = finiteNonNegative(input.runCostUsd) ? input.runCostUsd : 0;
  const floorMultiplier = finitePositive(input.floorMultiplier) ? input.floorMultiplier : 1;
  const floorUsd = round2(runCostUsd * floorMultiplier);

  const payoutUsd = finitePositive(input.payoutUsd) ? input.payoutUsd : null;
  const conversionRate = unitInterval(input.conversionRate) ? input.conversionRate : null;
  const estimatedVolume = finiteNonNegative(input.estimatedVolume) ? input.estimatedVolume : null;

  const breakEvenConversions = payoutUsd !== null ? round2(floorUsd / payoutUsd) : null;
  const expectedValueUsd = payoutUsd !== null && conversionRate !== null && estimatedVolume !== null
    ? round2(payoutUsd * conversionRate * estimatedVolume)
    : null;
  const meetsFloor = expectedValueUsd === null ? null : expectedValueUsd >= floorUsd;
  const verdict: EvFloorVerdict = meetsFloor === null ? "unknown" : meetsFloor ? "proceed" : "block";

  const runCostBasis: RunCostBasis = input.runCostBasis ?? "no_history";
  const revenueBasis: RevenueBasis = input.revenueBasis === "monetizer_data" ? "monetizer_data" : "stated_assumption";
  const volumeBasis: VolumeBasis = input.volumeBasis === "tracking_engagement" ? "tracking_engagement" : "stated_assumption";
  // "Measured" on the revenue side means THREE things at once: the caller named a live payout source,
  // the volume came from measured engagement, and all three figures are actually present. A caller
  // claiming monetizer_data while omitting the payout has measured nothing; a caller with a live
  // payout and an invented traffic number has measured a third of what the product needs.
  const costMeasured = MEASURED_RUN_COST_BASES.includes(runCostBasis);
  const revenueMeasured = revenueBasis === "monetizer_data" && volumeBasis === "tracking_engagement" && payoutUsd !== null && conversionRate !== null && estimatedVolume !== null;
  const estimateBasis: EstimateBasis = costMeasured && revenueMeasured ? "monetizer_data" : (costMeasured || revenueMeasured ? "mixed" : "stated_assumption");

  const rationale = [
    `floorUsd = runCostUsd(${runCostUsd}, real — never invented) x floorMultiplier(${floorMultiplier}) = ${floorUsd}.`,
    payoutUsd !== null
      ? `breakEvenConversions = floorUsd / payoutUsd(${payoutUsd}) = ${breakEvenConversions}.`
      : "payoutUsd not supplied (no offer selected, or payout unknown) — breakEvenConversions is null, not zero.",
    expectedValueUsd !== null
      ? `expectedValueUsd = payoutUsd x conversionRate(${conversionRate}) x estimatedVolume(${estimatedVolume}) = ${expectedValueUsd}, which ${meetsFloor ? "meets" : "does not meet"} floorUsd(${floorUsd}).`
      : "conversionRate and/or estimatedVolume not supplied — expectedValueUsd and meetsFloor are null, never fabricated.",
    `runCostBasis = ${runCostBasis}; revenueBasis = ${revenueBasis}; volumeBasis = ${volumeBasis}; estimateBasis = ${estimateBasis}. verdict = ${verdict}.`,
    estimateBasis === "monetizer_data"
      ? "Both sides came from live data this run, so a block here is EARNED and may stop the run."
      : "At least one side is assumed rather than measured, so a block here is advisory only and never stops a run."
  ].join(" ");

  return { artifact: "ev_floor.v1", runCostUsd, floorMultiplier, floorUsd, payoutUsd, conversionRate, estimatedVolume, expectedValueUsd, breakEvenConversions, meetsFloor, runCostBasis, revenueBasis, volumeBasis, estimateBasis, verdict, rationale };
}
