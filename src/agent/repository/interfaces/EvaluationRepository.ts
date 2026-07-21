import type { RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceMutationMeta } from "../../mcp/workspace/store.js";
import type { EvalResult, EvalRubric, EvalRubricVersionSnapshot, FeedbackRecord, PairwiseResult, RegressionReport, RubricStatus } from "../../improvement/improvementTypes.js";

export type EvalResultFilters = { nodeId?: string; runId?: string; rubricId?: string; trialId?: string; from?: string; to?: string; limit?: number };
export type FeedbackFilters = { nodeId?: string; runId?: string; kind?: FeedbackRecord["kind"]; limit?: number };
export type RegressionReportFilters = { nodeId?: string; limit?: number };

// Evaluation substrate: versioned per-node rubrics (skill-style snapshots + restore) plus
// append-only judge results, pairwise comparisons, and feedback records.
export interface EvaluationRepository {
  health(): Promise<RepositoryHealth>;
  createRubric(rubric: EvalRubric, meta?: WorkspaceMutationMeta): Promise<EvalRubric>;
  updateRubric(rubricId: string, patch: Partial<EvalRubric>, meta?: WorkspaceMutationMeta): Promise<EvalRubric>;
  getRubric(rubricId: string): Promise<EvalRubric | undefined>;
  listRubrics(filters?: { nodeId?: string; status?: RubricStatus }): Promise<EvalRubric[]>;
  listRubricVersions(rubricId: string): Promise<EvalRubricVersionSnapshot[]>;
  restoreRubricVersion(rubricId: string, versionId: string, meta?: WorkspaceMutationMeta): Promise<EvalRubric>;
  recordResult(result: EvalResult): Promise<EvalResult>;
  listResults(filters?: EvalResultFilters): Promise<EvalResult[]>;
  getResult(evalId: string): Promise<EvalResult | undefined>;
  recordPairwise(result: PairwiseResult): Promise<PairwiseResult>;
  listPairwise(filters?: { nodeId?: string; trialId?: string; limit?: number }): Promise<PairwiseResult[]>;
  recordFeedback(record: FeedbackRecord): Promise<FeedbackRecord>;
  listFeedback(filters?: FeedbackFilters): Promise<FeedbackRecord[]>;
  // Regression gate reports (append-only). getLatestRegressionReport returns the newest stored
  // report for a node — the baseline the next regression run compares against.
  recordRegressionReport(report: RegressionReport): Promise<RegressionReport>;
  listRegressionReports(filters?: RegressionReportFilters): Promise<RegressionReport[]>;
  getLatestRegressionReport(nodeId: string): Promise<RegressionReport | undefined>;
}
