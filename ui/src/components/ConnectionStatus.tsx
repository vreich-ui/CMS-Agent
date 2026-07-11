import { summarizeConnectionAuth, type McpConnection } from "../connection";

// Honest connection affordance: reports the credential state (mode + credential-present), never a
// fake "connected" liveness claim, and links to Settings where the real controls live.
export function ConnectionStatus({ connection, onOpenSettings }: { connection: McpConnection; onOpenSettings: () => void }) {
  const summary = summarizeConnectionAuth(connection);
  const label = connection.mode === "secure-proxy" ? "Identity proxy" : summary.kind === "direct-ready" ? "Token set" : "Token needed";
  return <button type="button" className={`connection-chip connection-chip-${summary.kind}`} title={summary.label} onClick={onOpenSettings}>
    {label}
  </button>;
}
