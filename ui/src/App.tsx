import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { OverviewPanel } from "./components/OverviewPanel";
import { ConstellationPage } from "./components/pages/ConstellationPage";
import { RunsPage } from "./components/pages/RunsPage";
import { AgentsPage } from "./components/pages/AgentsPage";
import { ChangesPage } from "./components/pages/ChangesPage";
import { AccessPage } from "./components/pages/AccessPage";
import { SettingsPage } from "./components/pages/SettingsPage";
import { getErrorMessage } from "./hooks/useConnection";
import { getAccessScreen } from "./accessState";
import { useIdentitySession } from "./hooks/useIdentitySession";
import { useMcpClient } from "./hooks/useMcpClient";
import { useRoute } from "./hooks/useRoute";
import { useTheme } from "./hooks/useTheme";
import { useProjects } from "./hooks/useProjects";
import { useWorkspace } from "./hooks/useWorkspace";
import { useWorkflowRun } from "./hooks/useWorkflowRun";
import { useModelUsage } from "./hooks/useModelUsage";
import type { McpConnection } from "./connection";
import { distinctRunProjectIds } from "./projects";
import { readStorage, writeStorage } from "./storage";
import type { StatusMessage } from "./status";
import type { InitializeResult } from "./types/workspace";

const TOKEN_KEY = "cms-agent.mcpToken";
const PROJECT_KEY = "cms-agent.projectId";
const isDeployedMode = !import.meta.env.DEV;
// Cloud Run is the sole control plane. Its endpoint is configured at build time and used as the
// default; the Settings connection panel keeps it editable (free text) for local dev or a staging
// Cloud Run service.
const CLOUD_RUN_MCP_URL = (import.meta.env.VITE_CLOUD_RUN_MCP_URL as string | undefined)?.trim() || "";

function App() {
  const { session, login, logout } = useIdentitySession(isDeployedMode);
  const [endpoint, setEndpoint] = useState(CLOUD_RUN_MCP_URL);
  const [token, setToken] = useState(() => isDeployedMode ? "" : readStorage(TOKEN_KEY) ?? "");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const connection = useMemo<McpConnection>(() => ({ endpoint, token }), [endpoint, token]);
  const client = useMcpClient(connection);

  const { route, navigate } = useRoute();
  const theme = useTheme();
  const projects = useProjects(client);
  // Project selection is a UI preference: it scopes runs/usage and seeds run creation, never
  // becomes workspace state, and never changes the current route.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => readStorage(PROJECT_KEY) || null);
  const selectProject = (projectId: string | null) => {
    setSelectedProjectId(projectId);
    writeStorage(PROJECT_KEY, projectId);
  };

  const workspace = useWorkspace(client);
  const workflowRun = useWorkflowRun(client);
  const modelUsage = useModelUsage(client, workflowRun.currentRun?.runId, workflowRun.currentRun?.projectId ?? selectedProjectId);
  const accessScreen = getAccessScreen(isDeployedMode, session);
  const runProjectIds = useMemo(() => distinctRunProjectIds(workflowRun.runs), [workflowRun.runs]);

  useEffect(() => {
    if (!isDeployedMode) writeStorage(TOKEN_KEY, token);
  }, [token]);

  const handleError = (error: unknown) => {
    setStatus({ tone: "error", message: getErrorMessage(error) });
  };

  const handleConnectionSuccess = (result: InitializeResult) => {
    setStatus({ tone: "success", message: `Connected to ${result.serverInfo?.name ?? "MCP server"} using protocol ${result.protocolVersion ?? "unknown"}.` });
  };

  if (accessScreen.kind === "checking") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>{accessScreen.detail}</p></section></main>;

  if (accessScreen.kind === "verifying") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>{accessScreen.detail}</p></section></main>;

  if (accessScreen.kind === "login") return <main className="app-shell"><section className="access-card"><p className="eyebrow">{accessScreen.eyebrow}</p><h1>{accessScreen.title}</h1>{accessScreen.error && <div className="status error" role="status">{accessScreen.error}</div>}<button onClick={login}>{accessScreen.button}</button></section></main>;

  if (accessScreen.kind === "unauthorized") return <main className="app-shell"><section className="access-card"><p className="eyebrow">CMS-Agent</p><h1>{accessScreen.title}</h1><p>The signed-in account is not allowlisted for this workspace.</p>{accessScreen.email && <p>Signed in as <strong>{accessScreen.email}</strong>.</p>}{accessScreen.error && <div className="status error" role="status">{accessScreen.error}</div>}<button onClick={logout}>Log out</button></section></main>;

  return <div className="app-shell">
    <AppHeader route={route} onNavigate={navigate} projects={projects.projects} projectsError={projects.error} onRetryProjects={() => void projects.refresh()} runProjectIds={runProjectIds} selectedProjectId={selectedProjectId} onSelectProject={selectProject} connection={connection} />

    {status && <div className={`status ${status.tone}`} role="status">{status.message}</div>}

    <main className="app-main">
      {route.page === "overview" && <OverviewPanel client={client} projectId={selectedProjectId} onNavigate={navigate} />}
      {route.page === "constellation" && <ConstellationPage legacy={route.legacy} mode={route.mode} onNavigate={navigate} selectedProjectId={selectedProjectId} projects={projects.projects} client={client} workspace={workspace} workflowRun={workflowRun} refreshUsage={modelUsage.refreshUsage} onStatus={setStatus} onError={handleError} />}
      {route.page === "agents" && <AgentsPage client={client} onStatus={setStatus} onError={handleError} />}
      {route.page === "runs" && <RunsPage selectedProjectId={selectedProjectId} onNavigate={navigate} />}
      {route.page === "changes" && <ChangesPage client={client} selectedProjectId={selectedProjectId} onStatus={setStatus} onError={handleError} />}
      {route.page === "access" && <AccessPage client={client} projects={projects.projects} projectsError={projects.error} onRefreshProjects={() => void projects.refresh()} selectedProjectId={selectedProjectId} onStatus={setStatus} onError={handleError} />}
      {route.page === "settings" && <SettingsPage connection={connection} client={client} token={token} onEndpointChange={setEndpoint} onTokenChange={setToken} onConnectionSuccess={handleConnectionSuccess} onConnectionError={handleError} session={isDeployedMode ? session : null} onLogout={logout} isDeployedMode={isDeployedMode} workspace={workspace} modelUsage={modelUsage} activeRunId={workflowRun.currentRun?.runId} theme={theme} onStatus={setStatus} onError={handleError} />}
    </main>
  </div>;
}

export default App;
