import { useCallback, useEffect, useState } from "react";
import type { McpClient } from "../mcp/client";
import type { BudgetStatus, ModelUsageRecord, ModelUsageSummary } from "../types/workspace";

const emptySummary: ModelUsageSummary = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, costUsdEstimate: 0, recordCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0, totalCostUsdEstimate: 0, byModel: {}, byNode: {}, byProject: {} };
const emptyBudget: BudgetStatus = { spentUsdEstimate: 0, remainingUsdEstimate: 0, budgetUsd: 0, percentUsed: 0, status: "ok" };

export function useModelUsage(client: McpClient, runId?: string | null, projectId?: string | null) {
  const [summary, setSummary] = useState<ModelUsageSummary>(emptySummary);
  const [records, setRecords] = useState<ModelUsageRecord[]>([]);
  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus>(emptyBudget);
  const [budgetUsd, setBudgetUsd] = useState(1);
  const [loading, setLoading] = useState(false);

  const filters = useCallback(() => runId ? { runId } : projectId ? { projectId } : {}, [projectId, runId]);

  const refreshUsage = useCallback(async () => {
    setLoading(true);
    try {
      const args = filters();
      const [summaryResult, recordsResult, budgetResult] = await Promise.all([
        client.call<{ summary: ModelUsageSummary }>("usage.get_summary", args),
        client.call<{ records: ModelUsageRecord[] }>("usage.list_records", args),
        client.call<{ budgetStatus: BudgetStatus }>("usage.get_budget_status", { ...args, budgetUsd })
      ]);
      setSummary(summaryResult.summary);
      setRecords(recordsResult.records);
      setBudgetStatus(budgetResult.budgetStatus);
    } finally {
      setLoading(false);
    }
  }, [budgetUsd, client, filters]);

  useEffect(() => {
    if (runId) void refreshUsage().catch(() => undefined);
  }, [refreshUsage, runId]);

  return { summary, records, budgetStatus, budgetUsd, setBudgetUsd, loading, refreshUsage };
}
