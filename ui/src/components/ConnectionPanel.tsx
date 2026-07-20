import { useConnection } from "../hooks/useConnection";
import { summarizeConnectionAuth } from "../connection";
import type { ConnectionMode, ControlPlane, McpConnection } from "../connection";
import type { McpClient } from "../mcp/client";
import type { InitializeResult } from "../types/workspace";

type ConnectionPanelProps = {
  connection: McpConnection;
  client: McpClient;
  token: string;
  controlPlane?: ControlPlane;
  cloudRunAvailable?: boolean;
  allowModeSwitch?: boolean;
  onPlaneChange?: (plane: ControlPlane) => void;
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

const planeOptions: Array<{ value: ControlPlane; label: string }> = [
  { value: "netlify", label: "Netlify" },
  { value: "cloud-run", label: "Cloud Run" }
];

export function ConnectionPanel({ connection, client, token, controlPlane = "netlify", cloudRunAvailable = false, allowModeSwitch = true, onPlaneChange, onModeChange, onEndpointChange, onTokenChange, onConnectionSuccess, onConnectionError }: ConnectionPanelProps) {
  const { connectionStatus, testConnection } = useConnection(client);
  const authSummary = summarizeConnectionAuth(connection);
  // The Cloud Run plane always uses direct token auth, so the mode switch only applies to Netlify.
  const showModeSwitch = allowModeSwitch && controlPlane === "netlify";

  const handleTestConnection = async () => {
    try {
      onConnectionSuccess(await testConnection());
    } catch (error) {
      onConnectionError(error);
    }
  };

  return <div className="auth-card">
    {cloudRunAvailable && onPlaneChange && <fieldset className="mode-switch control-plane-switch">
      <legend>Control plane</legend>
      {planeOptions.map((option) => <label key={option.value} className="mode-option">
        <input type="radio" name="control-plane" value={option.value} checked={controlPlane === option.value} onChange={() => onPlaneChange(option.value)} />
        <span>{option.label}</span>
      </label>)}
      <p className="connection-summary">{controlPlane === "cloud-run" ? "Talking to the Google Cloud Run MCP service (direct token auth)." : "Talking to the Netlify MCP endpoint."}</p>
    </fieldset>}
    {showModeSwitch && <fieldset className="mode-switch">
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
