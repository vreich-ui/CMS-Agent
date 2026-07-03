import { useCallback, useMemo, useState } from "react";
import { callMcpTool } from "../mcp/client";
import type { McpConfig, WorkflowExecutionRecord } from "../types/workspace";

export function useWorkflowRun(config: McpConfig) {
  const [currentRun, setCurrentRun] = useState<WorkflowExecutionRecord | null>(null);
  const [runs, setRuns] = useState<WorkflowExecutionRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const withLoading = useCallback(async <T,>(operation: () => Promise<T>) => {
    setLoading(true);
    try {
      return await operation();
    } finally {
      setLoading(false);
    }
  }, []);

  const startDryRun = useCallback(async (projectId: string, input: string) => withLoading(async () => {
    const result = await callMcpTool<{ run: WorkflowExecutionRecord }>(config, "workflow.start_dry_run", { projectId, input });
    setCurrentRun(result.run);
    setSelectedRunId(result.run.runId);
    setRuns((current) => [result.run, ...current.filter((run) => run.runId !== result.run.runId)]);
    return result.run;
  }), [config, withLoading]);

  const loadRun = useCallback(async (runId: string) => withLoading(async () => {
    const result = await callMcpTool<{ run: WorkflowExecutionRecord | null }>(config, "workflow.get_run", { runId });
    setCurrentRun(result.run);
    setSelectedRunId(result.run?.runId ?? runId);
    return result.run;
  }), [config, withLoading]);

  const listRuns = useCallback(async (projectId?: string) => withLoading(async () => {
    const args = projectId?.trim() ? { projectId } : {};
    const result = await callMcpTool<{ runs: WorkflowExecutionRecord[] }>(config, "workflow.list_runs", args);
    setRuns(result.runs);
    if (!currentRun && result.runs[0]) {
      setCurrentRun(result.runs[0]);
      setSelectedRunId(result.runs[0].runId);
    }
    return result.runs;
  }), [config, currentRun, withLoading]);

  const runNextNode = useCallback(async () => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await callMcpTool<{ run: WorkflowExecutionRecord }>(config, "workflow.run_next_node", { runId: currentRun.runId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [config, currentRun, withLoading]);

  const resetRun = useCallback(async () => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await callMcpTool<{ run: WorkflowExecutionRecord }>(config, "workflow.reset_run", { runId: currentRun.runId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [config, currentRun, withLoading]);

  const refreshRun = useCallback(async () => {
    if (!currentRun && !selectedRunId) return null;
    return loadRun(currentRun?.runId ?? selectedRunId!);
  }, [currentRun, loadRun, selectedRunId]);

  const nodeStatusById = useMemo(() => new Map(currentRun?.nodes.map((node) => [node.nodeId, node.status]) ?? []), [currentRun]);

  return {
    currentRun,
    runs,
    selectedRunId,
    loading,
    nodeStatusById,
    setSelectedRunId,
    startDryRun,
    loadRun,
    listRuns,
    runNextNode,
    resetRun,
    refreshRun
  };
}
