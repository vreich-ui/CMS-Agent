import type { WorkflowExecutionRecord } from "../types/workspace";

export function NodeExecutionList({ run }: { run: WorkflowExecutionRecord | null }) {
  return <section className="panel node-execution-list">
    <h2>Node progress</h2>
    {!run ? <p>No dry-run selected yet.</p> : <div className="node-list">{run.nodes.map((node) => <article key={node.nodeId} className={`node-execution-card execution-border-${node.status}`}>
      <div className="node-execution-heading"><strong>{node.nodeId}</strong><span className={`execution-pill execution-${node.status}`}>{node.status}</span></div>
      <dl>
        <dt>Started</dt><dd>{node.startedAt ?? "—"}</dd>
        <dt>Completed</dt><dd>{node.completedAt ?? "—"}</dd>
        <dt>Duration</dt><dd>{node.durationMs !== undefined ? `${node.durationMs} ms` : "—"}</dd>
        <dt>Outputs</dt><dd>{node.produces?.length ? node.produces.join(", ") : "—"}</dd>
      </dl>
      {!!node.warnings?.length && <p className="warning-text"><strong>Warnings:</strong> {node.warnings.join(", ")}</p>}
      {!!node.errors?.length && <p className="error-text"><strong>Errors:</strong> {node.errors.join(", ")}</p>}
    </article>)}</div>}
  </section>;
}
