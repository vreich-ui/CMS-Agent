// Section 6 — Usage & budgets. spec/mockup.html renderReg() 'usage' branch
// (~line 1005); `.kv num` copied verbatim. Honesty requirement from
// api/fixtures/README.md: `weekTotal` is actually the all-time total cost
// (usage_get_summary carries no rolling-window default), not a rolling
// week — labelled that way here rather than repeating the mockup's "this
// week". The grand total also exceeds the three workflows' summed totals
// because it includes non-workflow usage (regression trials, judges) —
// called out explicitly rather than left as an unexplained discrepancy.

import { Fragment } from 'react';
import { useUsage } from '../../api/hooks';
import { Note } from '../../components/primitives';
import { errMessage } from './queries';
import { ErrorCard, LoadingCard } from './Shared';

export function UsageTab() {
  const usageQ = useUsage();

  if (usageQ.isLoading) return <LoadingCard>Loading usage…</LoadingCard>;
  if (usageQ.isError) {
    return <ErrorCard message={errMessage(usageQ.error, 'Failed to load usage.')} />;
  }

  const usage = usageQ.data;
  if (!usage) return <ErrorCard message="usage_get_summary returned nothing." />;

  const wfSum = usage.byWorkflow.reduce((sum, w) => sum + w.total, 0);
  const other = usage.weekTotal - wfSum;

  return (
    <div className="projcard">
      <div className="top">
        <h3>Usage &amp; budgets</h3>
      </div>
      <div className="kv num" style={{ fontSize: 13 }}>
        <span className="k">all-time total</span>
        <span>
          ${usage.weekTotal.toFixed(2)} across {usage.runCount} runs
        </span>
        {usage.byWorkflow.map((w) => (
          <Fragment key={w.wf}>
            <span className="k">{w.wf}</span>
            <span>
              ${w.total.toFixed(2)} · avg ${w.avgPerRun.toFixed(2)}/run
            </span>
          </Fragment>
        ))}
      </div>
      <Note>
        Labelled &ldquo;all-time total&rdquo;, not &ldquo;this week&rdquo; — usage_get_summary has no
        rolling time window (api/fixtures/README.md). It exceeds the three workflows&rsquo; combined
        ${wfSum.toFixed(2)} by ${other.toFixed(2)} because it also counts non-workflow usage —
        regression-trial runs and the improvement_judge.
      </Note>
    </div>
  );
}
