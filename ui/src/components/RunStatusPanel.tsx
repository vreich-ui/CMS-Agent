import type { WorkflowExecutionRecord } from "../types/workspace";

const value = (text?: string) => text?.trim() || "—";

export function RunStatusPanel({ run }: { run: WorkflowExecutionRecord | null }) {
  if (!run) return <section className="panel"><h2>Run status</h2><p>No dry-run selected yet.</p></section>;
  const blocked = run.status === "blocked" || run.approvalsRequired.length > 0;
  return <section className="panel run-status-panel">
    <h2>Run status</h2>
    {blocked && <div className="status error" role="status"><strong>approval_required</strong><br />No publication was performed.</div>}
    <dl>
      <dt>runId</dt><dd>{run.runId}</dd>
      <dt>workflowId</dt><dd>{run.workflowId}</dd>
      <dt>projectId</dt><dd>{run.projectId}</dd>
      <dt>status</dt><dd><span className={`execution-pill execution-${run.status}`}>{run.status}</span></dd>
      <dt>currentNodeId</dt><dd>{value(run.currentNodeId)}</dd>
      <dt>startedAt</dt><dd>{run.startedAt}</dd>
      <dt>updatedAt</dt><dd>{run.updatedAt}</dd>
      <dt>completedAt</dt><dd>{value(run.completedAt)}</dd>
    </dl>
    <h3>Approvals required</h3>
    {run.approvalsRequired.length ? <ul className="compact-list">{run.approvalsRequired.map((approval) => <li key={`${approval.nodeId}-${approval.requestedAt}`}><strong>{approval.type}</strong> for <code>{approval.nodeId}</code><br /><span>{approval.reason}</span></li>)}</ul> : <p>No approvals required.</p>}
  </section>;
}
