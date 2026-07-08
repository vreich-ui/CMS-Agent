import type { BudgetStatus, ModelUsageBucket, ModelUsageSummary } from "../types/workspace";

type Props = {
  summary: ModelUsageSummary;
  budgetStatus: BudgetStatus;
  budgetUsd: number;
  recordCount: number;
  loading?: boolean;
  activeRunId?: string | null;
  onBudgetUsdChange: (value: number) => void;
  onRefresh: () => void;
};

const usd = (value: number) => `$${value.toFixed(6)}`;
const number = (value: number) => value.toLocaleString();

function BucketList({ title, buckets }: { title: string; buckets: Record<string, ModelUsageBucket> }) {
  const entries = Object.entries(buckets);
  return <div className="usage-breakdown"><h3>{title}</h3>{entries.length ? <ul>{entries.map(([key, bucket]) => <li key={key}><span>{key}</span><strong>{number(bucket.totalTokens)} tokens · {usd(bucket.costUsdEstimate)}</strong></li>)}</ul> : <p>No estimated usage yet.</p>}</div>;
}

export function UsagePanel({ summary, budgetStatus, budgetUsd, recordCount, loading, activeRunId, onBudgetUsdChange, onRefresh }: Props) {
  return <section className="panel usage-panel" aria-label="Model usage and budget estimates">
    <div className="panel-heading"><div><h2>Usage & budget estimates</h2><p>Estimated only; not billing-grade. No OpenAI calls are made by dry-runs.</p>{activeRunId && <p className="muted">Filtered to run <code>{activeRunId}</code>.</p>}</div><button onClick={onRefresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh Usage"}</button></div>
    <div className="usage-stats">
      <div><span>Total tokens</span><strong>{number(summary.totalTokens)}</strong></div>
      <div><span>Input tokens</span><strong>{number(summary.totalInputTokens)}</strong></div>
      <div><span>Output tokens</span><strong>{number(summary.totalOutputTokens)}</strong></div>
      {summary.totalReasoningTokens > 0 && <div><span>Reasoning tokens</span><strong>{number(summary.totalReasoningTokens)}</strong></div>}
      <div><span>Estimated cost</span><strong>{usd(summary.totalCostUsdEstimate)}</strong></div>
      <div><span>Records</span><strong>{number(recordCount)}</strong></div>
    </div>
    <label className="budget-field">Budget estimate (USD)<input type="number" min="0" step="0.01" value={budgetUsd} onChange={(event) => onBudgetUsdChange(Number(event.target.value))} /></label>
    <div className={`budget-status ${budgetStatus.status}`}><strong>{budgetStatus.status.toUpperCase()}</strong><span>{usd(budgetStatus.spentUsdEstimate)} spent estimate / {usd(budgetStatus.budgetUsd)} budget ({budgetStatus.percentUsed.toFixed(2)}%). {usd(budgetStatus.remainingUsdEstimate)} remaining estimate.</span></div>
    <div className="usage-breakdowns"><BucketList title="By model" buckets={summary.byModel} /><BucketList title="By node" buckets={summary.byNode} /><BucketList title="By project" buckets={summary.byProject} /></div>
  </section>;
}
