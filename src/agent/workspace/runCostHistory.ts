// QUALIFIED EV-FLOOR COST HISTORY (W3, 2026-09-10).
//
// A timing row is evidence of one attempt, not proof that a workflow finished. In particular,
// two failed prefixes ($0.10 and $0.20) must never be treated as two cheap completed runs beside a
// $5 completion. This module accepts only bounded, completed run candidates supplied by the caller,
// verifies current-stage coverage and route/tenant provenance, then sums every real attempt in each
// qualified run exactly once. It deliberately has no repository access: selection is the caller's
// bounded responsibility, qualification is pure and auditable here.
import type { WorkflowExecutionRecord } from "./executionTypes.js";
import type { RunCostBasis } from "./evFloor.js";
import { percentile, type NodeTimingRecord } from "./nodeTimings.js";

export const MIN_RUN_COST_HISTORY_SAMPLES = 2;

export type RunCostHistoryScope = "project" | "pooled" | "none";
export type RunCostExclusionReason =
  | "current_run"
  | "not_completed"
  | "mock_execution"
  | "missing_project_attribution"
  | "missing_route_evidence"
  | "incomplete_stage_coverage"
  | "missing_timing_attribution"
  | "foreign_timing_project"
  | "missing_route_era"
  | "foreign_route_era";

export type RunCostEstimate = {
  artifact: "run_cost_estimate.v1";
  estimatedRunCostUsd: number;
  basis: RunCostBasis;
  scope: RunCostHistoryScope;
  projectId?: string;
  // Auditable population counts: bounded candidates supplied by the repository, candidates that
  // proved complete/current-route/attributed, and paid run samples used by p50.
  candidateRuns: number;
  coverageRuns: number;
  sampleRuns: number;
  sampleRecords: number;
  exclusionReasons: Partial<Record<RunCostExclusionReason, number>>;
  observedRunCostsUsd: number[];
  rationale: string;
};

export type EstimateRunCostFromHistoryInput = {
  records: readonly NodeTimingRecord[];
  candidates?: readonly WorkflowExecutionRecord[];
  // Current node -> route-era map. Its keys are the current workflow stages whose terminal state a
  // historic run must cover. Omission is deliberately not inferred from timing rows: old rows cannot
  // prove that they describe today's program.
  currentRouteEras?: Readonly<Record<string, string>>;
  excludeRunId?: string;
  minSamples?: number;
  projectId?: string;
};

type QualifiedRun = { run: WorkflowExecutionRecord; records: NodeTimingRecord[]; totalCostUsd: number };

const round2 = (value: number): number => Math.round(value * 100) / 100;
const addReason = (reasons: Partial<Record<RunCostExclusionReason, number>>, reason: RunCostExclusionReason) => {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
};

const currentStageCoverage = (run: WorkflowExecutionRecord, routeEras: Readonly<Record<string, string>>): boolean =>
  Object.keys(routeEras).every((nodeId) => {
    const node = run.nodes.find((candidate) => candidate.nodeId === nodeId);
    return node?.status === "completed" || node?.status === "skipped";
  });

const recordsForRun = (records: readonly NodeTimingRecord[], run: WorkflowExecutionRecord): NodeTimingRecord[] => {
  // A backend backfill can encounter both old and indexed copies. timingId is the immutable attempt
  // identity, so deduping it keeps every genuine retry while never charging one write twice.
  const unique = new Map<string, NodeTimingRecord>();
  for (const record of records) {
    if (record.runId !== run.runId || record.phase !== undefined || record.workflowId !== run.workflowId) continue;
    unique.set(record.timingId, record);
  }
  return [...unique.values()];
};

const qualifies = (
  run: WorkflowExecutionRecord,
  input: EstimateRunCostFromHistoryInput,
  routeEras: Readonly<Record<string, string>> | undefined
): { records: NodeTimingRecord[] } | { reason: RunCostExclusionReason } => {
  if (run.runId === input.excludeRunId) return { reason: "current_run" };
  if (run.status !== "completed") return { reason: "not_completed" };
  if (run.executionMode === "mock") return { reason: "mock_execution" };
  if (!run.projectId) return { reason: "missing_project_attribution" };
  if (!routeEras || !Object.keys(routeEras).length) return { reason: "missing_route_evidence" };
  if (!currentStageCoverage(run, routeEras)) return { reason: "incomplete_stage_coverage" };

  const rows = recordsForRun(input.records, run);
  for (const row of rows) {
    const expectedEra = routeEras[row.nodeId];
    // Rows for a stage that no longer exists are not today's route and cannot contribute spend.
    if (expectedEra === undefined) continue;
    if (row.executionMode === "mock") return { reason: "mock_execution" };
    if (!row.projectId) return { reason: "missing_timing_attribution" };
    if (row.projectId !== run.projectId) return { reason: "foreign_timing_project" };
    if (!row.routeEra) return { reason: "missing_route_era" };
    if (row.routeEra !== expectedEra) return { reason: "foreign_route_era" };
  }
  return { records: rows.filter((row) => routeEras[row.nodeId] !== undefined) };
};

const estimate = (
  qualified: readonly QualifiedRun[],
  input: EstimateRunCostFromHistoryInput,
  minSamples: number,
  candidateRuns: number,
  reasons: Partial<Record<RunCostExclusionReason, number>>
): RunCostEstimate => {
  const projectQualified = input.projectId === undefined ? undefined : qualified.filter((sample) => sample.run.projectId === input.projectId);
  const projectPaid = projectQualified?.filter((sample) => sample.totalCostUsd > 0) ?? [];
  const pooledPaid = qualified.filter((sample) => sample.totalCostUsd > 0);
  const selected = projectPaid.length >= minSamples ? projectPaid : pooledPaid;
  const scope: RunCostHistoryScope = selected.length < minSamples ? "none" : projectPaid.length >= minSamples ? "project" : "pooled";
  const costs = selected.map((sample) => sample.totalCostUsd).sort((left, right) => left - right);
  const sampleRecords = selected.reduce((count, sample) => count + sample.records.length, 0);
  const shared = {
    artifact: "run_cost_estimate.v1" as const,
    scope,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    candidateRuns,
    coverageRuns: qualified.length,
    sampleRuns: costs.length,
    sampleRecords,
    exclusionReasons: reasons,
    observedRunCostsUsd: costs
  };

  if (scope === "none") {
    return {
      ...shared,
      estimatedRunCostUsd: 0,
      basis: "no_history",
      rationale: `No qualified run-cost history for workflow${input.projectId ? ` on project "${input.projectId}" or its attributed pool` : ""}: ${qualified.length}/${candidateRuns} bounded candidate run(s) covered every current stage and provenance check, but only ${costs.length} had actual spend (minimum ${minSamples}). estimatedRunCostUsd is 0 and the EV floor blocks nothing.`
    };
  }

  const estimatedRunCostUsd = round2(percentile(costs, 50));
  const pooled = scope === "pooled" && input.projectId !== undefined;
  return {
    ...shared,
    estimatedRunCostUsd,
    basis: "workflow_history",
    rationale: `estimatedRunCostUsd = p50 (nearest-rank) of ${costs.length} qualified completed run total(s): [${costs.join(", ")}] -> ${estimatedRunCostUsd}. Every sample covered today's workflow stages, used real attributed timing attempts only, excluded this run, phases and duplicate timingIds, and included zero-cost deterministic stages for coverage but not spend.${pooled ? ` POOLED ACROSS ATTRIBUTED TENANTS: project "${input.projectId}" has only ${projectPaid.length} paid qualified sample(s), fewer than ${minSamples}.` : ""}`
  };
};

// Pure and total. The caller supplies only a bounded candidate page; this function never recovers
// candidates from raw timing rows, which is what prevents aborted prefixes from becoming fake runs.
export function estimateRunCostFromHistory(input: EstimateRunCostFromHistoryInput): RunCostEstimate {
  const minSamples = Number.isFinite(input.minSamples) && (input.minSamples as number) > 0 ? Math.floor(input.minSamples as number) : MIN_RUN_COST_HISTORY_SAMPLES;
  const candidates = new Map((input.candidates ?? []).map((run) => [run.runId, run]));
  const reasons: Partial<Record<RunCostExclusionReason, number>> = {};
  const qualified: QualifiedRun[] = [];
  for (const run of candidates.values()) {
    const result = qualifies(run, input, input.currentRouteEras);
    if ("reason" in result) {
      addReason(reasons, result.reason);
      continue;
    }
    qualified.push({
      run,
      records: result.records,
      totalCostUsd: round2(result.records.reduce((sum, row) => sum + Math.max(0, Number.isFinite(row.costUsd) ? row.costUsd : 0), 0))
    });
  }
  return estimate(qualified, input, minSamples, candidates.size, reasons);
}
