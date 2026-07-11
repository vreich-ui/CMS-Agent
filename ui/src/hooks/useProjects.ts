import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "./useConnection";
import type { McpClient } from "../mcp/client";
import type { ProjectSummary } from "../types/workspace";

// Registered project connections for the header selector. Read-only; degrades to null with a
// retriable error so a missing token never breaks the shell.
export function useProjects(client: McpClient) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await client.call<{ projects: ProjectSummary[] }>("project.list");
      setProjects(result.projects);
      setError(null);
    } catch (cause) {
      setProjects(null);
      setError(getErrorMessage(cause));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { projects, error, refresh };
}
