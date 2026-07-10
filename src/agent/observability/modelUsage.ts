import { z } from "zod";
import { repositoryManager } from "../runtime/repositories.js";
import type { UsageRepository } from "../repository/interfaces/UsageRepository.js";
import type { BudgetStatus, EstimateModelCostInput, ModelUsageFilters, ModelUsageRecord, ModelUsageSummary, ModelUsageSummaryBucket, RecordModelUsageInput } from "./modelUsageTypes.js";

const now = () => new Date().toISOString();
const makeUsageId = () => `usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Placeholder estimates only. Update this catalog before production billing decisions.
export const modelPricingCatalog: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number; placeholder: true; note: string }> = {
  "gpt-5.5": { inputUsdPerMillion: 5, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 1.25, placeholder: true, note: "Placeholder estimate; not billing-grade." },
  "gpt-5.5-mini": { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.4, cachedInputUsdPerMillion: 0.15, placeholder: true, note: "Placeholder estimate; not billing-grade." },
  "gpt-4.1": { inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.5, placeholder: true, note: "Placeholder estimate; not billing-grade." },
  "gpt-4.1-mini": { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6, cachedInputUsdPerMillion: 0.1, placeholder: true, note: "Placeholder estimate; not billing-grade." }
};

export const usageFiltersSchema = z.object({
  runId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
}).strict();

export const recordModelUsageSchema = z.object({
  usageId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
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
  const summary: ModelUsageSummary = { ...emptyBucket(), totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0, totalCostUsdEstimate: 0, byModel: {}, byNode: {}, byProject: {} };
  for (const record of records) {
    add(summary, record);
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

export async function getBudgetStatus(input: { projectId?: string; runId?: string; budgetUsd?: number }, store: UsageRepository = repositoryManager.getUsageRepository()): Promise<BudgetStatus> {
  const budgetUsd = Math.max(0, input.budgetUsd ?? 0);
  const summary = await summarizeModelUsage({ projectId: input.projectId, runId: input.runId }, store);
  const spentUsdEstimate = summary.totalCostUsdEstimate;
  const percentUsed = budgetUsd > 0 ? Math.round((spentUsdEstimate / budgetUsd) * 10000) / 100 : 0;
  return { spentUsdEstimate, remainingUsdEstimate: roundUsd(Math.max(0, budgetUsd - spentUsdEstimate)), budgetUsd, percentUsed, status: budgetUsd > 0 && spentUsdEstimate > budgetUsd ? "exceeded" : percentUsed >= 80 ? "warning" : "ok" };
}
