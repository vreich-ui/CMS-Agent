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

// W0.5 (2026-09-09) — ONE TENANT'S HISTORY, NOT FOUR TENANTS' AVERAGE.
//
// The derivation above is sound and was reading the wrong rows. `workflowId` is shared: dr-lurie,
// zilberman, platform and fernwell all run `publishing_conductor`, and until W0.1 the timing ledger
// recorded no projectId at all, so "this workflow's prior run totals" meant "every tenant's prior run
// totals, pooled". A floor derived that way charges a cheap tenant the expensive tenant's prices and
// vice versa — and this is a LIVE consumer that can block a run, not a read-only figure.
//
// The scoping rule, and the direction it fails in: prefer this project's own history; fall back to
// the pooled figure only when the project has fewer than minSamples of its own, and SAY SO
// (`scope: "pooled"`, warning `ev_floor_history_pooled`) rather than passing a pooled number off as
// the tenant's. Pre-W0.1 records carry no projectId and are therefore invisible to a scoped read —
// which on day one means most tenants fall back to pooled, and as attributed samples accumulate each
// tenant peels off onto its own figure. Below minSamples in both, the estimate stays 0 and the floor
// blocks nothing, which is the same fail-open the header already argues for.
export const MIN_RUN_COST_HISTORY_SAMPLES = 2;

// Which population the estimate was actually taken over. Separate from `basis` deliberately: `basis`
// is a closed set shared with evFloor.ts's arithmetic (RunCostBasis) and answers "what KIND of number
// is this"; scope answers "whose history is it", which is the question that was being answered wrong.
export type RunCostHistoryScope = "project" | "pooled" | "none";

export type RunCostEstimate = {
  artifact: "run_cost_estimate.v1";
  // The projected cost of completing one run of this workflow, in USD. 0 when there is no history —
  // never a placeholder magnitude.
  estimatedRunCostUsd: number;
  basis: RunCostBasis;
  scope: RunCostHistoryScope;
  // The tenant the estimate was scoped to, when it was scoped to one.
  projectId?: string;
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
  // W0.5 — scope the estimate to one tenant. Omitted, this behaves exactly as it did before the
  // scoping rule existed (scope "pooled"), so no caller that has no projectId changes meaning.
  projectId?: string;
};

// The per-run totals a set of records implies. Split out because the scoped and pooled passes need
// exactly the same arithmetic over different populations, and the two must not be able to drift.
const runTotals = (records: readonly NodeTimingRecord[]): number[] => {
  const totals = new Map<string, number>();
  for (const record of records) totals.set(record.runId, (totals.get(record.runId) ?? 0) + Math.max(0, record.costUsd));
  return [...totals.values()].filter((total) => total > 0).map(round2).sort((a, b) => a - b);
};

// Pure and total. Any input (including an empty ledger) yields a well-formed estimate; nothing here
// reads a repository, a network or a model.
export function estimateRunCostFromHistory(input: EstimateRunCostFromHistoryInput): RunCostEstimate {
  const minSamples = Number.isFinite(input.minSamples) && (input.minSamples as number) > 0 ? Math.floor(input.minSamples as number) : MIN_RUN_COST_HISTORY_SAMPLES;
  // Phase samples carry no cost and would only add rows to sampleRecords; excluded so the count a
  // reader sees is the count the median was actually taken over.
  const usable = input.records.filter((record) => record.runId !== input.excludeRunId && record.phase === undefined && Number.isFinite(record.costUsd));

  const scoped = input.projectId === undefined ? undefined : usable.filter((record) => record.projectId === input.projectId);
  const scopedObserved = scoped ? runTotals(scoped) : [];

  // The tenant's own history wins whenever it is deep enough. Nothing pooled is consulted in that
  // case — not as a sanity check, not as a blend: one tenant's measured cost is the answer to
  // "what does finishing this run cost HERE".
  if (scoped && scopedObserved.length >= minSamples) {
    const estimatedRunCostUsd = round2(percentile(scopedObserved, 50));
    return {
      artifact: "run_cost_estimate.v1",
      estimatedRunCostUsd,
      basis: "workflow_history",
      scope: "project",
      projectId: input.projectId,
      sampleRuns: scopedObserved.length,
      sampleRecords: scoped.length,
      observedRunCostsUsd: scopedObserved,
      rationale: `estimatedRunCostUsd = p50 (nearest-rank) of ${scopedObserved.length} prior run total(s) for this workflow ON PROJECT "${input.projectId}", each summed from the node timing ledger's measured costUsd: [${scopedObserved.join(", ")}] -> ${estimatedRunCostUsd}. Measured, never authored by a model; this run's own partial spend is excluded, and no other tenant's runs are counted.`
    };
  }

  const observed = runTotals(usable);
  const pooledFallback = scoped !== undefined;

  if (observed.length < minSamples) {
    return {
      artifact: "run_cost_estimate.v1",
      estimatedRunCostUsd: 0,
      basis: "no_history",
      scope: "none",
      ...(input.projectId ? { projectId: input.projectId } : {}),
      sampleRuns: observed.length,
      sampleRecords: usable.length,
      observedRunCostsUsd: observed,
      rationale: `No usable run-cost history for this workflow${input.projectId ? ` on project "${input.projectId}" or pooled across tenants` : ""}: ${observed.length} prior run(s) with recorded cost, fewer than the ${minSamples} this estimate requires. estimatedRunCostUsd is 0 and the EV floor it produces is $0 — an unmeasured floor blocks nothing, and a placeholder magnitude here is exactly the fabricated-cost defect this estimate exists to end.`
    };
  }

  const estimatedRunCostUsd = round2(percentile(observed, 50));
  return {
    artifact: "run_cost_estimate.v1",
    estimatedRunCostUsd,
    basis: "workflow_history",
    scope: "pooled",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    sampleRuns: observed.length,
    sampleRecords: usable.length,
    observedRunCostsUsd: observed,
    rationale: `estimatedRunCostUsd = p50 (nearest-rank) of ${observed.length} prior run total(s) for this workflow, each summed from the node timing ledger's measured costUsd: [${observed.join(", ")}] -> ${estimatedRunCostUsd}. Measured, never authored by a model; this run's own partial spend is excluded.${pooledFallback ? ` POOLED ACROSS TENANTS: project "${input.projectId}" has only ${scopedObserved.length} attributable prior run(s) of its own, fewer than the ${minSamples} required, so this figure includes other tenants' runs of the same workflow and may not reflect what this site costs.` : ""}`
  };
}
