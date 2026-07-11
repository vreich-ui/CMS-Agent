import { useConnection } from "../hooks/useConnection";
import { summarizeConnectionAuth } from "../connection";
import type { ConnectionMode, McpConnection } from "../connection";
import type { McpClient } from "../mcp/client";
import type { InitializeResult } from "../types/workspace";

type ConnectionPanelProps = {
  connection: McpConnection;
  client: McpClient;
  token: string;
  allowModeSwitch?: boolean;
  onModeChange: (mode: ConnectionMode) => void;
  onEndpointChange: (endpoint: string) => void;
  onTokenChange: (token: string) => void;
  onConnectionSuccess: (result: InitializeResult) => void;
  onConnectionError: (error: unknown) => void;
};

const modeOptions: Array<{ value: ConnectionMode; label: string }> = [
  { value: "direct", label: "Direct MCP token" },
  { value: "secure-proxy", label: "Identity secure proxy" }
];

export function ConnectionPanel({ connection, client, token, allowModeSwitch = true, onModeChange, onEndpointChange, onTokenChange, onConnectionSuccess, onConnectionError }: ConnectionPanelProps) {
  const { connectionStatus, testConnection } = useConnection(client);
  const authSummary = summarizeConnectionAuth(connection);

  const handleTestConnection = async () => {
    try {
      onConnectionSuccess(await testConnection());
    } catch (error) {
      onConnectionError(error);
    }
  };

  return <div className="auth-card">
    {allowModeSwitch && <fieldset className="mode-switch">
      <legend>Connection mode</legend>
      {modeOptions.map((option) => <label key={option.value} className="mode-option">
        <input type="radio" name="connection-mode" value={option.value} checked={connection.mode === option.value} onChange={() => onModeChange(option.value)} />
        <span>{option.label}</span>
      </label>)}
    </fieldset>}
    <label>Endpoint<input value={connection.endpoint} onChange={(event) => onEndpointChange(event.target.value)} /></label>
    {connection.mode === "direct" && <label>MCP bearer token<input type="password" value={token} onChange={(event) => onTokenChange(event.target.value)} placeholder="Stored in localStorage" /></label>}
    <p className="connection-summary">{authSummary.label}</p>
    <div className="auth-actions"><button onClick={handleTestConnection}>Test connection</button></div>
    {connectionStatus.tone === "success" && <p className="connection-summary">Server: <strong>{connectionStatus.serverName ?? "unknown"}</strong><br />Protocol: <strong>{connectionStatus.protocolVersion ?? "unknown"}</strong></p>}
  </div>;
}
