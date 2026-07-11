import { useEffect, useMemo, useState } from "react";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { OverviewPanel } from "./components/OverviewPanel";
import { Inspector } from "./components/Inspector";
import { SchemaViewer } from "./components/SchemaViewer";
import { Validator } from "./components/Validator";
import { WorkspaceGraph } from "./components/WorkspaceGraph";
import { WorkflowControls } from "./components/WorkflowControls";
import { RunStatusPanel } from "./components/RunStatusPanel";
import { NodeExecutionList } from "./components/NodeExecutionList";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { UsagePanel } from "./components/UsagePanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { NodeConsole } from "./components/NodeConsole";
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
type WorkspaceTab = "overview" | "builder" | "nodes" | "support";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string; helper: string }> = [
  { id: "overview", label: "Overview", helper: "See what needs attention across runs, nodes, projects, and storage." },
  { id: "builder", label: "Builder", helper: "Compose and dry-run the primary content workflow." },
  { id: "nodes", label: "Nodes", helper: "Review prompts, schemas, content blocks, and stage outputs." },
  { id: "support", label: "Support", helper: "Use diagnostics, validation, usage, and workspace exchange tools." }
];

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const repositoryNames = ["workspace", "execution", "artifact", "learning", "usage", "skill"] as const;

const RepositoryDiagnostics = ({ health, onRefresh }: { health: ReturnType<typeof useWorkspace>["repositoryHealth"]; onRefresh: () => void }) => {
  const entries = health ? repositoryNames.map((name) => [name, health[name]] as const) : [];
  return <section className="panel">
    <div className="panel-heading"><div><h2>Repository diagnostics</h2><p className="muted">Safe repository health metadata only. Storage paths and secrets are not displayed.</p></div><button onClick={onRefresh}>Refresh</button></div>
    {health && <div className="diagnostic-summary" aria-label="Storage summary"><span><strong>Repository backend</strong>{health.backend}</span><span><strong>Storage health</strong>{health.storageHealth}</span><span><strong>Workspace version</strong>{health.workspaceVersion}</span></div>}
    {entries.length ? <div className="table-wrap"><table><thead><tr><th>Repository</th><th>Backend</th><th>Readable</th><th>Writable</th><th>Version</th></tr></thead><tbody>{entries.map(([name, status]) => <tr key={name}><td>{name}</td><td>{status.backend}</td><td>{status.readable ? "yes" : "no"}</td><td>{status.writable ? "yes" : "no"}</td><td>{status.version}</td></tr>)}</tbody></table></div> : <p className="empty-state">Refresh diagnostics to view repository health for memory/json/blobs backends.</p>}
  </section>;
};

function App() {
  const { session, login, logout } = useIdentitySession(isDeployedMode);
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [token, setToken] = useState(() => isDeployedMode ? "" : localStorage.getItem(TOKEN_KEY) ?? "");
  const [status, setStatus] = useState<Status>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
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

  const createNode = async () => { try { const result = await workspace.createNode(); setStatus({ tone: "success", message: `Created node ${result.node.name}.` }); } catch (error) { handleError(error); } };
  const cloneNode = async () => { try { const result = await workspace.cloneNode(); if (result) setStatus({ tone: "success", message: `Cloned node ${result.node.name}.` }); } catch (error) { handleError(error); } };
  const deleteNode = async () => { try { await workspace.deleteNode(); setStatus({ tone: "success", message: "Deleted node." }); } catch (error) { handleError(error); } };
  const updateNodePatch = async (patch: Parameters<typeof workspace.updateNodePatch>[0], summary: string) => { try { await workspace.updateNodePatch(patch, summary); setStatus({ tone: "success", message: "Saved node configuration." }); } catch (error) { handleError(error); } };
  const updateOutputSchema = async (schema: unknown) => { try { await workspace.updateOutputSchema(schema); setStatus({ tone: "success", message: "Saved output schema." }); } catch (error) { handleError(error); } };
  const moveSelected = async (direction: -1 | 1) => { if (!workspace.selectedId) return; const ids = workspace.nodes.map((node) => node.id); const index = ids.indexOf(workspace.selectedId); const next = index + direction; if (index < 0 || next < 0 || next >= ids.length) return; [ids[index], ids[next]] = [ids[next], ids[index]]; try { await workspace.reorderNodes(ids); setStatus({ tone: "success", message: "Saved graph order without changing dependencies." }); } catch (error) { handleError(error); } };
  const validateGraph = async () => { try { const result = await workspace.validateGraph(); setStatus({ tone: result.validation.valid ? "success" : "error", message: result.validation.valid ? "Graph is valid." : `Graph issues: ${result.validation.issues.join("; ")}` }); } catch (error) { handleError(error); } };
  const loadSkills = async () => { try { const skills = await workspace.loadSkills(); setStatus({ tone: "success", message: `Loaded ${skills.length} skills.` }); } catch (error) { handleError(error); } };
  const assignSkill = async () => { try { await workspace.assignSkill(); setStatus({ tone: "success", message: "Assigned skill to node." }); } catch (error) { handleError(error); } };
  const unassignSkill = async () => { try { await workspace.unassignSkill(); setStatus({ tone: "success", message: "Unassigned skill from node." }); } catch (error) { handleError(error); } };
  const resolveSkillPolicy = async () => { try { await workspace.resolveSkillPolicy(); setStatus({ tone: "success", message: "Resolved effective skill policy." }); } catch (error) { handleError(error); } };

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

    {activeTab === "overview" && <OverviewPanel config={config} onNavigate={setActiveTab} />}

    {activeTab === "builder" && <section className="tab-panel" aria-label="Builder workspace">
      <section className="workspace-grid">
        <section className="panel graph-panel" aria-label="Workspace graph">
          <div className="panel-heading"><div><h2>Builder map</h2><p className="muted">Select a node, reorder it, validate edges, and save graph changes through MCP.</p></div><div className="auth-actions"><button onClick={loadWorkspace}>Load workspace</button><button onClick={() => moveSelected(-1)}>Move up</button><button onClick={() => moveSelected(1)}>Move down</button><button onClick={validateGraph}>Validate graph</button></div></div>
          <WorkspaceGraph nodes={workspace.nodes} selectedNodeId={workspace.selectedId} onSelectNode={workspace.setSelectedId} executionStatusByNodeId={workflowRun.nodeStatusById} />
        </section>
        <WorkflowControls currentRun={workflowRun.currentRun} runs={workflowRun.runs} selectedRunId={workflowRun.selectedRunId} loading={workflowRun.loading} onStartDryRun={(projectId, input, mode) => workflowAction(() => workflowRun.startDryRun(projectId, input, mode), (run) => `Started ${run.executionMode ?? "mock"} run ${run.runId}.`)} onRunNextNode={() => workflowAction(workflowRun.runNextNode, (run) => run?.status === "blocked" ? "Run blocked before publish-risk execution." : `Advanced run to ${run?.currentNodeId ?? run?.status ?? "next state"}.`, async () => modelUsage.refreshUsage())} onRunUntil={(nodeId) => workflowAction(() => workflowRun.runUntil(nodeId), (run) => `Ran until ${nodeId}: ${run?.status ?? "unknown"}.`, async () => modelUsage.refreshUsage())} onRunAll={() => workflowAction(workflowRun.runAll, (run) => `Run all stopped at ${run?.currentNodeId ?? run?.status ?? "next state"}.`, async () => modelUsage.refreshUsage())} onPauseRun={() => workflowAction(workflowRun.pauseRun, (run) => `Paused ${run?.runId ?? "run"}.`)} onResumeRun={() => workflowAction(workflowRun.resumeRun, (run) => `Resumed ${run?.runId ?? "run"}.`)} onCancelRun={() => workflowAction(workflowRun.cancelRun, (run) => `Cancelled ${run?.runId ?? "run"}.`)} onRetryNode={(nodeId) => workflowAction(() => workflowRun.retryNode(nodeId), (run) => `Retried node; run is ${run?.status ?? "unknown"}.`, async () => modelUsage.refreshUsage())} onResetRun={() => workflowAction(workflowRun.resetRun, (run) => `Reset dry-run ${run?.runId ?? "run"}.`)} onRefreshRun={() => workflowAction(workflowRun.refreshRun, (run) => `Refreshed dry-run ${run?.runId ?? "run"}.`)} onListRuns={(projectId) => workflowAction(() => workflowRun.listRuns(projectId), (runs) => `Loaded ${runs.length} dry-run${runs.length === 1 ? "" : "s"}.`)} onLoadRun={(runId) => workflowAction(() => workflowRun.loadRun(runId), (run) => `Loaded dry-run ${run?.runId ?? runId}.`)} />
      </section>
      <section className="execution-grid builder-status-grid">
        <RunStatusPanel run={workflowRun.currentRun} />
        <NodeExecutionList run={workflowRun.currentRun} />
      </section>
    </section>}

    {activeTab === "nodes" && <section className="tab-panel" aria-label="Nodes workspace">
      <section className="workspace-grid">
        <SkillsPanel skills={workspace.skills} nodes={workspace.nodes} selectedSkillId={workspace.selectedSkillId} selectedNodeId={workspace.selectedId} resolvedPolicy={workspace.resolvedSkillPolicy} onSelectSkill={workspace.setSelectedSkillId} onSelectNode={workspace.setSelectedId} onRefresh={loadSkills} onAssign={assignSkill} onUnassign={unassignSkill} onResolve={resolveSkillPolicy} />
        <Inspector selectedNode={workspace.selectedNode} promptDraft={workspace.promptDraft} workspaceVersion={workspace.workspaceVersion} selectedSchema={workspace.selectedSchema} onPromptDraftChange={workspace.setPromptDraft} onSavePrompt={savePrompt} onCreateNode={createNode} onCloneNode={cloneNode} onDeleteNode={deleteNode} onUpdateNodePatch={updateNodePatch} onUpdateOutputSchema={updateOutputSchema} />
        <section className="panel"><h2>Selected node form</h2><p className="muted">Preview the selected node schema. Submitting here is visual only.</p>{workspace.selectedSchema ? <Form schema={workspace.selectedSchema} validator={validator} onSubmit={() => setStatus({ tone: "info", message: "Schema form data is visual only and is not saved." })} /> : <p className="empty-state">Select a node with a schema to preview its form.</p>}</section>
      </section>
      <NodeConsole config={config} nodes={workspace.nodes} selectedNodeId={workspace.selectedId} onSelectNode={workspace.setSelectedId} onError={handleError} onStatus={(message) => setStatus({ tone: "success", message })} />
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
