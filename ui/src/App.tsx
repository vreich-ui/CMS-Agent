import { useEffect, useMemo, useState } from "react";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { Inspector } from "./components/Inspector";
import { SchemaViewer } from "./components/SchemaViewer";
import { Validator } from "./components/Validator";
import { WorkspaceGraph } from "./components/WorkspaceGraph";
import { WorkflowControls } from "./components/WorkflowControls";
import { RunStatusPanel } from "./components/RunStatusPanel";
import { NodeExecutionList } from "./components/NodeExecutionList";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { UsagePanel } from "./components/UsagePanel";
import { getErrorMessage } from "./hooks/useConnection";
import { getAccessScreen } from "./accessState";
import { useIdentitySession } from "./hooks/useIdentitySession";
import { useWorkspace } from "./hooks/useWorkspace";
import { useWorkflowRun } from "./hooks/useWorkflowRun";
import { useModelUsage } from "./hooks/useModelUsage";
import type { InitializeResult, McpConfig } from "./types/workspace";

const TOKEN_KEY = "cms-agent.mcpToken";
const DEPLOYED_ENDPOINT = "/api/workspace-mcp";
const LOCAL_ENDPOINT = "/api/mcp";
const isDeployedMode = !import.meta.env.DEV;
const DEFAULT_ENDPOINT = isDeployedMode ? DEPLOYED_ENDPOINT : LOCAL_ENDPOINT;

type Status = { tone: "info" | "success" | "error"; message: string } | null;
type WorkspaceTab = "builder" | "nodes" | "support";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string; helper: string }> = [
  { id: "builder", label: "Builder", helper: "Compose and dry-run the primary content workflow." },
  { id: "nodes", label: "Nodes", helper: "Review prompts, schemas, content blocks, and stage outputs." },
  { id: "support", label: "Support", helper: "Use diagnostics, validation, usage, and workspace exchange tools." }
];

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const RepositoryDiagnostics = ({ health, onRefresh }: { health: ReturnType<typeof useWorkspace>["repositoryHealth"]; onRefresh: () => void }) => {
  const entries = health ? Object.entries(health) : [];
  return <section className="panel">
    <div className="panel-heading"><div><h2>Repository diagnostics</h2><p className="muted">Safe repository health metadata only. Storage paths and secrets are not displayed.</p></div><button onClick={onRefresh}>Refresh</button></div>
    {entries.length ? <div className="table-wrap"><table><thead><tr><th>Repository</th><th>Backend</th><th>Readable</th><th>Writable</th><th>Version</th></tr></thead><tbody>{entries.map(([name, status]) => <tr key={name}><td>{name}</td><td>{status.backend}</td><td>{status.readable ? "yes" : "no"}</td><td>{status.writable ? "yes" : "no"}</td><td>{status.version}</td></tr>)}</tbody></table></div> : <p className="empty-state">Refresh diagnostics to view repository health.</p>}
  </section>;
};

function App() {
  const { session, login, logout } = useIdentitySession(isDeployedMode);
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [token, setToken] = useState(() => isDeployedMode ? "" : localStorage.getItem(TOKEN_KEY) ?? "");
  const [status, setStatus] = useState<Status>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("builder");
  const usingSecureProxy = endpoint === DEPLOYED_ENDPOINT;
  const config = useMemo<McpConfig>(() => ({ endpoint, token: usingSecureProxy ? undefined : token, authToken: usingSecureProxy ? session.accessToken : undefined, requiresToken: !usingSecureProxy }), [endpoint, session.accessToken, token, usingSecureProxy]);
  const workspace = useWorkspace(config);
  const workflowRun = useWorkflowRun(config);
  const modelUsage = useModelUsage(config, workflowRun.currentRun?.runId, workflowRun.currentRun?.projectId);
  const accessScreen = getAccessScreen(isDeployedMode, session);

  useEffect(() => {
    if (!isDeployedMode) localStorage.setItem(TOKEN_KEY, token);
  }, [token]);

  const handleError = (error: unknown) => {
    setStatus({ tone: "error", message: getErrorMessage(error) });
  };

  const handleConnectionSuccess = (result: InitializeResult) => {
    setStatus({ tone: "success", message: `Connected to ${result.serverInfo?.name ?? "MCP server"} using protocol ${result.protocolVersion ?? "unknown"}.` });
  };

  const loadWorkspace = async () => {
    try {
      await workspace.loadWorkspace();
      setStatus({ tone: "success", message: "Workspace loaded from MCP." });
    } catch (error) {
      handleError(error);
    }
  };

  const savePrompt = async () => {
    try {
      const result = await workspace.savePrompt();
      if (result) setStatus({ tone: "success", message: `Saved prompt for ${result.node.name}.` });
    } catch (error) {
      handleError(error);
    }
  };

  const exportWorkspace = async () => {
    try {
      await workspace.exportWorkspace();
      setStatus({ tone: "success", message: "Workspace exported from MCP." });
    } catch (error) {
      handleError(error);
    }
  };

  const refreshRepositoryHealth = async () => {
    try {
      await workspace.loadRepositoryHealth();
      setStatus({ tone: "success", message: "Repository diagnostics refreshed." });
    } catch (error) {
      handleError(error);
    }
  };

  const validateArticleBody = async (articleBody: unknown) => {
    try {
      const result = await workspace.validateArticleBody(articleBody);
      setStatus({ tone: result.valid ? "success" : "error", message: result.valid ? "Article body is valid." : "Article body has validation issues." });
    } catch (error) {
      handleError(error);
    }
  };

  const workflowAction = async <T,>(operation: () => Promise<T>, successMessage: (result: T) => string, afterSuccess?: (result: T) => Promise<void>) => {
    try {
      const result = await operation();
      if (afterSuccess) await afterSuccess(result);
      setStatus({ tone: "success", message: successMessage(result) });
      return result;
    } catch (error) {
      handleError(error);
      throw error;
    }
  };


  if (accessScreen.kind === "checking") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>{accessScreen.detail}</p></section></main>;

  if (accessScreen.kind === "verifying") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>{accessScreen.detail}</p></section></main>;

  if (accessScreen.kind === "login") return <main className="app-shell"><section className="access-card"><p className="eyebrow">{accessScreen.eyebrow}</p><h1>{accessScreen.title}</h1>{accessScreen.error && <div className="status error" role="status">{accessScreen.error}</div>}<button onClick={login}>{accessScreen.button}</button></section></main>;

  if (accessScreen.kind === "unauthorized") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>The signed-in account is not allowlisted for this workspace.</p>{accessScreen.email && <p>Signed in as <strong>{accessScreen.email}</strong>.</p>}{accessScreen.error && <div className="status error" role="status">{accessScreen.error}</div>}<button onClick={logout}>Log out</button></section></main>;

  return <main className="app-shell">
    <header className="hero">
      <div><p className="eyebrow">CMS-Agent</p><h1>Workspace</h1><p>Build, inspect, and validate content workflows from one MCP-backed workspace.</p></div>
      <div className="header-stack">{isDeployedMode && <div className="session-card"><span>Signed in as <strong>{session.email}</strong></span><button onClick={logout}>Log out</button></div>}<ConnectionPanel endpoint={endpoint} token={token} onEndpointChange={setEndpoint} onTokenChange={setToken} onConnectionSuccess={handleConnectionSuccess} onConnectionError={handleError} showTokenField={!usingSecureProxy} /></div>
    </header>

    {status && <div className={`status ${status.tone}`} role="status">{status.message}</div>}

    <nav className="workspace-tabs" aria-label="Workspace sections">
      {workspaceTabs.map((tab) => <button key={tab.id} type="button" className={`workspace-tab ${activeTab === tab.id ? "active" : ""}`} aria-pressed={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}><span>{tab.label}</span><small>{tab.helper}</small></button>)}
    </nav>

    {activeTab === "builder" && <section className="tab-panel" aria-label="Builder workspace">
      <section className="workspace-grid">
        <section className="panel graph-panel" aria-label="Workspace graph">
          <div className="panel-heading"><div><h2>Builder map</h2><p className="muted">Select a node, then run or inspect the dry-run flow.</p></div><div className="auth-actions"><button onClick={loadWorkspace}>Load workspace</button></div></div>
          <WorkspaceGraph nodes={workspace.nodes} selectedNodeId={workspace.selectedId} onSelectNode={workspace.setSelectedId} executionStatusByNodeId={workflowRun.nodeStatusById} />
        </section>
        <WorkflowControls currentRun={workflowRun.currentRun} runs={workflowRun.runs} selectedRunId={workflowRun.selectedRunId} loading={workflowRun.loading} onStartDryRun={(projectId, input) => workflowAction(() => workflowRun.startDryRun(projectId, input), (run) => `Started dry-run ${run.runId}.`)} onRunNextNode={() => workflowAction(workflowRun.runNextNode, (run) => run?.status === "blocked" ? "Dry-run blocked at publication_controller. No publication was performed." : `Advanced dry-run to ${run?.currentNodeId ?? run?.status ?? "next state"}.`, async () => modelUsage.refreshUsage())} onResetRun={() => workflowAction(workflowRun.resetRun, (run) => `Reset dry-run ${run?.runId ?? "run"}.`)} onRefreshRun={() => workflowAction(workflowRun.refreshRun, (run) => `Refreshed dry-run ${run?.runId ?? "run"}.`)} onListRuns={(projectId) => workflowAction(() => workflowRun.listRuns(projectId), (runs) => `Loaded ${runs.length} dry-run${runs.length === 1 ? "" : "s"}.`)} onLoadRun={(runId) => workflowAction(() => workflowRun.loadRun(runId), (run) => `Loaded dry-run ${run?.runId ?? runId}.`)} />
      </section>
      <section className="execution-grid builder-status-grid">
        <RunStatusPanel run={workflowRun.currentRun} />
        <NodeExecutionList run={workflowRun.currentRun} />
      </section>
    </section>}

    {activeTab === "nodes" && <section className="tab-panel" aria-label="Nodes workspace">
      <section className="workspace-grid">
        <Inspector selectedNode={workspace.selectedNode} promptDraft={workspace.promptDraft} workspaceVersion={workspace.workspaceVersion} selectedSchema={workspace.selectedSchema} onPromptDraftChange={workspace.setPromptDraft} onSavePrompt={savePrompt} />
        <section className="panel"><h2>Selected node form</h2><p className="muted">Preview the selected node schema. Submitting here is visual only.</p>{workspace.selectedSchema ? <Form schema={workspace.selectedSchema} validator={validator} onSubmit={() => setStatus({ tone: "info", message: "Schema form data is visual only and is not saved." })} /> : <p className="empty-state">Select a node with a schema to preview its form.</p>}</section>
      </section>
      <ArtifactPanel run={workflowRun.currentRun} />
    </section>}

    {activeTab === "support" && <section className="tab-panel" aria-label="Support workspace">
      <section className="support-grid">
        <section className="panel"><div className="panel-heading"><div><h2>Workspace exchange</h2><p className="muted">Export the current MCP workspace document for review or handoff.</p></div><button onClick={exportWorkspace}>Export</button></div><pre>{workspace.exportedWorkspace ? pretty(workspace.exportedWorkspace) : "Export the workspace to view the current MCP document."}</pre></section>
        <RepositoryDiagnostics health={workspace.repositoryHealth} onRefresh={refreshRepositoryHealth} />
        <section className="panel"><h2>article_body schema</h2><p className="muted">Reference schema used by validation and article body checks.</p><SchemaViewer schema={workspace.articleSchema} emptyMessage="Load the workspace to fetch article_body.get_schema." /></section>
      </section>
      <Validator articleSchema={workspace.articleSchema} articleJson={workspace.articleJson} articleFormData={workspace.articleFormData} validation={workspace.validation} onArticleJsonChange={workspace.setArticleJson} onArticleFormDataChange={workspace.setArticleFormData} onValidateArticleBody={validateArticleBody} onJsonParseError={() => setStatus({ tone: "error", message: "JSON input is not valid JSON." })} />
      <UsagePanel summary={modelUsage.summary} budgetStatus={modelUsage.budgetStatus} budgetUsd={modelUsage.budgetUsd} recordCount={modelUsage.records.length} loading={modelUsage.loading} activeRunId={workflowRun.currentRun?.runId} onBudgetUsdChange={modelUsage.setBudgetUsd} onRefresh={() => void modelUsage.refreshUsage().catch(handleError)} />
    </section>}
  </main>;
}

export default App;
