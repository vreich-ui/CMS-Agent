// Fine-tuning flywheel trigger (docs/platform/DIRECTION.md Phase 8). The SFT / preference exporters
// (dataset.export_sft / export_preferences) already produce training data; this decides WHEN a node has
// accumulated enough approved signal to be worth a tuning run — the flywheel's trigger, per DIRECTION's
// "≥500–2,000 approved examples" rule. REPORT-ONLY: it never launches a job (tuning infra is external);
// it returns a recommendation an operator or a scheduled job acts on, matching the regression gate's
// report-only discipline. Thresholds are env-tunable; the counts mirror what the exporters would emit.
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";

const clampInt = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
};

// Minimum qualifying SFT examples (default 500, the low end of DIRECTION's 500–2,000 band) and minimum
// decisive preference pairs (default 200) before a node is "ready" for the respective tuning path.
export const fineTuneMinExamples = (): number => clampInt(process.env.IMPROVEMENT_FINETUNE_MIN_EXAMPLES, 500);
export const fineTuneMinPreferencePairs = (): number => clampInt(process.env.IMPROVEMENT_FINETUNE_MIN_PREFERENCE_PAIRS, 200);

export type FineTuneRecommendation = "insufficient_data" | "accumulate" | "ready_sft" | "ready_preferences" | "ready_both";
export type FineTuneReadiness = {
  nodeId: string;
  approvedExamples: number;    // eval-approved outputs available for SFT
  preferencePairs: number;     // decisive pairwise verdicts available for preference tuning (DPO/ORPO)
  meanScore?: number;          // recent quality signal over evaluated outputs
  thresholds: { minExamples: number; minPreferencePairs: number };
  recommendation: FineTuneRecommendation;
  reason: string;
};

const recommend = (examples: number, pairs: number, minExamples: number, minPairs: number): FineTuneRecommendation => {
  const sftReady = examples >= minExamples;
  const prefReady = pairs >= minPairs;
  if (sftReady && prefReady) return "ready_both";
  if (sftReady) return "ready_sft";
  if (prefReady) return "ready_preferences";
  if (examples > 0 || pairs > 0) return "accumulate";
  return "insufficient_data";
};

const reasonFor = (recommendation: FineTuneRecommendation, examples: number, pairs: number, minExamples: number, minPairs: number): string => {
  switch (recommendation) {
    case "ready_both": return `Ready: ${examples} approved examples (>= ${minExamples}) and ${pairs} preference pairs (>= ${minPairs}). Export dataset.export_sft + dataset.export_preferences and kick a tuning run.`;
    case "ready_sft": return `Ready for SFT: ${examples} approved examples (>= ${minExamples}). Preference pairs (${pairs}) still below ${minPairs}.`;
    case "ready_preferences": return `Ready for preference tuning: ${pairs} decisive pairs (>= ${minPairs}). SFT examples (${examples}) still below ${minExamples}.`;
    case "accumulate": return `Accumulating: ${examples}/${minExamples} approved examples, ${pairs}/${minPairs} preference pairs. Keep running + evaluating.`;
    default: return "No approved examples or decisive preference pairs yet; evaluate node outputs and run pairwise trials first.";
  }
};

// Report a node's readiness for a fine-tuning run from its accumulated eval evidence. approvedExamples
// counts eval-attributed outputs that clear the bar (pass, or normalizedScore >= minScore) — the same
// gate dataset.export_sft uses; preferencePairs counts decisive (non-tie/-inconsistent) pairwise
// verdicts, matching dataset.export_preferences. Pure aside from two repository reads; never mutates.
export async function evaluateFineTuneReadiness(params: { nodeId: string; minScore?: number }, deps: { evaluationRepository: EvaluationRepository }): Promise<FineTuneReadiness> {
  const results = await deps.evaluationRepository.listResults({ nodeId: params.nodeId, limit: 200 });
  const qualifying = results.filter((result) => result.runId && (params.minScore !== undefined ? result.normalizedScore >= params.minScore : result.pass));
  const pairwise = await deps.evaluationRepository.listPairwise({ nodeId: params.nodeId, limit: 200 });
  const preferencePairs = pairwise.filter((comparison) => comparison.verdict === "champion" || comparison.verdict === "challenger").length;

  const minExamples = fineTuneMinExamples();
  const minPreferencePairs = fineTuneMinPreferencePairs();
  const recommendation = recommend(qualifying.length, preferencePairs, minExamples, minPreferencePairs);
  return {
    nodeId: params.nodeId,
    approvedExamples: qualifying.length,
    preferencePairs,
    meanScore: results.length ? Number((results.reduce((sum, result) => sum + result.normalizedScore, 0) / results.length).toFixed(4)) : undefined,
    thresholds: { minExamples, minPreferencePairs },
    recommendation,
    reason: reasonFor(recommendation, qualifying.length, preferencePairs, minExamples, minPreferencePairs)
  };
}
