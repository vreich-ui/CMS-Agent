import { ConnectionPanel } from "../ConnectionPanel";
import { AppearanceSettings } from "../AppearanceSettings";
import { SchemaViewer } from "../SchemaViewer";
import { Validator } from "../Validator";
import { UsagePanel } from "../UsagePanel";
import type { ConnectionMode, McpConnection } from "../../connection";
import type { McpClient } from "../../mcp/client";
import type { useWorkspace } from "../../hooks/useWorkspace";
import type { useModelUsage } from "../../hooks/useModelUsage";
import type { useTheme } from "../../hooks/useTheme";
import type { InitializeResult } from "../../types/workspace";
import type { StatusMessage } from "../../status";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const repositoryNames = ["workspace", "execution", "artifact", "learning", "usage", "skill"] as const;

// Moved verbatim from App during the shell migration.
const RepositoryDiagnostics = ({ health, onRefresh }: { health: ReturnType<typeof useWorkspace>["repositoryHealth"]; onRefresh: () => void }) => {
  const entries = health ? repositoryNames.map((name) => [name, health[name]] as const) : [];
  return <section className="panel">
    <div className="panel-heading"><div><h2>Repository diagnostics</h2><p className="muted">Safe repository health metadata only. Storage paths and secrets are not displayed.</p></div><button onClick={onRefresh}>Refresh</button></div>
    {health && <div className="diagnostic-summary" aria-label="Storage summary"><span><strong>Repository backend</strong>{health.backend}</span><span><strong>Storage health</strong>{health.storageHealth}</span><span><strong>Workspace version</strong>{health.workspaceVersion}</span></div>}
    {entries.length ? <div className="table-wrap"><table><thead><tr><th>Repository</th><th>Backend</th><th>Readable</th><th>Writable</th><th>Version</th></tr></thead><tbody>{entries.map(([name, status]) => <tr key={name}><td>{name}</td><td>{status.backend}</td><td>{status.readable ? "yes" : "no"}</td><td>{status.writable ? "yes" : "no"}</td><td>{status.version}</td></tr>)}</tbody></table></div> : <p className="empty-state">Refresh diagnostics to view repository health for memory/json/blobs backends.</p>}
  </section>;
};

type Props = {
  connection: McpConnection;
  client: McpClient;
  token: string;
  onModeChange: (mode: ConnectionMode) => void;
  onEndpointChange: (endpoint: string) => void;
  onTokenChange: (token: string) => void;
  onConnectionSuccess: (result: InitializeResult) => void;
  onConnectionError: (error: unknown) => void;
  session: { email?: string } | null;
  onLogout: () => void;
  isDeployedMode: boolean;
  workspace: ReturnType<typeof useWorkspace>;
  modelUsage: ReturnType<typeof useModelUsage>;
  activeRunId?: string;
  theme: ReturnType<typeof useTheme>;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

export function SettingsPage({ connection, client, token, onModeChange, onEndpointChange, onTokenChange, onConnectionSuccess, onConnectionError, session, onLogout, isDeployedMode, workspace, modelUsage, activeRunId, theme, onStatus, onError }: Props) {
  const exportWorkspace = async () => {
    try {
      await workspace.exportWorkspace();
      onStatus({ tone: "success", message: "Workspace exported from MCP." });
    } catch (error) {
      onError(error);
    }
  };
  const refreshRepositoryHealth = async () => {
    try {
      await workspace.loadRepositoryHealth();
      onStatus({ tone: "success", message: "Repository diagnostics refreshed." });
    } catch (error) {
      onError(error);
    }
  };
  const validateArticleBody = async (articleBody: unknown) => {
    try {
      const result = await workspace.validateArticleBody(articleBody);
      onStatus({ tone: result.valid ? "success" : "error", message: result.valid ? "Article body is valid." : "Article body has validation issues." });
    } catch (error) {
      onError(error);
    }
  };

  return <section className="tab-panel" aria-label="Settings">
    <section className="panel settings-connection" aria-label="Connection settings">
      <div className="panel-heading"><div><h2>Connection</h2><p className="muted">Choose how the workspace talks to the MCP server. Tokens are redacted from errors and never rendered.</p></div>{isDeployedMode && session?.email && <div className="session-card"><span>Signed in as <strong>{session.email}</strong></span><button onClick={onLogout}>Log out</button></div>}</div>
      <ConnectionPanel connection={connection} client={client} token={token} onModeChange={onModeChange} onEndpointChange={onEndpointChange} onTokenChange={onTokenChange} onConnectionSuccess={onConnectionSuccess} onConnectionError={onConnectionError} />
    </section>

    <AppearanceSettings preference={theme.preference} resolvedMode={theme.resolvedMode} onModeChange={theme.setMode} onAccentChange={theme.setAccent} />

    <section className="support-grid">
      <section className="panel"><div className="panel-heading"><div><h2>Workspace exchange</h2><p className="muted">Export the current MCP workspace document for review or handoff.</p></div><button onClick={exportWorkspace}>Export</button></div><pre>{workspace.exportedWorkspace ? pretty(workspace.exportedWorkspace) : "Export the workspace to view the current MCP document."}</pre></section>
      <RepositoryDiagnostics health={workspace.repositoryHealth} onRefresh={refreshRepositoryHealth} />
      <section className="panel"><h2>article_body schema</h2><p className="muted">Reference schema used by validation and article body checks.</p><SchemaViewer schema={workspace.articleSchema} emptyMessage="Load the workspace to fetch article_body.get_schema." /></section>
    </section>
    <Validator articleSchema={workspace.articleSchema} articleJson={workspace.articleJson} articleFormData={workspace.articleFormData} validation={workspace.validation} onArticleJsonChange={workspace.setArticleJson} onArticleFormDataChange={workspace.setArticleFormData} onValidateArticleBody={validateArticleBody} onJsonParseError={() => onStatus({ tone: "error", message: "JSON input is not valid JSON." })} />
    <UsagePanel summary={modelUsage.summary} budgetStatus={modelUsage.budgetStatus} budgetUsd={modelUsage.budgetUsd} recordCount={modelUsage.records.length} loading={modelUsage.loading} activeRunId={activeRunId} onBudgetUsdChange={modelUsage.setBudgetUsd} onRefresh={() => void modelUsage.refreshUsage().catch(onError)} />
  </section>;
}
