import { useConnection } from "../hooks/useConnection";
import { describeCapabilities } from "../capabilities";
import { summarizeConnectionAuth } from "../connection";
import type { McpConnection } from "../connection";
import type { McpClient } from "../mcp/client";
import type { InitializeResult } from "../types/workspace";

type ConnectionPanelProps = {
  connection: McpConnection;
  client: McpClient;
  token: string;
  onEndpointChange: (endpoint: string) => void;
  onTokenChange: (token: string) => void;
  onConnectionSuccess: (result: InitializeResult) => void;
  onConnectionError: (error: unknown) => void;
};

// GCloud (Cloud Run) is the only control plane: this panel is just the endpoint override (for
// local dev or a staging Cloud Run URL) and the MCP bearer token. There is no plane or auth-mode
// choice to make.
export function ConnectionPanel({ connection, client, token, onEndpointChange, onTokenChange, onConnectionSuccess, onConnectionError }: ConnectionPanelProps) {
  const { connectionStatus, capabilities, testConnection } = useConnection(client);
  const authSummary = summarizeConnectionAuth(connection);

  const handleTestConnection = async () => {
    try {
      onConnectionSuccess(await testConnection());
    } catch (error) {
      onConnectionError(error);
    }
  };

  return <div className="auth-card">
    <label>Cloud Run MCP endpoint<input value={connection.endpoint} onChange={(event) => onEndpointChange(event.target.value)} placeholder="https://<service>.run.app/mcp" /></label>
    <label>MCP bearer token<input type="password" value={token} onChange={(event) => onTokenChange(event.target.value)} placeholder="Stored in localStorage" /></label>
    <p className="connection-summary">{authSummary.label}</p>
    <div className="auth-actions"><button onClick={handleTestConnection}>Test connection</button></div>
    {connectionStatus.tone === "success" && <p className="connection-summary">Server: <strong>{connectionStatus.serverName ?? "unknown"}</strong><br />Protocol: <strong>{connectionStatus.protocolVersion ?? "unknown"}</strong></p>}
    {capabilities && <div className="connection-capabilities">
      <p className="connection-summary">{describeCapabilities(capabilities)}</p>
      {capabilities.scoped && <ul aria-label="Available surfaces">
        {capabilities.areas.map((area) => <li key={area.id} className={area.available ? "capability-yes" : "capability-no"}>
          {area.available ? "Available" : "Not in this token"}: {area.label}
        </li>)}
      </ul>}
    </div>}
  </div>;
}
