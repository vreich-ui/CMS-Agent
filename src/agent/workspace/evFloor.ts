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

  const rationale = [
    `floorUsd = runCostUsd(${runCostUsd}, real — never invented) x floorMultiplier(${floorMultiplier}) = ${floorUsd}.`,
    payoutUsd !== null
      ? `breakEvenConversions = floorUsd / payoutUsd(${payoutUsd}) = ${breakEvenConversions}.`
      : "payoutUsd not supplied (no offer selected, or payout unknown) — breakEvenConversions is null, not zero.",
    expectedValueUsd !== null
      ? `expectedValueUsd = payoutUsd x conversionRate(${conversionRate}) x estimatedVolume(${estimatedVolume}) = ${expectedValueUsd}, which ${meetsFloor ? "meets" : "does not meet"} floorUsd(${floorUsd}).`
      : "conversionRate and/or estimatedVolume not supplied — expectedValueUsd and meetsFloor are null, never fabricated."
  ].join(" ");

  return { artifact: "ev_floor.v1", runCostUsd, floorMultiplier, floorUsd, payoutUsd, conversionRate, estimatedVolume, expectedValueUsd, breakEvenConversions, meetsFloor, rationale };
}
