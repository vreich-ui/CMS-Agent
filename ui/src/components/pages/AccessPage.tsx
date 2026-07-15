import { useEffect, useMemo, useState } from "react";
import { PermissionToggle } from "../PermissionToggle";
import { buildToolRows, nextToolPolicies, permissionMeta, summarizePermissions } from "../../toolPermissions";
import type { McpClient } from "../../mcp/client";
import type { ProjectSummary, ProjectToolsResult, ToolPermission } from "../../types/workspace";
import type { StatusMessage } from "../../status";

type Props = {
  client: McpClient;
  projects: ProjectSummary[] | null;
  projectsError: string | null;
  onRefreshProjects: () => void;
  selectedProjectId: string | null;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

type Policy = { defaultToolPolicy: ToolPermission; toolPolicies: Record<string, ToolPermission> };

// Per-tool permission management for a registered project connection. Each remote tool toggles between
// allowed / needs approval / blocked; changes persist via project.update and take effect immediately
// in project.call_tool (the backend enforces the same three states).
export function AccessPage({ client, projects, projectsError, onRefreshProjects, selectedProjectId, onStatus, onError }: Props) {
  const registered = useMemo(() => projects ?? [], [projects]);
  const [projectId, setProjectId] = useState<string | null>(null);

  // Default the picker to the header-selected project (or the first registered one) once the list loads.
  useEffect(() => {
    if (projectId && registered.some((project) => project.projectId === projectId)) return;
    const preferred = registered.find((project) => project.projectId === selectedProjectId) ?? registered[0];
    setProjectId(preferred?.projectId ?? null);
  }, [registered, selectedProjectId, projectId]);

  const summary = registered.find((project) => project.projectId === projectId) ?? null;

  // Policy is seeded from the summary when the project changes, then kept locally authoritative so a
  // toggle reflects instantly; saves refresh it from the server's response.
  const [policy, setPolicy] = useState<Policy>({ defaultToolPolicy: "blocked", toolPolicies: {} });
  useEffect(() => {
    const project = registered.find((entry) => entry.projectId === projectId);
    if (project) setPolicy({ defaultToolPolicy: project.defaultToolPolicy, toolPolicies: project.toolPolicies });
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- reseed only on project switch

  const [tools, setTools] = useState<ProjectToolsResult | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  useEffect(() => {
    if (!projectId) { setTools(null); return; }
    let cancelled = false;
    setToolsLoading(true);
    client.call<ProjectToolsResult>("project.list_tools", { projectId })
      .then((result) => { if (!cancelled) setTools(result); })
      .catch(() => { if (!cancelled) setTools(null); })
      .finally(() => { if (!cancelled) setToolsLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, client]);

  const [saving, setSaving] = useState<string | null>(null);

  const rows = summary ? buildToolRows({ ...summary, ...policy }, tools) : [];
  const counts = summarizePermissions(rows);
  const connectionReady = Boolean(tools?.ok);

  const persist = async (patch: Partial<Policy>, label: string, optimistic: Policy) => {
    if (!summary) return;
    setSaving(label);
    setPolicy(optimistic);
    try {
      const result = await client.call<{ project: ProjectSummary }>("project.update", { projectId: summary.projectId, patch });
      setPolicy({ defaultToolPolicy: result.project.defaultToolPolicy, toolPolicies: result.project.toolPolicies });
      onRefreshProjects();
    } catch (error) {
      // Roll back the optimistic change so the UI never claims a permission the server rejected.
      setPolicy({ defaultToolPolicy: summary.defaultToolPolicy, toolPolicies: summary.toolPolicies });
      onError(error);
    } finally {
      setSaving(null);
    }
  };

  const setToolPermission = (toolName: string, permission: ToolPermission) => {
    const toolPolicies = nextToolPolicies(policy, toolName, permission);
    void persist({ toolPolicies }, toolName, { ...policy, toolPolicies }).then(() =>
      onStatus({ tone: "success", message: `${toolName} → ${permissionMeta[permission].label}${summary ? ` for ${summary.name}` : ""}.` }));
  };

  const setDefaultPermission = (permission: ToolPermission) => {
    void persist({ defaultToolPolicy: permission }, "__default__", { ...policy, defaultToolPolicy: permission }).then(() =>
      onStatus({ tone: "success", message: `Default for unlisted tools → ${permissionMeta[permission].label}.` }));
  };

  return <section className="tab-panel" aria-label="Access">
    <section className="panel access-panel">
      <div className="panel-heading">
        <div>
          <h2>Tool access</h2>
          <p className="muted">Per-tool permissions for a project's MCP server. Each tool is <strong>Allowed</strong>, <strong>Needs approval</strong>, or <strong>Blocked</strong> — enforced by <code>project.call_tool</code>.</p>
        </div>
        <button onClick={onRefreshProjects}>Refresh</button>
      </div>

      {projectsError && <div className="status error" role="status">{projectsError}</div>}

      <div className="access-controls">
        <label>
          Project
          <select value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value || null)} disabled={registered.length === 0}>
            {registered.length === 0 && <option value="">No registered projects</option>}
            {registered.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
          </select>
        </label>
        {summary && <p className="access-legend">
          <span className="permission-chip permission-chip--allow">{permissionMeta.allowed.icon === "check" ? "✓" : ""} {counts.allowed} allowed</span>
          <span className="permission-chip permission-chip--ask">{counts.needs_approval} need approval</span>
          <span className="permission-chip permission-chip--deny">{counts.blocked} blocked</span>
        </p>}
      </div>

      {summary && <div className="access-default">
        <div className="access-default-text">
          <strong>Default for unlisted tools</strong>
          <span className="muted">Applies to any tool without its own setting{connectionReady ? "" : " (including tools not shown while the connection is unconfigured)"}.</span>
        </div>
        <PermissionToggle value={policy.defaultToolPolicy} onChange={setDefaultPermission} disabled={saving !== null} idBase="access-default" />
      </div>}

      {!connectionReady && summary && !toolsLoading && <p className="muted" role="status">
        Showing tools with explicit settings only — {summary.connection.mcpEndpointEnvVar} / {summary.connection.tokenEnvVar ?? "token"} is not configured, so the live tool list from {summary.name} is unavailable.
      </p>}

      {toolsLoading && <p className="muted" aria-live="polite">Loading tools…</p>}

      {summary && rows.length > 0 && <ul className="access-tools">
        {rows.map((row) => <li key={row.name} className="access-tool-row">
          <div className="access-tool-info">
            <code className="access-tool-name">{row.name}</code>
            {row.description && <span className="access-tool-desc">{row.description}</span>}
            {row.explicit && <span className="access-tool-badge" title="Overrides the client-wide default">override</span>}
          </div>
          <PermissionToggle value={row.permission} onChange={(permission) => setToolPermission(row.name, permission)} disabled={saving === row.name} idBase={`access-${row.name}`} />
        </li>)}
      </ul>}

      {summary && rows.length === 0 && !toolsLoading && <p className="empty-state">No tools to show for {summary.name} yet.</p>}
      {!summary && registered.length === 0 && <p className="empty-state">No registered project connections. Register one, then set its tool permissions here.</p>}
    </section>
  </section>;
}
