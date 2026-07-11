import { WorkspaceGraph } from "../WorkspaceGraph";
import { WorkflowControls } from "../WorkflowControls";
import { RunStatusPanel } from "../RunStatusPanel";
import { NodeExecutionList } from "../NodeExecutionList";
import type { useWorkspace } from "../../hooks/useWorkspace";
import type { useWorkflowRun } from "../../hooks/useWorkflowRun";
import type { StatusMessage } from "../../status";

// Legacy Builder tab, embedded under /constellation?legacy=builder until S5 moves run controls
// to Operate mode and the Runs page. JSX and handlers moved verbatim from App.
type Props = {
  workspace: ReturnType<typeof useWorkspace>;
  workflowRun: ReturnType<typeof useWorkflowRun>;
  refreshUsage: () => Promise<void>;
  defaultProjectId?: string;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

export function LegacyBuilderPanel({ workspace, workflowRun, refreshUsage, defaultProjectId, onStatus, onError }: Props) {
  const loadWorkspace = async () => {
    try {
      await workspace.loadWorkspace();
      onStatus({ tone: "success", message: "Workspace loaded from MCP." });
    } catch (error) {
      onError(error);
    }
  };
  const moveSelected = async (direction: -1 | 1) => { if (!workspace.selectedId) return; const ids = workspace.nodes.map((node) => node.id); const index = ids.indexOf(workspace.selectedId); const next = index + direction; if (index < 0 || next < 0 || next >= ids.length) return; [ids[index], ids[next]] = [ids[next], ids[index]]; try { await workspace.reorderNodes(ids); onStatus({ tone: "success", message: "Saved graph order without changing dependencies." }); } catch (error) { onError(error); } };
  const validateGraph = async () => { try { const result = await workspace.validateGraph(); onStatus({ tone: result.validation.valid ? "success" : "error", message: result.validation.valid ? "Graph is valid." : `Graph issues: ${result.validation.issues.join("; ")}` }); } catch (error) { onError(error); } };
  const workflowAction = async <T,>(operation: () => Promise<T>, successMessage: (result: T) => string, afterSuccess?: (result: T) => Promise<void>) => {
    try {
      const result = await operation();
      if (afterSuccess) await afterSuccess(result);
      onStatus({ tone: "success", message: successMessage(result) });
      return result;
    } catch (error) {
      onError(error);
      throw error;
    }
  };

  return <section className="tab-panel" aria-label="Builder workspace (legacy)">
    <section className="workspace-grid">
      <section className="panel graph-panel" aria-label="Workspace graph">
        <div className="panel-heading"><div><h2>Builder map</h2><p className="muted">Select a node, reorder it, validate edges, and save graph changes through MCP.</p></div><div className="auth-actions"><button onClick={loadWorkspace}>Load workspace</button><button onClick={() => moveSelected(-1)}>Move up</button><button onClick={() => moveSelected(1)}>Move down</button><button onClick={validateGraph}>Validate graph</button></div></div>
        <WorkspaceGraph nodes={workspace.nodes} selectedNodeId={workspace.selectedId} onSelectNode={workspace.setSelectedId} executionStatusByNodeId={workflowRun.nodeStatusById} />
      </section>
      <WorkflowControls currentRun={workflowRun.currentRun} runs={workflowRun.runs} selectedRunId={workflowRun.selectedRunId} loading={workflowRun.loading} defaultProjectId={defaultProjectId} onStartDryRun={(projectId, input, mode) => workflowAction(() => workflowRun.startDryRun(projectId, input, mode), (run) => `Started ${run.executionMode ?? "mock"} run ${run.runId}.`)} onRunNextNode={() => workflowAction(workflowRun.runNextNode, (run) => run?.status === "blocked" ? "Run blocked before publish-risk execution." : `Advanced run to ${run?.currentNodeId ?? run?.status ?? "next state"}.`, async () => refreshUsage())} onRunUntil={(nodeId) => workflowAction(() => workflowRun.runUntil(nodeId), (run) => `Ran until ${nodeId}: ${run?.status ?? "unknown"}.`, async () => refreshUsage())} onRunAll={() => workflowAction(workflowRun.runAll, (run) => `Run all stopped at ${run?.currentNodeId ?? run?.status ?? "next state"}.`, async () => refreshUsage())} onPauseRun={() => workflowAction(workflowRun.pauseRun, (run) => `Paused ${run?.runId ?? "run"}.`)} onResumeRun={() => workflowAction(workflowRun.resumeRun, (run) => `Resumed ${run?.runId ?? "run"}.`)} onCancelRun={() => workflowAction(workflowRun.cancelRun, (run) => `Cancelled ${run?.runId ?? "run"}.`)} onRetryNode={(nodeId) => workflowAction(() => workflowRun.retryNode(nodeId), (run) => `Retried node; run is ${run?.status ?? "unknown"}.`, async () => refreshUsage())} onResetRun={() => workflowAction(workflowRun.resetRun, (run) => `Reset dry-run ${run?.runId ?? "run"}.`)} onRefreshRun={() => workflowAction(workflowRun.refreshRun, (run) => `Refreshed dry-run ${run?.runId ?? "run"}.`)} onListRuns={(projectId) => workflowAction(() => workflowRun.listRuns(projectId), (runs) => `Loaded ${runs.length} dry-run${runs.length === 1 ? "" : "s"}.`)} onLoadRun={(runId) => workflowAction(() => workflowRun.loadRun(runId), (run) => `Loaded dry-run ${run?.runId ?? runId}.`)} />
    </section>
    <section className="execution-grid builder-status-grid">
      <RunStatusPanel run={workflowRun.currentRun} />
      <NodeExecutionList run={workflowRun.currentRun} />
    </section>
  </section>;
}
