import { useMemo, useState } from "react";
import { callMcpMethod, McpClientError } from "../mcp/client";
import type { ConnectionStatus, InitializeResult, McpConfig } from "../types/workspace";

export function getErrorMessage(error: unknown) {
  return error instanceof McpClientError ? error.message : error instanceof Error ? error.message : "Unknown error";
}

export function useConnection(endpoint: string, token: string | undefined) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ tone: "idle" });
  const config = useMemo<McpConfig>(() => ({ endpoint, token }), [endpoint, token]);

  const testConnection = async () => {
    try {
      const result = await callMcpMethod<InitializeResult>(config, "initialize", {});
      setConnectionStatus({
        tone: "success",
        serverName: result.serverInfo?.name,
        protocolVersion: result.protocolVersion
      });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      setConnectionStatus({ tone: "error", error: message });
      throw error;
    }
  };

  return { config, connectionStatus, testConnection };
}
