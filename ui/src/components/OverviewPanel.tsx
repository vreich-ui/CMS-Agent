import { buildAttentionItems, summarizeNodes, summarizeRuns } from "../overview";
import type { AttentionItem, OverviewTargetTab } from "../overview";
import { useOverview } from "../hooks/useOverview";
import type { McpConfig, ProjectSummary } from "../types/workspace";

type Props = {
  config: McpConfig;
  onNavigate: (tab: OverviewTargetTab) => void;
};

const usd = (value: number) => `$${value.toFixed(6)}`;
const integer = (value: number) => value.toLocaleString();
const bucketEntries = (bucket: Record<string, number>) => Object.entries(bucket).filter(([, total]) => total > 0);

function AttentionList({ items, onNavigate }: { items: AttentionItem[]; onNavigate: Props["onNavigate"] }) {
  if (!items.length) return <p className="empty-state">Nothing needs attention. Approvals, failures, and configuration gaps will appear here first.</p>;
  return <ul className="attention-list">
    {items.map((item) => <li key={item.id} className={`attention-item attention-${item.severity}`}>
      <div>
        <strong>{item.title}</strong>
        <p className="muted">{item.detail}</p>
      </div>
      {item.targetTab && <button type="button" className="link-button" onClick={() => onNavigate(item.targetTab!)}>Open {item.targetTab}</button>}
    </li>)}
  </ul>;
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  return <li className="overview-project">
    <div className="overview-project-heading">
      <strong>{project.name}</strong>
      <span className={`execution-pill ${project.status === "active" ? "execution-completed" : "execution-cancelled"}`}>{project.status}</span>
    </div>
    <p className="muted">Contract {project.contentContract.contentContract} · body {project.contentContract.canonicalArticleBody} · publishing {project.publishingPolicy.publishEnabled ? "enabled" : "disabled"}</p>
    <p className="muted">Endpoint {project.connection.endpointConfigured ? "configured" : "not configured"} ({project.connection.mcpEndpointEnvVar}){project.connection.tokenEnvVar ? ` · token ${project.connection.tokenConfigured ? "configured" : "not configured"}` : ""}</p>
  </li>;
}

export function OverviewPanel({ config, onNavigate }: Props) {
  const { data, errors, loading, loadedAt, refresh } = useOverview(config);
  const attention = buildAttentionItems({ runs: data.runs ?? [], projects: data.projects ?? [], repositoryHealth: data.repositoryHealth });
  const runOverview = data.runs ? summarizeRuns(data.runs) : null;
  const nodeOverview = data.nodes ? summarizeNodes(data.nodes) : null;
  const nothingLoaded = !data.nodes && !data.runs && !data.usageSummary && !data.projects && !data.repositoryHealth;

  return <section className="tab-panel" aria-label="Overview">
    <section className="panel" aria-label="Needs attention">
      <div className="panel-heading">
        <div><h2>Needs attention</h2><p className="muted">Approvals, failures, and configuration gaps come first; everything else is summarized below.</p></div>
        <button onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      {nothingLoaded && errors.length > 0
        ? <p className="empty-state">The overview could not load workspace data. Check the MCP endpoint and token, then refresh.</p>
        : <AttentionList items={attention} onNavigate={onNavigate} />}
      {!nothingLoaded && errors.length > 0 && <p className="warning-text">Some sections did not load: {errors.join(" · ")}</p>}
      {loadedAt && <p className="muted overview-loaded-at">Last refreshed {loadedAt}</p>}
    </section>

    <section className="overview-grid">
      <section className="panel" aria-label="Runs summary">
        <div className="panel-heading"><h2>Runs</h2><button type="button" className="link-button" onClick={() => onNavigate("builder")}>Open builder</button></div>
        {runOverview ? <>
          <div className="overview-stats">
            <div><span>Total dry-runs</span><strong>{integer(runOverview.total)}</strong></div>
            {bucketEntries(runOverview.byStatus).map(([status, total]) => <div key={status}><span className={`execution-pill execution-${status}`}>{status}</span><strong>{integer(total)}</strong></div>)}
          </div>
          {runOverview.recent.length
            ? <ul className="compact-list">{runOverview.recent.map((run) => <li key={run.runId}><span className={`execution-pill execution-${run.status}`}>{run.status}</span> <code>{run.runId}</code> · {run.projectId} · updated {run.updatedAt}</li>)}</ul>
            : <p className="empty-state">No dry-runs yet. Start one from Builder.</p>}
        </> : <p className="empty-state">Run history has not loaded.</p>}
      </section>

      <section className="panel" aria-label="Constellation summary">
        <div className="panel-heading"><h2>Constellation</h2><button type="button" className="link-button" onClick={() => onNavigate("nodes")}>Open nodes</button></div>
        {nodeOverview ? <>
          <div className="overview-stats">
            <div><span>Nodes</span><strong>{integer(nodeOverview.total)}</strong></div>
            {bucketEntries(nodeOverview.byStatus).map(([status, total]) => <div key={status}><span>{status}</span><strong>{integer(total)}</strong></div>)}
            {bucketEntries(nodeOverview.byRisk).map(([risk, total]) => <div key={risk}><span>{risk} risk</span><strong>{integer(total)}</strong></div>)}
          </div>
          {nodeOverview.publishRiskNodeIds.length > 0 && <p className="muted">Publish-risk nodes ({nodeOverview.publishRiskNodeIds.join(", ")}) stay dry/approval-only.</p>}
          {nodeOverview.lastUpdatedAt && <p className="muted">Last node update {nodeOverview.lastUpdatedAt}</p>}
        </> : <p className="empty-state">Workspace nodes have not loaded.</p>}
      </section>

      <section className="panel" aria-label="Usage summary">
        <div className="panel-heading"><h2>Usage estimates</h2><button type="button" className="link-button" onClick={() => onNavigate("support")}>Open support</button></div>
        {data.usageSummary ? <div className="overview-stats">
          <div><span>Total tokens</span><strong>{integer(data.usageSummary.totalTokens)}</strong></div>
          <div><span>Estimated cost</span><strong>{usd(data.usageSummary.totalCostUsdEstimate)}</strong></div>
          <div><span>Records</span><strong>{integer(data.usageSummary.recordCount)}</strong></div>
        </div> : <p className="empty-state">Usage estimates have not loaded.</p>}
        <p className="muted">Estimates only; not billing-grade.</p>
      </section>

      <section className="panel" aria-label="Project connections">
        <h2>Projects</h2>
        {data.projects ? (data.projects.length
          ? <ul className="compact-list">{data.projects.map((project) => <ProjectRow key={project.projectId} project={project} />)}</ul>
          : <p className="empty-state">No project connections registered.</p>)
          : <p className="empty-state">Project connections have not loaded.</p>}
      </section>

      <section className="panel" aria-label="Storage health">
        <div className="panel-heading"><h2>Storage</h2><button type="button" className="link-button" onClick={() => onNavigate("support")}>Open support</button></div>
        {data.repositoryHealth ? <div className="overview-stats">
          <div><span>Backend</span><strong>{data.repositoryHealth.backend}</strong></div>
          <div><span>Health</span><strong>{data.repositoryHealth.storageHealth}</strong></div>
          <div><span>Workspace version</span><strong>{integer(data.repositoryHealth.workspaceVersion)}</strong></div>
        </div> : <p className="empty-state">Storage health has not loaded.</p>}
      </section>
    </section>
  </section>;
}
