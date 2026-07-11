import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { OverviewPanel } from "./components/OverviewPanel";
import { ConstellationPage } from "./components/pages/ConstellationPage";
import { RunsPage } from "./components/pages/RunsPage";
import { ChangesPage } from "./components/pages/ChangesPage";
import { SettingsPage } from "./components/pages/SettingsPage";
import { getErrorMessage } from "./hooks/useConnection";
import { getAccessScreen } from "./accessState";
import { getFreshIdentityToken, useIdentitySession } from "./hooks/useIdentitySession";
import { useMcpClient } from "./hooks/useMcpClient";
import { useRoute } from "./hooks/useRoute";
import { useTheme } from "./hooks/useTheme";
import { useProjects } from "./hooks/useProjects";
import { useWorkspace } from "./hooks/useWorkspace";
import { useWorkflowRun } from "./hooks/useWorkflowRun";
import { useModelUsage } from "./hooks/useModelUsage";
import { defaultEndpointForMode } from "./connection";
import type { ConnectionMode, McpConnection } from "./connection";
import { distinctRunProjectIds } from "./projects";
import { readStorage, writeStorage } from "./storage";
import type { StatusMessage } from "./status";
import type { InitializeResult } from "./types/workspace";

const TOKEN_KEY = "cms-agent.mcpToken";
const PROJECT_KEY = "cms-agent.projectId";
const isDeployedMode = !import.meta.env.DEV;
const DEFAULT_MODE: ConnectionMode = isDeployedMode ? "secure-proxy" : "direct";

function App() {
  const { session, login, logout } = useIdentitySession(isDeployedMode);
  const [mode, setMode] = useState<ConnectionMode>(DEFAULT_MODE);
  const [endpoint, setEndpoint] = useState(defaultEndpointForMode(DEFAULT_MODE));
  const [token, setToken] = useState(() => isDeployedMode ? "" : readStorage(TOKEN_KEY) ?? "");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  // Connection mode is explicit state (a discriminated union), never inferred from the endpoint
  // string. Switching modes reconfigures request behavior wholesale: the endpoint resets to that
  // mode's default and the credential source changes with the union variant.
  const connection = useMemo<McpConnection>(() =>
    mode === "secure-proxy"
      ? { mode: "secure-proxy", endpoint, getAccessToken: getFreshIdentityToken }
      : { mode: "direct", endpoint, token },
  [endpoint, mode, token]);
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

  const handleModeChange = (nextMode: ConnectionMode) => {
    setMode(nextMode);
    setEndpoint(defaultEndpointForMode(nextMode));
  };

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
      {route.page === "constellation" && <ConstellationPage legacy={route.legacy} onNavigate={navigate} selectedProjectId={selectedProjectId} client={client} workspace={workspace} workflowRun={workflowRun} refreshUsage={modelUsage.refreshUsage} onStatus={setStatus} onError={handleError} />}
      {route.page === "runs" && <RunsPage selectedProjectId={selectedProjectId} onNavigate={navigate} />}
      {route.page === "changes" && <ChangesPage selectedProjectId={selectedProjectId} onNavigate={navigate} />}
      {route.page === "settings" && <SettingsPage connection={connection} client={client} token={token} onModeChange={handleModeChange} onEndpointChange={setEndpoint} onTokenChange={setToken} onConnectionSuccess={handleConnectionSuccess} onConnectionError={handleError} session={isDeployedMode ? session : null} onLogout={logout} isDeployedMode={isDeployedMode} workspace={workspace} modelUsage={modelUsage} activeRunId={workflowRun.currentRun?.runId} theme={theme} onStatus={setStatus} onError={handleError} />}
    </main>
  </div>;
}

export default App;
