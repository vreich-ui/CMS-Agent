import { Glossary } from "./Glossary";
import { ObjectAbout } from "./ObjectAbout";
import type { WorkflowExecutionRecord } from "../types/workspace";

const value = (text?: string) => text?.trim() || "—";

export function RunStatusPanel({ run }: { run: WorkflowExecutionRecord | null }) {
  if (!run) return <section className="panel"><h2>Run summary</h2><p className="empty-state">No dry-run selected yet. Start or load a dry-run in Builder.</p></section>;
  const blocked = run.status === "blocked" || run.approvalsRequired.length > 0;
  // R-18: a run held one step BEFORE the gate reports status "running" with a pending approval. Saying
  // "blocked before publish-risk execution" there would be wrong — nothing was attempted yet — and a
  // status pill reading "running" next to a hold banner is what an operator needs explained, not hidden.
  const pendingOnly = run.approvalsRequired.length > 0 && run.approvalsRequired.every((approval) => approval.pending === true);
  return <section className="panel run-status-panel">
    <h2>Run summary</h2>
    <ObjectAbout id="run" />
    {blocked && <div className="status safety" role="status"><strong>approval_required</strong><br />{pendingOnly
      ? "The next node in line is publish-risk, so this run will not advance without explicit approval. Nothing has been attempted and no publication was performed — the status still reads \"running\" because no node is mid-flight. A hold is the design working, not a failure."
      : "Expected safety hold before publish-risk execution — no publication was performed. A hold is the design working, not a failure."}</div>}
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
    <Glossary id="execution" />

    <h3>Approvals required</h3>
    {run.approvalsRequired.length ? <ul className="compact-list">{run.approvalsRequired.map((approval) => <li key={`${approval.nodeId}-${approval.requestedAt}`}><strong>{approval.type}</strong> for <code>{approval.nodeId}</code><br /><span>{approval.reason}</span></li>)}</ul> : <p>No approvals required.</p>}
  </section>;
}
