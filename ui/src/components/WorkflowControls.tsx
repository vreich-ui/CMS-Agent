import { useEffect, useState } from "react";
import type { WorkflowExecutionRecord } from "../types/workspace";

type WorkflowControlsProps = {
  currentRun: WorkflowExecutionRecord | null;
  runs: WorkflowExecutionRecord[];
  selectedRunId: string | null;
  loading: boolean;
  onStartDryRun: (projectId: string, input: string) => Promise<WorkflowExecutionRecord>;
  onRunNextNode: () => Promise<WorkflowExecutionRecord | null>;
  onResetRun: () => Promise<WorkflowExecutionRecord | null>;
  onRefreshRun: () => Promise<WorkflowExecutionRecord | null>;
  onListRuns: (projectId?: string) => Promise<WorkflowExecutionRecord[]>;
  onLoadRun: (runId: string) => Promise<WorkflowExecutionRecord | null>;
};

export function WorkflowControls({ currentRun, runs, selectedRunId, loading, onStartDryRun, onRunNextNode, onResetRun, onRefreshRun, onListRuns, onLoadRun }: WorkflowControlsProps) {
  const [projectId, setProjectId] = useState("project-a");
  const [initialInput, setInitialInput] = useState("Draft a deterministic dry-run article through the Publishing Conductor.");

  useEffect(() => {
    void onListRuns(projectId).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isTerminal = currentRun ? ["blocked", "cancelled", "completed", "failed"].includes(currentRun.status) : true;

  return <section className="panel workflow-controls" aria-label="Dry-run workflow controls">
    <div className="panel-heading"><div><h2>Dry-run execution</h2><p className="muted">Mock Publishing Conductor execution only. No OpenAI, external MCP, or publishing calls are made.</p></div></div>
    <label>Project ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
    <label>Initial input<textarea rows={5} value={initialInput} onChange={(event) => setInitialInput(event.target.value)} /></label>
    <div className="auth-actions">
      <button disabled={loading || !projectId.trim()} onClick={() => onStartDryRun(projectId.trim(), initialInput)}>Start Dry Run</button>
      <button disabled={loading || !currentRun || isTerminal} onClick={onRunNextNode}>Run Next Node</button>
      <button disabled={loading || !currentRun} onClick={onResetRun}>Reset Run</button>
      <button disabled={loading || !currentRun} onClick={onRefreshRun}>Refresh Run</button>
      <button disabled={loading} onClick={() => onListRuns(projectId)}>List Runs</button>
    </div>
    <label>Recent runs<select value={selectedRunId ?? ""} onChange={(event) => event.target.value && onLoadRun(event.target.value)}>
      <option value="">Select a run…</option>
      {runs.map((run) => <option key={run.runId} value={run.runId}>{run.runId} · {run.status}</option>)}
    </select></label>
  </section>;
}
