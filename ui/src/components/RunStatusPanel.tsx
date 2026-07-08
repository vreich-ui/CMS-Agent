import type { WorkflowExecutionRecord } from "../types/workspace";

const value = (text?: string) => text?.trim() || "—";

export function RunStatusPanel({ run }: { run: WorkflowExecutionRecord | null }) {
  if (!run) return <section className="panel"><h2>Run summary</h2><p className="empty-state">No dry-run selected yet. Start or load a dry-run in Builder.</p></section>;
  const blocked = run.status === "blocked" || run.approvalsRequired.length > 0;
  return <section className="panel run-status-panel">
    <h2>Run summary</h2>
    {blocked && <div className="status error" role="status"><strong>approval_required</strong><br />No publication was performed.</div>}
    <dl>
      <dt>Run</dt><dd>{run.runId}</dd>
      <dt>Workflow</dt><dd>{run.workflowId}</dd>
      <dt>Project</dt><dd>{run.projectId}</dd>
      <dt>Status</dt><dd><span className={`execution-pill execution-${run.status}`}>{run.status}</span></dd>
      <dt>Current node</dt><dd>{value(run.currentNodeId)}</dd>
      <dt>Started</dt><dd>{run.startedAt}</dd>
      <dt>Updated</dt><dd>{run.updatedAt}</dd>
      <dt>Completed</dt><dd>{value(run.completedAt)}</dd>
    </dl>
    <h3>Approvals required</h3>
    {run.approvalsRequired.length ? <ul className="compact-list">{run.approvalsRequired.map((approval) => <li key={`${approval.nodeId}-${approval.requestedAt}`}><strong>{approval.type}</strong> for <code>{approval.nodeId}</code><br /><span>{approval.reason}</span></li>)}</ul> : <p>No approvals required.</p>}
  </section>;
}
