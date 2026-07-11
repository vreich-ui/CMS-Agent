import { useCallback, useEffect, useRef, useState } from "react";
import { callMcpTool } from "../mcp/client";
import { getErrorMessage } from "./useConnection";
import type { McpConfig, ModelUsageSummary, ProjectSummary, RepositoryHealthSummary, WorkflowExecutionRecord, WorkspaceNode } from "../types/workspace";

export type OverviewData = {
  nodes: WorkspaceNode[] | null;
  runs: WorkflowExecutionRecord[] | null;
  usageSummary: ModelUsageSummary | null;
  projects: ProjectSummary[] | null;
  repositoryHealth: RepositoryHealthSummary | null;
};

const emptyData: OverviewData = { nodes: null, runs: null, usageSummary: null, projects: null, repositoryHealth: null };

// Read-only overview loader. Each section loads independently so one failing MCP tool (or a
// missing token) degrades that section instead of blanking the whole page. All data comes from
// MCP on every refresh; nothing is cached as source of truth in the UI.
export function useOverview(config: McpConfig) {
  const [data, setData] = useState<OverviewData>(emptyData);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  // refresh reads config through a ref so it stays stable while the user types an endpoint or
  // token; data reloads on mount and on explicit refresh, not on every keystroke.
  const configRef = useRef(config);
  configRef.current = config;

  const refresh = useCallback(async () => {
    setLoading(true);
    const current = configRef.current;
    try {
      const [nodes, runs, usageSummary, projects, repositoryHealth] = await Promise.allSettled([
        callMcpTool<{ nodes: WorkspaceNode[] }>(current, "workspace.get_nodes"),
        callMcpTool<{ runs: WorkflowExecutionRecord[] }>(current, "workflow.list_runs"),
        callMcpTool<{ summary: ModelUsageSummary }>(current, "usage.get_summary"),
        callMcpTool<{ projects: ProjectSummary[] }>(current, "project.list"),
        callMcpTool<{ health: RepositoryHealthSummary }>(current, "repository.get_health")
      ]);
      const nextErrors: string[] = [];
      const section = <T, R>(result: PromiseSettledResult<T>, label: string, pick: (value: T) => R): R | null => {
        if (result.status === "fulfilled") return pick(result.value);
        nextErrors.push(`${label}: ${getErrorMessage(result.reason)}`);
        return null;
      };
      setData({
        nodes: section(nodes, "Nodes", (value) => value.nodes),
        runs: section(runs, "Runs", (value) => value.runs),
        usageSummary: section(usageSummary, "Usage", (value) => value.summary),
        projects: section(projects, "Projects", (value) => value.projects),
        repositoryHealth: section(repositoryHealth, "Storage", (value) => value.health)
      });
      setErrors([...new Set(nextErrors)]);
      setLoadedAt(new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, errors, loading, loadedAt, refresh };
}
