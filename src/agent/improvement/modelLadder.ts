// Cost-aware model ladder (docs/improvement/STRATEGY.md §4): recommend the CHEAPEST model whose
// rubric pass-rate on a node stays at or above threshold — decided from eval evidence, never
// intuition. Pure function over recorded results plus the (placeholder) pricing catalog.
import { modelPricingCatalog } from "../observability/modelUsage.js";
import type { EvalResult } from "./improvementTypes.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";

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

// ── Model-ladder ENFORCEMENT (docs/platform/DIRECTION.md Phase 7) ────────────────────────────────
// recommendModel() above is advisory (surfaced only via optimizer.status). Enforcement APPLIES that
// pick at conductor dispatch so a run actually uses the cheaper tier. It is:
//   • Gated by IMPROVEMENT_MODEL_LADDER_ENFORCE — default OFF, so the ladder stays advisory unless an
//     operator opts in (after confirming the eval-attributed candidate models are reachable by each
//     node's provider — enforcement overrides the model NAME only, not the provider/baseURL).
//   • A per-RUN override, NOT a workspace mutation: it never persists a model change (persisting a
//     model choice stays the human-approved optimizer.promote path), so flipping the flag off fully
//     reverts behavior. Enforcement builds directly on Phase 5's store-node modelConfig overlay.
//   • DOWNSHIFT-ONLY and eval-gated: recommendModel only returns a model that clears the pass-rate
//     threshold over >= minSamples evaluated outputs; if that equals the node's current model (or none
//     qualifies) the node's modelConfig is returned unchanged.
export const modelLadderEnforcementEnabled = (): boolean => /^(1|true|on|yes)$/i.test(process.env.IMPROVEMENT_MODEL_LADDER_ENFORCE?.trim() ?? "");

const envThreshold = (): number | undefined => { const value = Number(process.env.IMPROVEMENT_MODEL_LADDER_THRESHOLD); return Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined; };
const envMinSamples = (): number | undefined => { const value = Number(process.env.IMPROVEMENT_MODEL_LADDER_MIN_SAMPLES); return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined; };

export type ModelLadderEnforcement = { applied: boolean; nodeId: string; fromModel?: string; toModel?: string; reason: string; recommendation: ModelLadderRecommendation };

// Compute the enforced modelConfig for a node from its recorded eval results. Returns the (possibly
// overridden) modelConfig plus a decision record for telemetry. Pure aside from the single
// listResults read; makes no mutation and never throws on a well-formed repository.
export async function enforceModelLadder(node: WorkspaceNode, evaluationRepository: EvaluationRepository): Promise<{ modelConfig: WorkspaceNode["modelConfig"]; enforcement: ModelLadderEnforcement }> {
  const results = await evaluationRepository.listResults({ nodeId: node.id, limit: 200 });
  const recommendation = recommendModel({ nodeId: node.id, results, threshold: envThreshold(), minSamples: envMinSamples() });
  const currentModel = typeof node.modelConfig?.model === "string" ? (node.modelConfig.model as string) : undefined;
  const recommended = recommendation.recommended;
  if (!recommended || recommended === currentModel) {
    return { modelConfig: node.modelConfig, enforcement: { applied: false, nodeId: node.id, fromModel: currentModel, toModel: recommended, reason: recommended ? "already_on_recommended_model" : recommendation.reason, recommendation } };
  }
  return {
    modelConfig: { ...(node.modelConfig ?? {}), model: recommended },
    enforcement: { applied: true, nodeId: node.id, fromModel: currentModel, toModel: recommended, reason: recommendation.reason, recommendation }
  };
}
