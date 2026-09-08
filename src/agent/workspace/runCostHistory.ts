// EV-FLOOR COST HISTORY (2026-09-08) — where `estimatedRunCost` comes from, now that it is not
// allowed to come from a model's imagination.
//
// THE FINDING THIS CLOSES. On run run_1788769566432_5qnafb (dr-lurie, content class `money`)
// monetization_strategy emitted `estimatedRunCost: 800` against an actual measured run cost of $3.86
// (375,963 tokens; article_body alone $1.51) — a figure ~200x high, which then demanded
// 800 x 1.25 = $1,000 of expected value before any article could clear the floor. No article clears
// $1,000, so the floor could never pass. This is the SAME class of defect W5 fixed once already
// (evFloor.ts's header: $250 invented against a $5.56 run); it recurred because W5 fixed the
// ARITHMETIC and left the INPUT to a model turn.
//
// WHY A NEW NUMBER IS NEEDED AT ALL. monetization_strategy runs at node 4 of 25, so THIS run's cost is
// not knowable yet — `monetize.ev_floor`'s existing "real accrued cost" reads a few cents, which is a
// true number answering the wrong question. The question the floor asks is "is this piece worth the
// cost of FINISHING it", and the only honest answer available at node 4 is what finishing this
// workflow has actually cost before, measured. That history already exists: nodeTimings.ts records
// {runId, workflowId, nodeId, durationMs, costUsd} on every node completion, and costUsd there is read
// back from the usage ledger — not estimated, not guessed.
//
// THE DERIVATION, STATED SO IT CAN BE ARGUED WITH:
//   1. Take this workflow's timing records, EXCLUDING the run being estimated (a run cannot be
//      evidence about itself: at node 4 its own partial spend would drag its own floor down).
//   2. Sum costUsd per runId -> one total per historical run.
//   3. Discard runs whose total is 0 (a run that recorded only deterministic completions is not
//      evidence about what a model-bearing run costs).
//   4. p50 (nearest-rank, the same definition nodeTimings.percentile already uses) of those totals.
//
// MEDIAN, NOT MEAN: one pathological run (a retry storm, a run that halted at node 2) must not move
// the floor. NEAREST-RANK, not interpolation: the same reason nodeTimings.ts states — well-defined at
// the tiny sample counts an early history actually has.
//
// PARTIAL RUNS ARE COUNTED, DELIBERATELY. A run that halted early contributes a small total and pulls
// the median DOWN, which lowers the floor, which makes the floor easier to clear. That is the
// fail-open direction, and it is the direction skipPredicates.ts's rule 3 demands of everything in
// this area: the cost of a floor that is too low is an article that was worth slightly less than it
// cost; the cost of a floor that is too high is the entire money pipeline offline, which is the defect
// being fixed.
//
// MINIMUM SAMPLES. Two runs, matching nodeTimings.ts's own stated discipline for its follow-ups ("a
// single run's aggregate is one sample per node, indistinguishable from noise"). Below that there is
// NO estimate — and the fallback is ZERO, not a round number. A $0 floor blocks nothing, which is the
// only honest thing an unmeasured floor can do; a fallback that is a large round number is exactly the
// $800 defect wearing a deterministic hat.
import type { RunCostBasis } from "./evFloor.js";
import { percentile, type NodeTimingRecord } from "./nodeTimings.js";

export const MIN_RUN_COST_HISTORY_SAMPLES = 2;

export type RunCostEstimate = {
  artifact: "run_cost_estimate.v1";
  // The projected cost of completing one run of this workflow, in USD. 0 when there is no history —
  // never a placeholder magnitude.
  estimatedRunCostUsd: number;
  basis: RunCostBasis;
  // How many historical runs the figure was derived from, and how many timing records they carried.
  sampleRuns: number;
  sampleRecords: number;
  // The per-run totals the median was taken over, ascending. This is what makes the number auditable
  // rather than merely deterministic.
  observedRunCostsUsd: number[];
  rationale: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

export type EstimateRunCostFromHistoryInput = {
  records: readonly NodeTimingRecord[];
  // The run being estimated. Its own records are excluded — see the header.
  excludeRunId?: string;
  minSamples?: number;
};

// Pure and total. Any input (including an empty ledger) yields a well-formed estimate; nothing here
// reads a repository, a network or a model.
export function estimateRunCostFromHistory(input: EstimateRunCostFromHistoryInput): RunCostEstimate {
  const minSamples = Number.isFinite(input.minSamples) && (input.minSamples as number) > 0 ? Math.floor(input.minSamples as number) : MIN_RUN_COST_HISTORY_SAMPLES;
  const usable = input.records.filter((record) => record.runId !== input.excludeRunId && Number.isFinite(record.costUsd));

  const totals = new Map<string, number>();
  for (const record of usable) totals.set(record.runId, (totals.get(record.runId) ?? 0) + Math.max(0, record.costUsd));

  const observed = [...totals.values()].filter((total) => total > 0).map(round2).sort((a, b) => a - b);

  if (observed.length < minSamples) {
    return {
      artifact: "run_cost_estimate.v1",
      estimatedRunCostUsd: 0,
      basis: "no_history",
      sampleRuns: observed.length,
      sampleRecords: usable.length,
      observedRunCostsUsd: observed,
      rationale: `No usable run-cost history for this workflow: ${observed.length} prior run(s) with recorded cost, fewer than the ${minSamples} this estimate requires. estimatedRunCostUsd is 0 and the EV floor it produces is $0 — an unmeasured floor blocks nothing, and a placeholder magnitude here is exactly the fabricated-cost defect this estimate exists to end.`
    };
  }

  const estimatedRunCostUsd = round2(percentile(observed, 50));
  return {
    artifact: "run_cost_estimate.v1",
    estimatedRunCostUsd,
    basis: "workflow_history",
    sampleRuns: observed.length,
    sampleRecords: usable.length,
    observedRunCostsUsd: observed,
    rationale: `estimatedRunCostUsd = p50 (nearest-rank) of ${observed.length} prior run total(s) for this workflow, each summed from the node timing ledger's measured costUsd: [${observed.join(", ")}] -> ${estimatedRunCostUsd}. Measured, never authored by a model; this run's own partial spend is excluded.`
  };
}
