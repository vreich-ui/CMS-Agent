import { LegacyBuilderPanel } from "../legacy/LegacyBuilderPanel";
import { LegacyNodesPanel } from "../legacy/LegacyNodesPanel";
import { ConstellationDesignMode } from "../constellation/ConstellationDesignMode";
import { formatRoute, type AppRoute, type ConstellationMode, type LegacyPanel } from "../../route";
import type { McpClient } from "../../mcp/client";
import type { useWorkspace } from "../../hooks/useWorkspace";
import type { useWorkflowRun } from "../../hooks/useWorkflowRun";
import type { StatusMessage } from "../../status";

// The Design-mode canvas is the default Constellation view (S3). The legacy Builder and Nodes
// workspaces stay reachable via ?legacy= until S5/S4 retire them; Operate and History modes
// arrive in S5/S6.
type Props = {
  legacy?: LegacyPanel;
  mode?: ConstellationMode;
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

const interceptClick = (event: React.MouseEvent, navigate: () => void) => {
  if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    navigate();
  }
};

export function ConstellationPage({ legacy, mode, onNavigate, selectedProjectId, client, workspace, workflowRun, refreshUsage, onStatus, onError }: Props) {
  if (legacy) {
    return <section className="tab-panel" aria-label="Constellation">
      <section className="panel constellation-intro">
        <div className="panel-heading">
          <div>
            <h2>Constellation — legacy workspaces</h2>
            <p className="muted">These workspaces retire as the canvas absorbs their features (S4/S5). The Design canvas is the new default view.</p>
          </div>
        </div>
        <nav className="legacy-subnav" aria-label="Legacy workspaces">
          <a href={formatRoute({ page: "constellation" })} onClick={(event) => interceptClick(event, () => onNavigate({ page: "constellation" }))}>Design canvas</a>
          {legacyTabs.map((tab) => <a key={tab.id} href={formatRoute({ page: "constellation", legacy: tab.id })} aria-current={legacy === tab.id ? "page" : undefined} onClick={(event) => interceptClick(event, () => onNavigate({ page: "constellation", legacy: tab.id }))}>{tab.label}</a>)}
        </nav>
      </section>
      {legacy === "builder"
        ? <LegacyBuilderPanel workspace={workspace} workflowRun={workflowRun} refreshUsage={refreshUsage} defaultProjectId={selectedProjectId ?? undefined} onStatus={onStatus} onError={onError} />
        : <LegacyNodesPanel client={client} workspace={workspace} workflowRun={workflowRun} onStatus={onStatus} onError={onError} />}
    </section>;
  }

  return <section className="tab-panel" aria-label="Constellation">
    <section className="panel constellation-intro">
      <div className="panel-heading">
        <div>
          <h2>Constellation</h2>
          <p className="muted">The shared agent constellation: positions and dependencies are workspace truth, edited here and versioned in the change history.</p>
        </div>
        <div className="mode-strip" role="group" aria-label="Constellation modes">
          <button type="button" aria-pressed="true" onClick={() => onNavigate({ page: "constellation" })}>Design</button>
          <button type="button" disabled title="Arrives in S5">Operate</button>
          <button type="button" disabled title="Arrives in S6">History</button>
        </div>
      </div>
      {mode === "operate" && <p className="muted">Operate mode arrives in S5 — showing Design.</p>}
      {mode === "history" && <p className="muted">History mode arrives in S6 — showing Design.</p>}
      {selectedProjectId && <p className="muted"><span className="badge">Workspace-wide</span> The constellation is shared across projects; <code>{selectedProjectId}</code> scopes runs and usage only.</p>}
      <nav className="legacy-subnav" aria-label="Legacy workspaces">
        {legacyTabs.map((tab) => <a key={tab.id} href={formatRoute({ page: "constellation", legacy: tab.id })} onClick={(event) => interceptClick(event, () => onNavigate({ page: "constellation", legacy: tab.id }))}>{tab.label}</a>)}
      </nav>
    </section>
    <ConstellationDesignMode client={client} workspace={workspace} onStatus={onStatus} onError={onError} />
  </section>;
}
