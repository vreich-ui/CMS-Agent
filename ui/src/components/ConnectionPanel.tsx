import { useConnection } from "../hooks/useConnection";
import type { InitializeResult } from "../types/workspace";

type ConnectionPanelProps = {
  endpoint: string;
  token: string;
  onEndpointChange: (endpoint: string) => void;
  onTokenChange: (token: string) => void;
  onConnectionSuccess: (result: InitializeResult) => void;
  onConnectionError: (error: unknown) => void;
  showTokenField?: boolean;
};

export function ConnectionPanel({ endpoint, token, onEndpointChange, onTokenChange, onConnectionSuccess, onConnectionError, showTokenField = true }: ConnectionPanelProps) {
  const { connectionStatus, testConnection } = useConnection(endpoint, token);

  const handleTestConnection = async () => {
    try {
      onConnectionSuccess(await testConnection());
    } catch (error) {
      onConnectionError(error);
    }
  };

  return <div className="auth-card">
    <label>Endpoint<input value={endpoint} onChange={(event) => onEndpointChange(event.target.value)} /></label>
    {showTokenField ? <label>MCP bearer token<input type="password" value={token} onChange={(event) => onTokenChange(event.target.value)} placeholder="Stored in localStorage" /></label> : <p className="connection-summary">Using Netlify Identity secure proxy. MCP bearer tokens are not stored in the browser.</p>}
    <div className="auth-actions"><button onClick={handleTestConnection}>Test connection</button></div>
    {connectionStatus.tone === "success" && <p className="connection-summary">Server: <strong>{connectionStatus.serverName ?? "unknown"}</strong><br />Protocol: <strong>{connectionStatus.protocolVersion ?? "unknown"}</strong></p>}
  </div>;
}
