import { LegacyBuilderPanel } from "../legacy/LegacyBuilderPanel";
import { LegacyNodesPanel } from "../legacy/LegacyNodesPanel";
import { formatRoute, type AppRoute, type LegacyPanel } from "../../route";
import type { McpClient } from "../../mcp/client";
import type { useWorkspace } from "../../hooks/useWorkspace";
import type { useWorkflowRun } from "../../hooks/useWorkflowRun";
import type { StatusMessage } from "../../status";

// Transitional Constellation page: the Design/Operate/History canvas arrives in S3+; until then
// the legacy Builder and Nodes workspaces are embedded here so nothing is lost mid-migration.
type Props = {
  legacy?: LegacyPanel;
  onNavigate: (route: AppRoute) => void;
  selectedProjectId: string | null;
  client: McpClient;
  workspace: ReturnType<typeof useWorkspace>;
  workflowRun: ReturnType<typeof useWorkflowRun>;
  refreshUsage: () => Promise<void>;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

const legacyTabs: Array<{ id: LegacyPanel; label: string }> = [
  { id: "builder", label: "Builder (legacy)" },
  { id: "nodes", label: "Nodes (legacy)" }
];

export function ConstellationPage({ legacy, onNavigate, selectedProjectId, client, workspace, workflowRun, refreshUsage, onStatus, onError }: Props) {
  const active = legacy ?? "builder";
  return <section className="tab-panel" aria-label="Constellation">
    <section className="panel constellation-intro">
      <div className="panel-heading">
        <div>
          <h2>Constellation</h2>
          <p className="muted">Design, Operate, and History modes arrive with the editable canvas (S3). The legacy Builder and Nodes workspaces remain available below until then.</p>
        </div>
        <div className="mode-strip" role="group" aria-label="Constellation modes (coming soon)">
          {["Design", "Operate", "History"].map((mode) => <button key={mode} type="button" disabled title="Arrives with the Constellation canvas">{mode}</button>)}
        </div>
      </div>
      {selectedProjectId && <p className="muted"><span className="badge">Workspace-wide</span> The constellation is shared across projects; <code>{selectedProjectId}</code> scopes runs and usage only.</p>}
      <nav className="legacy-subnav" aria-label="Legacy workspaces">
        {legacyTabs.map((tab) => <a key={tab.id} href={formatRoute({ page: "constellation", legacy: tab.id })} aria-current={active === tab.id ? "page" : undefined} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate({ page: "constellation", legacy: tab.id }); } }}>{tab.label}</a>)}
      </nav>
    </section>
    {active === "builder"
      ? <LegacyBuilderPanel workspace={workspace} workflowRun={workflowRun} refreshUsage={refreshUsage} defaultProjectId={selectedProjectId ?? undefined} onStatus={onStatus} onError={onError} />
      : <LegacyNodesPanel client={client} workspace={workspace} workflowRun={workflowRun} onStatus={onStatus} onError={onError} />}
  </section>;
}
