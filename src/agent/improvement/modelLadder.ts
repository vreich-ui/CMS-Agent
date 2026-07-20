// Cost-aware model ladder (docs/improvement/STRATEGY.md §4): recommend the CHEAPEST model whose
// rubric pass-rate on a node stays at or above threshold — decided from eval evidence, never
// intuition. Pure function over recorded results plus the (placeholder) pricing catalog.
import { modelPricingCatalog } from "../observability/modelUsage.js";
import type { EvalResult } from "./improvementTypes.js";

export type ModelLadderCandidate = { model: string; samples: number; passRate: number; meanScore: number; costIndexUsdPerMillion?: number; meetsThreshold: boolean };
export type ModelLadderRecommendation = { nodeId: string; threshold: number; minSamples: number; recommended?: string; reason: string; candidates: ModelLadderCandidate[] };

const costIndex = (model: string): number | undefined => {
  const pricing = modelPricingCatalog[model];
  return pricing ? pricing.inputUsdPerMillion + pricing.outputUsdPerMillion : undefined;
};

export function recommendModel(params: { nodeId: string; results: EvalResult[]; threshold?: number; minSamples?: number }): ModelLadderRecommendation {
  const threshold = params.threshold ?? 0.7;
  const minSamples = params.minSamples ?? 3;
  const byModel = new Map<string, EvalResult[]>();
  for (const result of params.results) {
    const model = result.subject?.model;
    if (!model) continue;
    byModel.set(model, [...(byModel.get(model) ?? []), result]);
  }
  const candidates: ModelLadderCandidate[] = [...byModel.entries()].map(([model, results]) => {
    const passRate = results.filter((result) => result.pass).length / results.length;
    return {
      model,
      samples: results.length,
      passRate: Number(passRate.toFixed(4)),
      meanScore: Number((results.reduce((sum, result) => sum + result.normalizedScore, 0) / results.length).toFixed(4)),
      costIndexUsdPerMillion: costIndex(model),
      meetsThreshold: results.length >= minSamples && passRate >= threshold
    };
  }).sort((a, b) => (a.costIndexUsdPerMillion ?? Number.POSITIVE_INFINITY) - (b.costIndexUsdPerMillion ?? Number.POSITIVE_INFINITY));

  const qualified = candidates.filter((candidate) => candidate.meetsThreshold && candidate.costIndexUsdPerMillion !== undefined);
  if (qualified.length) {
    return { nodeId: params.nodeId, threshold, minSamples, recommended: qualified[0]!.model, reason: `Cheapest model with pass-rate >= ${threshold} over >= ${minSamples} evaluated outputs.`, candidates };
  }
  return { nodeId: params.nodeId, threshold, minSamples, reason: candidates.length ? "No model meets the threshold with enough samples yet; keep evaluating before shifting tiers." : "No model-attributed eval results yet; run evaluations with subject model attribution first.", candidates };
}
