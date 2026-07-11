import { useState } from "react";
import { McpClientError } from "../mcp/client";
import type { McpClient } from "../mcp/client";
import type { ConnectionStatus, InitializeResult } from "../types/workspace";

export function getErrorMessage(error: unknown) {
  return error instanceof McpClientError ? error.message : error instanceof Error ? error.message : "Unknown error";
}

// Consumes the shared McpClient instead of building its own config, so "Test connection" always
// uses exactly the credentials the rest of the app sends (the old duplicated config here is the
// divergence documented in docs/constellation/data-model-gaps.md §1).
export function useConnection(client: McpClient) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ tone: "idle" });

  const testConnection = async () => {
    try {
      const result = await client.method<InitializeResult>("initialize", {});
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

  return { connectionStatus, testConnection };
}
