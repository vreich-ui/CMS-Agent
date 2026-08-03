import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpClient } from "../mcp/client";
import type { WorkflowExecutionRecord } from "../types/workspace";

export function useWorkflowRun(client: McpClient) {
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

  const startDryRun = useCallback(async (projectId: string, input: string, executionMode: "mock" | "openai" = "mock") => withLoading(async () => {
    const result = await client.call<{ run: WorkflowExecutionRecord }>("workflow.start_dry_run", { projectId, input, executionMode });
    setCurrentRun(result.run);
    setSelectedRunId(result.run.runId);
    setRuns((current) => [result.run, ...current.filter((run) => run.runId !== result.run.runId)]);
    return result.run;
  }), [client, withLoading]);

  const loadRun = useCallback(async (runId: string) => withLoading(async () => {
    const result = await client.call<{ run: WorkflowExecutionRecord | null }>("workflow.get_run", { runId });
    setCurrentRun(result.run);
    setSelectedRunId(result.run?.runId ?? runId);
    return result.run;
  }), [client, withLoading]);

  const listRuns = useCallback(async (projectId?: string) => withLoading(async () => {
    const args = projectId?.trim() ? { projectId } : {};
    const result = await client.call<{ runs: WorkflowExecutionRecord[] }>("workflow.list_runs", args);
    setRuns(result.runs);
    if (!currentRun && result.runs[0]) {
      // list_runs deliberately omits payload-heavy fields. Hydrate only the one row selected for
      // the detail panels, instead of downloading every historical run and all of its outputs.
      const detail = await client.call<{ run: WorkflowExecutionRecord | null }>("workflow.get_run", { runId: result.runs[0].runId });
      setCurrentRun(detail.run);
      setSelectedRunId(detail.run?.runId ?? result.runs[0].runId);
    }
    return result.runs;
  }), [client, currentRun, withLoading]);

  const runNextNode = useCallback(async () => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await client.call<{ run: WorkflowExecutionRecord }>("workflow.run_next_node", { runId: currentRun.runId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [client, currentRun, withLoading]);

  const runUntil = useCallback(async (nodeId: string) => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await client.call<{ run: WorkflowExecutionRecord }>("workflow.run_until", { runId: currentRun.runId, nodeId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [client, currentRun, withLoading]);

  const runAll = useCallback(async () => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await client.call<{ run: WorkflowExecutionRecord }>("workflow.run_all", { runId: currentRun.runId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [client, currentRun, withLoading]);

  const setRunState = useCallback(async (tool: "workflow.pause_run" | "workflow.resume_run" | "workflow.cancel_run") => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await client.call<{ run: WorkflowExecutionRecord }>(tool, { runId: currentRun.runId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [client, currentRun, withLoading]);

  const retryNode = useCallback(async (nodeId?: string) => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await client.call<{ run: WorkflowExecutionRecord }>("workflow.retry_node", { runId: currentRun.runId, nodeId: nodeId ?? currentRun.currentNodeId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [client, currentRun, withLoading]);

  const resetRun = useCallback(async () => {
    if (!currentRun) return null;
    return withLoading(async () => {
      const result = await client.call<{ run: WorkflowExecutionRecord }>("workflow.reset_run", { runId: currentRun.runId });
      setCurrentRun(result.run);
      setRuns((current) => current.map((run) => run.runId === result.run.runId ? result.run : run));
      return result.run;
    });
  }, [client, currentRun, withLoading]);

  const refreshRun = useCallback(async () => {
    if (!currentRun && !selectedRunId) return null;
    return loadRun(currentRun?.runId ?? selectedRunId!);
  }, [currentRun, loadRun, selectedRunId]);

  // A run/run-list is inherently tied to the connection it was loaded from — a run ID from
  // Netlify's execution repository has no meaning against Cloud Run's and vice versa. There is no
  // "default" run to auto-fetch (run state is entirely user-action-driven, and stays that way
  // here — this only clears the PREVIOUS connection's stale run out of view on a client change).
  useEffect(() => {
    setCurrentRun(null);
    setRuns([]);
    setSelectedRunId(null);
  }, [client]);

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
    runUntil,
    runAll,
    pauseRun: () => setRunState("workflow.pause_run"),
    resumeRun: () => setRunState("workflow.resume_run"),
    cancelRun: () => setRunState("workflow.cancel_run"),
    retryNode,
    resetRun,
    refreshRun
  };
}
