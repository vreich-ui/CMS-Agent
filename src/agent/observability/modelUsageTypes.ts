export type ModelUsageStatus = "estimated" | "actual";
export type ModelUsageCurrency = "USD";

export type ModelUsageRecord = {
  usageId: string;
  runId?: string;
  workflowId?: string;
  projectId?: string;
  nodeId?: string;
  agentId?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  costUsdEstimate: number;
  currency: ModelUsageCurrency;
  status: ModelUsageStatus;
  recordedAt: string;
  metadata?: Record<string, unknown>;
};

export type ModelUsageFilters = {
  runId?: string;
  projectId?: string;
  workflowId?: string;
  nodeId?: string;
  from?: string;
  to?: string;
};

export type ModelUsageSummaryBucket = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  costUsdEstimate: number;
  recordCount: number;
};

export type ModelUsageSummary = ModelUsageSummaryBucket & {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCostUsdEstimate: number;
  byModel: Record<string, ModelUsageSummaryBucket>;
  byNode: Record<string, ModelUsageSummaryBucket>;
  byProject: Record<string, ModelUsageSummaryBucket>;
};

export type BudgetPolicy = {
  projectId?: string;
  runId?: string;
  budgetUsd: number;
  warningThresholdPercent?: number;
};

export type BudgetStatus = {
  spentUsdEstimate: number;
  remainingUsdEstimate: number;
  budgetUsd: number;
  percentUsed: number;
  status: "ok" | "warning" | "exceeded";
};

export type RecordModelUsageInput = Omit<ModelUsageRecord, "usageId" | "totalTokens" | "costUsdEstimate" | "currency" | "recordedAt"> & Partial<Pick<ModelUsageRecord, "usageId" | "totalTokens" | "costUsdEstimate" | "currency" | "recordedAt">>;

export type EstimateModelCostInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};
