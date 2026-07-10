import { useEffect, useState } from "react";
import type { WorkflowExecutionRecord } from "../types/workspace";

type Mode = "mock" | "openai";
type WorkflowControlsProps = {
  currentRun: WorkflowExecutionRecord | null; runs: WorkflowExecutionRecord[]; selectedRunId: string | null; loading: boolean;
  onStartDryRun: (projectId: string, input: string, executionMode: Mode) => Promise<WorkflowExecutionRecord>;
  onRunNextNode: () => Promise<WorkflowExecutionRecord | null>; onRunUntil: (nodeId: string) => Promise<WorkflowExecutionRecord | null>; onRunAll: () => Promise<WorkflowExecutionRecord | null>;
  onPauseRun: () => Promise<WorkflowExecutionRecord | null>; onResumeRun: () => Promise<WorkflowExecutionRecord | null>; onCancelRun: () => Promise<WorkflowExecutionRecord | null>; onRetryNode: (nodeId?: string) => Promise<WorkflowExecutionRecord | null>;
  onResetRun: () => Promise<WorkflowExecutionRecord | null>; onRefreshRun: () => Promise<WorkflowExecutionRecord | null>; onListRuns: (projectId?: string) => Promise<WorkflowExecutionRecord[]>; onLoadRun: (runId: string) => Promise<WorkflowExecutionRecord | null>;
};

export function WorkflowControls({ currentRun, runs, selectedRunId, loading, onStartDryRun, onRunNextNode, onRunUntil, onRunAll, onPauseRun, onResumeRun, onCancelRun, onRetryNode, onResetRun, onRefreshRun, onListRuns, onLoadRun }: WorkflowControlsProps) {
  const [projectId, setProjectId] = useState("project-a");
  const [initialInput, setInitialInput] = useState("Draft a deterministic dry-run article through the Publishing Conductor.");
  const [executionMode, setExecutionMode] = useState<Mode>("mock");
  const [untilNodeId, setUntilNodeId] = useState("");
  useEffect(() => { void onListRuns(projectId).catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const isTerminal = currentRun ? ["cancelled", "completed", "failed"].includes(currentRun.status) : true;
  const nodeOptions = currentRun?.nodes ?? [];
  return <section className="panel workflow-controls" aria-label="Workflow execution controls">
    <div className="panel-heading"><div><h2>Workflow execution</h2><p className="muted">Choose mock or OpenAI mode. Publish-risk nodes still stop without explicit approval.</p></div></div>
    <label>Project ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
    <label>Execution mode<select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as Mode)}><option value="mock">Mock</option><option value="openai">OpenAI</option></select></label>
    <label>Initial input<textarea rows={5} value={initialInput} onChange={(event) => setInitialInput(event.target.value)} /></label>
    <div className="auth-actions">
      <button disabled={loading || !projectId.trim()} onClick={() => onStartDryRun(projectId.trim(), initialInput, executionMode)}>Start Run</button>
      <button disabled={loading || !currentRun || isTerminal} onClick={onRunNextNode}>Run One Node</button>
      <button disabled={loading || !currentRun || isTerminal || !untilNodeId} onClick={() => onRunUntil(untilNodeId)}>Run Until</button>
      <button disabled={loading || !currentRun || isTerminal} onClick={onRunAll}>Run All</button>
      <button disabled={loading || !currentRun} onClick={onPauseRun}>Pause</button>
      <button disabled={loading || !currentRun} onClick={onResumeRun}>Resume</button>
      <button disabled={loading || !currentRun} onClick={onCancelRun}>Cancel</button>
      <button disabled={loading || !currentRun} onClick={() => onRetryNode(currentRun?.currentNodeId)}>Retry Node</button>
      <button disabled={loading || !currentRun} onClick={onResetRun}>Reset</button>
      <button disabled={loading || !currentRun} onClick={onRefreshRun}>Refresh</button>
      <button disabled={loading} onClick={() => onListRuns(projectId)}>List Runs</button>
    </div>
    <label>Stop after node<select value={untilNodeId} onChange={(event) => setUntilNodeId(event.target.value)}><option value="">Select node…</option>{nodeOptions.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.nodeId} · {node.status}</option>)}</select></label>
    <label>Recent runs<select value={selectedRunId ?? ""} onChange={(event) => event.target.value && onLoadRun(event.target.value)}><option value="">Select a run…</option>{runs.map((run) => <option key={run.runId} value={run.runId}>{run.runId} · {run.executionMode ?? "mock"} · {run.status}</option>)}</select></label>
  </section>;
}
