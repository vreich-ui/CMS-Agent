import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "./useConnection";
import type { McpClient } from "../mcp/client";
import type { ModelUsageSummary, ProjectSummary, RepositoryHealthSummary, WorkflowExecutionRecord, WorkspaceChangeEvent, WorkspaceNode } from "../types/workspace";

export type OverviewData = {
  nodes: WorkspaceNode[] | null;
  runs: WorkflowExecutionRecord[] | null;
  usageSummary: ModelUsageSummary | null;
  projects: ProjectSummary[] | null;
  repositoryHealth: RepositoryHealthSummary | null;
  recentChangeEvents: WorkspaceChangeEvent[] | null;
};

const emptyData: OverviewData = { nodes: null, runs: null, usageSummary: null, projects: null, repositoryHealth: null, recentChangeEvents: null };

// Read-only overview loader. Each section loads independently so one failing MCP tool (or a
// missing token) degrades that section instead of blanking the whole page. All data comes from
// MCP on every refresh; nothing is cached as source of truth in the UI. The shared McpClient
// resolves the connection at call time, so a token entered after mount is used by the very next
// refresh without remounting. When projectId is set (header selector), runs and usage are scoped
// to it; nodes/projects/storage stay workspace-wide.
export function useOverview(client: McpClient, projectId?: string | null) {
  const [data, setData] = useState<OverviewData>(emptyData);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const scope = projectId ? { projectId } : {};
      const [nodes, runs, usageSummary, projects, repositoryHealth, recentChanges] = await Promise.allSettled([
        client.call<{ nodes: WorkspaceNode[] }>("workspace.get_nodes"),
        client.call<{ runs: WorkflowExecutionRecord[] }>("workflow.list_runs", scope),
        client.call<{ summary: ModelUsageSummary }>("usage.get_summary", scope),
        client.call<{ projects: ProjectSummary[] }>("project.list"),
        client.call<{ health: RepositoryHealthSummary }>("repository.get_health"),
        // Layer-2 awareness: recent change activity is workspace-wide, never project-scoped.
        client.call<{ events: WorkspaceChangeEvent[] }>("changes.list", { limit: 50 })
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
        repositoryHealth: section(repositoryHealth, "Storage", (value) => value.health),
        recentChangeEvents: section(recentChanges, "Changes", (value) => value.events)
      });
      setErrors([...new Set(nextErrors)]);
      setLoadedAt(new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, errors, loading, loadedAt, refresh };
}
