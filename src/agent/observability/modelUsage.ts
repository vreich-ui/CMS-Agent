import { z } from "zod";
import { repositoryManager } from "../runtime/repositories.js";
import type { UsageRepository } from "../repository/interfaces/UsageRepository.js";
import type { BudgetStatus, EstimateModelCostInput, ModelUsageFilters, ModelUsageRecord, ModelUsageSummary, ModelUsageSummaryBucket, RecordModelUsageInput } from "./modelUsageTypes.js";

const now = () => new Date().toISOString();
const makeUsageId = () => `usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Hand-maintained list prices, refreshed 2026-07-31. These figures gate real money (the budget guard
// and run ceilings price every turn through estimateModelCost), so every entry stays flagged
// placeholder: there is no billing-grade reconciliation behind this catalog and it goes stale
// silently — re-check published rates before any production billing decision.
// Session E (R-9 sibling work): stamped onto every usage record at record time (recordModelUsage),
// not read back out of the catalog's per-entry notes — those are prose, not a machine-checkable
// version. Bump PRICING_CATALOG_VERSION whenever an entry's rate changes (not for a comment-only
// edit), so two usage records with different pricingCatalogVersion values are a signal that their
// costUsdEstimate figures are not directly comparable without checking what changed.
export const MODEL_PRICING_CATALOG_ASOF = "2026-07-31";
export const MODEL_PRICING_CATALOG_VERSION = "2026-07-31.1";

export const modelPricingCatalog: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number; placeholder: true; note: string }> = {
  "gpt-5.5": { inputUsdPerMillion: 5, outputUsdPerMillion: 30, cachedInputUsdPerMillion: 0.5, placeholder: true, note: "OpenAI published list price as of 2026-07-31; not billing-grade." },
  "gpt-5.5-mini": { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5, cachedInputUsdPerMillion: 0.075, placeholder: true, note: "No published OpenAI listing for this id as of 2026-07-31 (the current mini tier is gpt-5.4-mini); priced at that tier's list rate as a proxy. Not billing-grade." },
  "gpt-4.1": { inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.5, placeholder: true, note: "OpenAI published list price as of 2026-07-31 (legacy tier); not billing-grade." },
  "gpt-4.1-mini": { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6, cachedInputUsdPerMillion: 0.1, placeholder: true, note: "OpenAI published list price as of 2026-07-31 (legacy tier); not billing-grade." },
  // Anthropic entries for the native runner (AnthropicNodeRunner records provider "anthropic";
  // its DEFAULT_MODEL is claude-opus-4-8). Cached rate is Anthropic's 0.1x cache-read multiplier.
  "claude-opus-4-8": { inputUsdPerMillion: 5, outputUsdPerMillion: 25, cachedInputUsdPerMillion: 0.5, placeholder: true, note: "Anthropic published list price as of 2026-07-31; not billing-grade." },
  "claude-opus-5": { inputUsdPerMillion: 5, outputUsdPerMillion: 25, cachedInputUsdPerMillion: 0.5, placeholder: true, note: "Anthropic published list price as of 2026-07-31; not billing-grade." },
  "claude-sonnet-5": { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3, placeholder: true, note: "Anthropic standard list price as of 2026-07-31; intro pricing ($2/$10) runs through 2026-08-31 — the standard rate is used so estimates stay conservative. Not billing-grade." },
  "claude-haiku-4-5": { inputUsdPerMillion: 1, outputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.1, placeholder: true, note: "Anthropic published list price as of 2026-07-31; not billing-grade." },
  "claude-fable-5": { inputUsdPerMillion: 10, outputUsdPerMillion: 50, cachedInputUsdPerMillion: 1, placeholder: true, note: "Anthropic published list price as of 2026-07-31; not billing-grade." },
  // Model-tiering candidates (docs/improvement/STRATEGY.md §4) reachable via the provider registry.
  "gemini-3.1-flash-lite": { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5, placeholder: true, note: "Placeholder estimate; not billing-grade." },
  "gemini-3.5-flash": { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5, placeholder: true, note: "Placeholder estimate; not billing-grade." },
  "qwen3-8b": { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3, placeholder: true, note: "Self-hosted vLLM amortized estimate; not billing-grade." }
};

export const usageFiltersSchema = z.object({
  runId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z.enum(["estimated", "actual"]).optional()
}).strict();

export const recordModelUsageSchema = z.object({
  usageId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  model: z.string().min(1),
  provider: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsdEstimate: z.number().nonnegative().optional(),
  currency: z.literal("USD").optional(),
  status: z.enum(["estimated", "actual"]),
  recordedAt: z.string().datetime().optional(),
  pricingAsOf: z.string().min(1).optional(),
  pricingCatalogVersion: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict();

const roundUsd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function estimateModelCost(input: EstimateModelCostInput): number {
  const pricing = modelPricingCatalog[input.model] ?? modelPricingCatalog["gpt-5.5"];
  const cached = Math.min(input.cachedInputTokens ?? 0, input.inputTokens);
  const uncached = input.inputTokens - cached;
  return roundUsd(((uncached * pricing.inputUsdPerMillion) + (cached * (pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion)) + (input.outputTokens * pricing.outputUsdPerMillion)) / 1_000_000);
}

export async function recordModelUsage(input: RecordModelUsageInput, store: UsageRepository = repositoryManager.getUsageRepository()): Promise<ModelUsageRecord> {
  const parsed = recordModelUsageSchema.parse(input);
  const record: ModelUsageRecord = {
    ...parsed,
    usageId: parsed.usageId ?? makeUsageId(),
    totalTokens: parsed.totalTokens ?? parsed.inputTokens + parsed.outputTokens,
    costUsdEstimate: parsed.costUsdEstimate ?? estimateModelCost(parsed),
    currency: "USD",
    recordedAt: parsed.recordedAt ?? now(),
    pricingAsOf: parsed.pricingAsOf ?? MODEL_PRICING_CATALOG_ASOF,
    pricingCatalogVersion: parsed.pricingCatalogVersion ?? MODEL_PRICING_CATALOG_VERSION,
    metadata: parsed.metadata
  };
  return store.record(record);
}

const emptyBucket = (): ModelUsageSummaryBucket => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, costUsdEstimate: 0, recordCount: 0 });
const add = (bucket: ModelUsageSummaryBucket, record: ModelUsageRecord) => {
  bucket.inputTokens += record.inputTokens;
  bucket.outputTokens += record.outputTokens;
  bucket.totalTokens += record.totalTokens;
  bucket.reasoningTokens += record.reasoningTokens ?? 0;
  bucket.costUsdEstimate = roundUsd(bucket.costUsdEstimate + record.costUsdEstimate);
  bucket.recordCount += 1;
};
const bucketFor = (buckets: Record<string, ModelUsageSummaryBucket>, key: string) => buckets[key] ?? (buckets[key] = emptyBucket());

export async function summarizeModelUsage(filters: ModelUsageFilters = {}, store: UsageRepository = repositoryManager.getUsageRepository()): Promise<ModelUsageSummary> {
  const records = await store.list(usageFiltersSchema.parse(filters));
  const summary: ModelUsageSummary = { ...emptyBucket(), totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0, totalCostUsdEstimate: 0, actualCostUsdEstimate: 0, estimatedCostUsdEstimate: 0, byModel: {}, byNode: {}, byProject: {} };
  for (const record of records) {
    add(summary, record);
    if (record.status === "actual") summary.actualCostUsdEstimate = roundUsd(summary.actualCostUsdEstimate + record.costUsdEstimate);
    else summary.estimatedCostUsdEstimate = roundUsd(summary.estimatedCostUsdEstimate + record.costUsdEstimate);
    add(bucketFor(summary.byModel, record.model), record);
    if (record.nodeId) add(bucketFor(summary.byNode, record.nodeId), record);
    if (record.projectId) add(bucketFor(summary.byProject, record.projectId), record);
  }
  summary.totalInputTokens = summary.inputTokens;
  summary.totalOutputTokens = summary.outputTokens;
  summary.totalReasoningTokens = summary.reasoningTokens;
  summary.totalCostUsdEstimate = summary.costUsdEstimate;
  return summary;
}

export type RunBudgetEvaluation = {
  budgetUsd: number;
  spentUsdEstimate: number;
  remainingUsdEstimate: number;
  percentUsed: number;
  // True once accrued ACTUAL cost has REACHED the ceiling (R-20: estimated/mock records never
  // accrue against a budget; callers pass summary.actualCostUsdEstimate) — the conductor's halt
  // predicate. Uses `>=` so a run stops before the node that would cross the ceiling, matching the
  // "halt at the node that would cross" contract.
  overBudget: boolean;
  status: "ok" | "warning" | "exceeded";
};

// Pure, synchronous budget evaluation reused by the conductor gate and the run cost ledger so both
// read the SAME accrued cost figure (summary.totalCostUsdEstimate) — no second cost path. Returns
// undefined when no ceiling is configured (Default OFF): callers skip the gate entirely.
export function evaluateRunBudget(budgetUsd: number | undefined, spentUsdEstimate: number): RunBudgetEvaluation | undefined {
  if (budgetUsd === undefined) return undefined;
  const ceiling = Math.max(0, budgetUsd);
  const overBudget = spentUsdEstimate >= ceiling;
  const percentUsed = ceiling > 0 ? Math.round((spentUsdEstimate / ceiling) * 10000) / 100 : (overBudget ? 100 : 0);
  return {
    budgetUsd: ceiling,
    spentUsdEstimate: roundUsd(spentUsdEstimate),
    remainingUsdEstimate: roundUsd(Math.max(0, ceiling - spentUsdEstimate)),
    percentUsed,
    overBudget,
    status: overBudget ? "exceeded" : percentUsed >= 80 ? "warning" : "ok"
  };
}

export async function getBudgetStatus(input: { projectId?: string; runId?: string; budgetUsd?: number }, store: UsageRepository = repositoryManager.getUsageRepository()): Promise<BudgetStatus> {
  const budgetUsd = Math.max(0, input.budgetUsd ?? 0);
  const summary = await summarizeModelUsage({ projectId: input.projectId, runId: input.runId }, store);
  // R-20: budgets meter money, and only status:"actual" records represent money. A mock run's
  // deterministic estimates (T-2 F-5 recorded $0.029 against a ceiling with zero model calls) are
  // visible in the summary's estimatedCostUsdEstimate but never accrue here.
  const spentUsdEstimate = summary.actualCostUsdEstimate;
  const percentUsed = budgetUsd > 0 ? Math.round((spentUsdEstimate / budgetUsd) * 10000) / 100 : 0;
  return { spentUsdEstimate, remainingUsdEstimate: roundUsd(Math.max(0, budgetUsd - spentUsdEstimate)), budgetUsd, percentUsed, status: budgetUsd > 0 && spentUsdEstimate > budgetUsd ? "exceeded" : percentUsed >= 80 ? "warning" : "ok" };
}
