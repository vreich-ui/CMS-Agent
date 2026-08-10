import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "./useConnection";
import type { McpClient } from "../mcp/client";
import type { AgentListResult, AgentWriteResult, ConversationalAgentView } from "../conversationalAgents";

/**
 * Reads the conversational agent definitions and owns the guarded write.
 *
 * agent.list is deliberately the only read: it already returns full prompts, so a scoped token
 * that carries agent.* but not workspace.* can still drive this page.
 */
export function useConversationalAgents(client: McpClient) {
  const [agents, setAgents] = useState<ConversationalAgentView[]>([]);
  const [workspaceVersion, setWorkspaceVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const result = await client.call<AgentListResult>("agent.list", {});
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      setAgents(result.agents ?? []);
      setWorkspaceVersion(typeof result.workspaceVersion === "number" ? result.workspaceVersion : null);
      setError(null);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setAgents([]);
      setWorkspaceVersion(null);
      setError(getErrorMessage(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Throws on failure so the caller can classify it; the page renders a typed recovery hint
  // rather than a bare message.
  const updateAgent = useCallback(async (id: string, patch: Record<string, unknown>, reason: string, summary: string) => {
    if (workspaceVersion === null) throw new Error("Workspace version is unknown; reload before saving.");
    const result = await client.call<AgentWriteResult>("agent.update", {
      id,
      patch,
      expectedWorkspaceVersion: workspaceVersion,
      // `actor` is omitted on purpose, exactly as node writes do: the server stamps the verified
      // identity, and a tool-supplied actor would override it with an unverified guess.
      source: "ui" as const,
      reason: reason.trim(),
      summary
    });
    setAgents((current) => current.map((agent) => agent.id === id ? result.agent : agent));
    setWorkspaceVersion(result.workspaceVersion);
    return result;
  }, [client, workspaceVersion]);

  return { agents, workspaceVersion, loading, error, refresh: load, updateAgent };
}
