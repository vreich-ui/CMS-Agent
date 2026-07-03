import { useEffect, useMemo, useState } from "react";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { Inspector } from "./components/Inspector";
import { SchemaViewer } from "./components/SchemaViewer";
import { Validator } from "./components/Validator";
import { WorkspaceGraph } from "./components/WorkspaceGraph";
import { getErrorMessage } from "./hooks/useConnection";
import { getAccessScreen } from "./accessState";
import { useIdentitySession } from "./hooks/useIdentitySession";
import { useWorkspace } from "./hooks/useWorkspace";
import type { InitializeResult, McpConfig } from "./types/workspace";

const TOKEN_KEY = "cms-agent.mcpToken";
const DEPLOYED_ENDPOINT = "/api/workspace-mcp";
const LOCAL_ENDPOINT = "/api/mcp";
const isDeployedMode = !import.meta.env.DEV;
const DEFAULT_ENDPOINT = isDeployedMode ? DEPLOYED_ENDPOINT : LOCAL_ENDPOINT;

type Status = { tone: "info" | "success" | "error"; message: string } | null;

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function App() {
  const { session, login, logout } = useIdentitySession(isDeployedMode);
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [token, setToken] = useState(() => isDeployedMode ? "" : localStorage.getItem(TOKEN_KEY) ?? "");
  const [status, setStatus] = useState<Status>(null);
  const usingSecureProxy = endpoint === DEPLOYED_ENDPOINT;
  const config = useMemo<McpConfig>(() => ({ endpoint, token: usingSecureProxy ? undefined : token, authToken: usingSecureProxy ? session.accessToken : undefined, requiresToken: !usingSecureProxy }), [endpoint, session.accessToken, token, usingSecureProxy]);
  const workspace = useWorkspace(config);
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

  const validateArticleBody = async (articleBody: unknown) => {
    try {
      const result = await workspace.validateArticleBody(articleBody);
      setStatus({ tone: result.valid ? "success" : "error", message: result.valid ? "Article body is valid." : "Article body has validation issues." });
    } catch (error) {
      handleError(error);
    }
  };


  if (accessScreen.kind === "checking") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>{accessScreen.detail}</p></section></main>;

  if (accessScreen.kind === "verifying") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>{accessScreen.detail}</p></section></main>;

  if (accessScreen.kind === "login") return <main className="app-shell"><section className="access-card"><p className="eyebrow">{accessScreen.eyebrow}</p><h1>{accessScreen.title}</h1>{accessScreen.error && <div className="status error" role="status">{accessScreen.error}</div>}<button onClick={login}>{accessScreen.button}</button></section></main>;

  if (accessScreen.kind === "unauthorized") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>The signed-in account is not allowlisted for this workspace.</p>{accessScreen.email && <p>Signed in as <strong>{accessScreen.email}</strong>.</p>}{accessScreen.error && <div className="status error" role="status">{accessScreen.error}</div>}<button onClick={logout}>Log out</button></section></main>;

  return <main className="app-shell">
    <header className="hero">
      <div><p className="eyebrow">CMS-Agent</p><h1>Workspace UI</h1><p>Visualize and edit workspace state through the MCP server. The MCP server remains the source of truth.</p></div>
      <div className="header-stack">{isDeployedMode && <div className="session-card"><span>Signed in as <strong>{session.email}</strong></span><button onClick={logout}>Log out</button></div>}<ConnectionPanel endpoint={endpoint} token={token} onEndpointChange={setEndpoint} onTokenChange={setToken} onConnectionSuccess={handleConnectionSuccess} onConnectionError={handleError} showTokenField={!usingSecureProxy} /></div>
    </header>

    {status && <div className={`status ${status.tone}`} role="status">{status.message}</div>}

    <section className="workspace-grid">
      <section className="panel graph-panel" aria-label="Workspace graph">
        <div className="panel-heading"><h2>Workspace graph</h2><div className="auth-actions"><button onClick={loadWorkspace}>Load workspace</button><button onClick={exportWorkspace}>Export Workspace</button></div></div>
        <WorkspaceGraph nodes={workspace.nodes} selectedNodeId={workspace.selectedId} onSelectNode={workspace.setSelectedId} />
      </section>

      <Inspector selectedNode={workspace.selectedNode} promptDraft={workspace.promptDraft} workspaceVersion={workspace.workspaceVersion} selectedSchema={workspace.selectedSchema} onPromptDraftChange={workspace.setPromptDraft} onSavePrompt={savePrompt} />
    </section>

    <section className="lower-grid">
      <section className="panel"><h2>Selected node schema form</h2>{workspace.selectedSchema ? <Form schema={workspace.selectedSchema} validator={validator} onSubmit={() => setStatus({ tone: "info", message: "Schema form data is visual only and is not saved." })} /> : <p>No selected node schema to render.</p>}</section>
      <section className="panel"><h2>article_body schema</h2><SchemaViewer schema={workspace.articleSchema} emptyMessage="Load the workspace to fetch article_body.get_schema." /></section>
      <Validator articleSchema={workspace.articleSchema} articleJson={workspace.articleJson} articleFormData={workspace.articleFormData} validation={workspace.validation} onArticleJsonChange={workspace.setArticleJson} onArticleFormDataChange={workspace.setArticleFormData} onValidateArticleBody={validateArticleBody} onJsonParseError={() => setStatus({ tone: "error", message: "JSON input is not valid JSON." })} />
      <section className="panel"><h2>Workspace export</h2><pre>{workspace.exportedWorkspace ? pretty(workspace.exportedWorkspace) : "Click Export Workspace to view the current MCP workspace document."}</pre></section>
    </section>
  </main>;
}

export default App;
