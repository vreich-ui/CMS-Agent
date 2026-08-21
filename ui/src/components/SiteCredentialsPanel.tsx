import { useState } from "react";
import { applyGate, describeExecutionStatus, summarizeFleet, tenantStatusLabel } from "../siteCredentials";
import type { useSiteCredentials } from "../hooks/useSiteCredentials";
import type { StatusMessage } from "../status";

type Props = {
  siteCredentials: ReturnType<typeof useSiteCredentials>;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

// Fleet-wide tenant scoped-bearer repair. Every tenant site's admin chat authenticates back to
// CMS-Agent with a per-site scoped bearer; when the tool scope changes, existing tenants keep the
// old one until this reconciler re-mints them. Previously that could only be fired from gcloud —
// this panel is the operator-facing view of the same plan/apply/status tools. Lives in Settings
// (not per-project Access) because it is a fleet-wide operational concern, exactly like Repository
// diagnostics and Workspace exchange on this page — it is not scoped to one project's tool policy.
export function SiteCredentialsPanel({ siteCredentials, onStatus, onError }: Props) {
  const { plan, planLoading, planError, refreshPlan, execution, executionName, jobName, applying, applyError, apply } = siteCredentials;
  const [confirming, setConfirming] = useState(false);

  const fleet = summarizeFleet(plan);
  const gate = applyGate(plan);
  const executionView = executionName ? (execution ? describeExecutionStatus(execution, jobName ?? undefined) : { tone: "info" as const, headline: "Repair started — waiting for the first status update…" }) : null;

  const handleRefresh = async () => {
    try {
      await refreshPlan();
    } catch (error) {
      onError(error);
    }
  };

  const handleConfirmApply = async () => {
    setConfirming(false);
    try {
      const result = await apply();
      onStatus({ tone: "success", message: `Repair fired — execution ${result.executionName} is running as Cloud Run Job ${result.jobName}. This can take 10-20 minutes.` });
    } catch (error) {
      onError(error);
    }
  };

  return <section className="panel credential-panel" aria-label="Tenant credential repair">
    <div className="panel-heading">
      <div>
        <h2>Tenant credential repair</h2>
        <p className="muted">Each tenant site's admin chat authenticates with a per-site scoped bearer. When the tool scope changes, tenants keep the old scope until this reconciler re-mints it — this is that reconciler, previously <code>gcloud</code>-only.</p>
      </div>
      <button onClick={() => void handleRefresh()} disabled={planLoading}>{planLoading ? "Loading…" : "Refresh plan"}</button>
    </div>

    {planError && <div className="status error" role="status">{planError}</div>}

    {fleet && <div className={`status ${fleet.tone === "success" ? "success" : "warning"}`} role="status">{fleet.message}</div>}

    {!plan && planLoading && <p className="muted" aria-live="polite">Loading tenant plan…</p>}

    {plan && plan.results.length > 0 && <div className="table-wrap">
      <table>
        <thead><tr><th>Project</th><th>Netlify site</th><th>Status</th></tr></thead>
        <tbody>
          {plan.results.map((row) => <tr key={row.projectId}>
            <td><code>{row.projectId}</code></td>
            <td>{row.netlifySiteName}</td>
            <td><span className={`permission-chip ${row.status === "current" ? "permission-chip--allow" : "permission-chip--ask"}`}>{tenantStatusLabel(row.status)}</span></td>
          </tr>)}
        </tbody>
      </table>
    </div>}

    {plan && plan.results.length === 0 && !planLoading && <p className="empty-state">No registered tenants to check.</p>}

    <div className="credential-apply">
      {/* Said before the click, not after: this is a fleet rebuild, not a cheap refresh. */}
      <p className="muted">Repairing rotates the scoped bearer for every stale tenant and republishes each one. It runs as a Cloud Run Job and typically takes <strong>10-20 minutes</strong> — it is not instant and cannot be treated as an idempotent refresh.</p>

      {!gate.allowed && <p className="muted" role="status">{gate.reason}</p>}

      {confirming
        ? <div className="credential-confirm">
            <p>Confirm repair of <strong>{plan?.staleCount ?? 0}</strong> tenant{plan?.staleCount === 1 ? "" : "s"}? This rotates live credentials and republishes production sites; it cannot be cancelled from here once it starts.</p>
            <div className="auth-actions">
              <button disabled={applying} onClick={() => void handleConfirmApply()}>{applying ? "Firing…" : "Confirm repair"}</button>
              <button className="link-button" disabled={applying} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        : <button disabled={!gate.allowed || applying} onClick={() => setConfirming(true)}>{applying ? "Repair in progress…" : "Repair stale tenants…"}</button>}
    </div>

    {applyError && <div className="status error" role="status">{applyError}</div>}

    {executionView && <div className={`status ${executionView.tone}`} role="status" aria-live="polite">
      <strong>{executionView.headline}</strong>
      {executionView.detail && <p>{executionView.detail}</p>}
      {executionName && <p className="muted">Execution <code>{executionName}</code>{jobName ? <> · job <code>{jobName}</code></> : null}</p>}
    </div>}
  </section>;
}
