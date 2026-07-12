import { useState } from "react";
import { McpClientError } from "../mcp/client";
import type { McpClient } from "../mcp/client";
import type { ConnectionStatus, InitializeResult } from "../types/workspace";

// Store-thrown errors travel as a generic JSON-RPC "Tool execution failed" wrapper with the real
// message nested in error.data ({ok:false, error:{message}}). Surface the specific message —
// conflict handling and refusal banners depend on the verbatim server text. Details were already
// redacted at McpClientError construction, so this never widens what can leak.
const nestedToolMessage = (details: unknown): string | null => {
  if (!details || typeof details !== "object") return null;
  const envelope = details as { error?: { message?: unknown }; message?: unknown };
  if (envelope.error && typeof envelope.error.message === "string") return envelope.error.message;
  if (typeof envelope.message === "string") return envelope.message;
  return null;
};

export function getErrorMessage(error: unknown) {
  if (error instanceof McpClientError) return nestedToolMessage(error.details) ?? error.message;
  return error instanceof Error ? error.message : "Unknown error";
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
