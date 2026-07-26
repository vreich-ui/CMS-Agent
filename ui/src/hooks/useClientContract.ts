import { useCallback, useEffect, useRef, useState } from "react";
import type { McpClient } from "../mcp/client";

// Identity-layer probe for the S4 inspector (CHANGE-PLAN R-11, read-only phase).
//
// The Identity layer is the only one that depends on a live client connection, and the only one
// that can lie by omission — a contract that was never fetched must not render like a fresh one.
// So this hook reports exactly two facts, and never fabricates a third: when the probe last
// succeeded (`fetchedAt`), and why it did not (`error`). `identityLayer()` in nodeInspector.ts
// turns those into the rendered state.
//
// The probe is `project.test_connection` — a primitive MCP initialize against the client's server.
// It is deliberately NOT `project.call_tool`: reachability is the question, and invoking a tool on
// someone else's server to answer it is a side effect the inspector has no business causing.
// Fail-closed is the correct outcome while the endpoint/token env vars are unset.

export type ClientContractProbe = {
  fetchedAt: string | null;
  error: string | null;
  probing: boolean;
  probe: () => Promise<void>;
};

type TestConnectionResult = { ok?: boolean; connected?: boolean; error?: string; message?: string; serverInfo?: { name?: string } };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useClientContract(client: McpClient, projectId: string | null): ClientContractProbe {
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const activeRequest = useRef(0);

  const probe = useCallback(async () => {
    if (!projectId) {
      setFetchedAt(null);
      setError(null);
      setProbing(false);
      return;
    }

    const requestId = ++activeRequest.current;
    setProbing(true);
    try {
      const result = await client.call<TestConnectionResult>("project.test_connection", { projectId });
      if (requestId !== activeRequest.current) return;
      // A structurally successful call can still report an unreachable client. Treating the
      // envelope's own verdict as authoritative is what keeps "responded" from being mistaken for
      // "connected".
      const reachable = result?.connected ?? result?.ok ?? false;
      if (reachable) {
        setFetchedAt(new Date().toISOString());
        setError(null);
      } else {
        setFetchedAt(null);
        setError(result?.error ?? result?.message ?? "The client MCP server did not complete an initialize handshake.");
      }
    } catch (caught) {
      if (requestId !== activeRequest.current) return;
      setFetchedAt(null);
      setError(errorMessage(caught));
    } finally {
      if (requestId === activeRequest.current) setProbing(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    setFetchedAt(null);
    setError(null);
    void probe();
  }, [probe]);

  return { fetchedAt, error, probing, probe };
}
