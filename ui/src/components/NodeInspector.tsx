import { useState } from "react";
import { SchemaViewer } from "./SchemaViewer";
import { useClientContract } from "../hooks/useClientContract";
import { useNodeInspector } from "../hooks/useNodeInspector";
import {
  buildNodeToolRows,
  formatFetchedAt,
  groupToolRowsByCategory,
  identityLayer,
  INSPECTOR_TABS,
  nodeWarnings,
  promptComposition,
  runControlsEnabled,
  summarizeSkillPolicy,
  summarizeToolRows,
  type InspectorTab,
  type ToolRow
} from "../nodeInspector";
import type { McpClient } from "../mcp/client";
import type { RJSFSchema } from "@rjsf/utils";
import type { ProjectSummary, WorkspaceNode } from "../types/workspace";

// S4 node inspector — read-only (CHANGE-PLAN R-11). The write path ships only after R-4 gives us a
// typed version-conflict envelope; until then this screen answers questions, it does not take
// actions. Nothing here calls a mutating tool, and there is deliberately no save affordance to
// mistake for one.
//
// This component is intentionally thin: every decision it renders — which tools resolve, whether a
// skill injected instructions, whether the client contract counts as live — is computed in
// ui/src/nodeInspector.ts and tested by root vitest.

type Props = {
  node: WorkspaceNode;
  client: McpClient;
  project: ProjectSummary | null;
  onClose: () => void;
};

const TAB_LABELS: Record<InspectorTab, string> = {
  prompt: "Prompt",
  tools: "Tools",
  skills: "Skills",
  overview: "Overview",
  schemas: "Schemas"
};

const stateLabel = (row: ToolRow): string => (row.state === "allowed" ? "allowed" : row.state === "denied" ? "denied" : "unknown tool");

export function NodeInspector({ node, client, project, onClose }: Props) {
  const [tab, setTab] = useState<InspectorTab>("prompt");
  const { effectivePrompt, effectiveTools, skillPolicy, loading, errors, fetchedAt, reload } = useNodeInspector(client, node.id);
  const contract = useClientContract(client, project?.projectId ?? null);

  const identity = identityLayer(project, { fetchedAt: contract.fetchedAt, error: contract.error });
  const rows = buildNodeToolRows(node, effectiveTools ?? []);
  const toolTotals = summarizeToolRows(rows);
  const skills = summarizeSkillPolicy(skillPolicy);
  const composition = promptComposition(effectivePrompt, node);
  const warnings = nodeWarnings(node, skillPolicy, rows);

  return <section className="node-inspector" aria-label={`Node inspector: ${node.name}`}>
    <header className="node-inspector-header">
      <div>
        <h3>{node.name}</h3>
        <p className="muted"><code>{node.id}</code> · {node.kind ?? "unknown"} · <span className={`risk-badge risk-badge--${node.riskLevel ?? "read"}`}>{node.riskLevel ?? "read"}</span></p>
      </div>
      <div className="node-inspector-header-actions">
        <button onClick={() => void reload()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        <button className="link-button" onClick={onClose}>Close</button>
      </div>
    </header>

    {/* The three layers, named, so nobody has to guess whether a value is stored or resolved. */}
    <div className="node-inspector-layers" role="group" aria-label="Resolution layers">
      <span className="badge" title="Stored on the node.">Method · stored</span>
      <span className="badge" title={`Resolved by the workspace. ${formatFetchedAt(fetchedAt)}.`}>Effective · {formatFetchedAt(fetchedAt)}</span>
      <span
        className={`badge node-inspector-identity node-inspector-identity--${identity.state}`}
        title={identity.state === "live" ? `${identity.message} ${formatFetchedAt(identity.fetchedAt)}.` : identity.message}
      >
        Identity · {identity.state === "live" ? formatFetchedAt(identity.fetchedAt) : identity.state.replace("_", " ")}
      </span>
    </div>

    {identity.state !== "live" && <p className="node-inspector-identity-note muted">
      {identity.message} Run controls are disabled until the client contract can be fetched.
      {"detail" in identity && identity.detail ? <> <span className="muted">({identity.detail})</span></> : null}
    </p>}

    {errors.length > 0 && <ul className="node-inspector-errors" aria-label="Inspector load errors">
      {errors.map((error) => <li key={error}>{error}</li>)}
    </ul>}

    <nav className="node-inspector-tabs" aria-label="Node inspector sections">
      {INSPECTOR_TABS.map((id) => <button
        key={id}
        className={id === tab ? "node-inspector-tab node-inspector-tab--active" : "node-inspector-tab"}
        aria-pressed={id === tab}
        onClick={() => setTab(id)}
      >
        {TAB_LABELS[id]}
        {id === "tools" && toolTotals.denied > 0 ? <span className="badge node-inspector-tab-badge">{toolTotals.denied}</span> : null}
        {id === "skills" && skills.hasBlocker ? <span className="badge node-inspector-tab-badge node-inspector-tab-badge--blocker">blocker</span> : null}
      </button>)}
    </nav>

    {tab === "prompt" && <div className="node-inspector-panel" aria-label="Prompt">
      {composition.injectedFromSkills
        ? <p className="node-inspector-note">An assigned skill appends instructions to this prompt. The node's own text below is only part of what runs.</p>
        : <p className="muted">No skill instructions are injected — the stored prompt is what runs.</p>}
      {composition.unexplainedDrift && <p className="node-inspector-note node-inspector-note--warning">
        The effective prompt differs from the stored prompt and no skill explains the difference.
      </p>}

      <h4>Own prompt <span className="muted">(Method · stored)</span></h4>
      <pre className="node-inspector-prompt">{composition.ownPrompt || "No prompt stored."}</pre>

      <h4>Injected skill instructions <span className="muted">(Effective)</span></h4>
      <pre className="node-inspector-prompt">{composition.skillInstructions || "None."}</pre>

      <h4>Effective prompt <span className="muted">(Effective · what actually runs)</span></h4>
      <pre className="node-inspector-prompt">{composition.effectivePrompt || "Unavailable."}</pre>
    </div>}

    {tab === "tools" && <div className="node-inspector-panel" aria-label="Tools">
      <p className="muted">{toolTotals.own} requested by this node · {toolTotals.allowed} allowed by the resolver · {toolTotals.denied} requested but denied.</p>
      {effectiveTools === null
        ? <p className="empty-state">Effective tools could not be resolved, so own-vs-effective cannot be shown. Refresh to retry.</p>
        : groupToolRowsByCategory(rows).map((group) => <div key={group.category} className="node-inspector-tool-group">
            <h4>{group.category}</h4>
            <table className="node-inspector-tools">
              <thead><tr><th scope="col">Tool</th><th scope="col">Own</th><th scope="col">Effective</th><th scope="col">Why</th></tr></thead>
              <tbody>
                {group.rows.map((row) => <tr key={row.toolId} className={row.own && row.state !== "allowed" ? "node-inspector-tool-row--denied" : undefined}>
                  <th scope="row"><code>{row.name}</code> <span className={`risk-badge risk-badge--${row.riskLevel}`}>{row.riskLevel}</span></th>
                  <td>{row.own ? "✓" : "·"}</td>
                  <td>{stateLabel(row)}</td>
                  <td>{row.denialReasons.length ? row.denialReasons.join(", ") : "—"}</td>
                </tr>)}
              </tbody>
            </table>
          </div>)}
    </div>}

    {tab === "skills" && <div className="node-inspector-panel" aria-label="Skills">
      <p className="muted">Assigned: {node.assignedSkills?.length ? node.assignedSkills.join(", ") : "none"}. Resolved: {skills.skillIds.length ? skills.skillIds.join(", ") : "none"}.</p>

      <h4>Conflicts</h4>
      {skillPolicy === null
        ? <p className="empty-state">The skill policy could not be resolved, so conflicts are unknown — not clean.</p>
        : skills.conflicts.length === 0
          ? <p className="muted">No conflicts reported.</p>
          : <ul className="node-inspector-conflicts">
              {skills.conflicts.map((conflict, index) => <li key={`${conflict.source}-${index}`} className={`node-inspector-conflict node-inspector-conflict--${conflict.severity}`}>
                <span className="badge">{conflict.severity}</span> <code>{conflict.source}</code> {conflict.message}
              </li>)}
            </ul>}

      <h4>Resolved tools</h4>
      <dl className="design-rail-facts">
        <dt>Effective</dt><dd>{skills.effectiveTools.join(", ") || "—"}</dd>
        <dt>Requested</dt><dd>{skills.requestedTools.join(", ") || "—"}</dd>
        <dt>Denied</dt><dd>{skills.deniedTools.join(", ") || "—"}</dd>
      </dl>

      <h4>Skill instructions</h4>
      <pre className="node-inspector-prompt">{skills.instructions || "None."}</pre>
    </div>}

    {tab === "overview" && <div className="node-inspector-panel" aria-label="Overview">
      <dl className="design-rail-facts">
        <dt>Id</dt><dd><code>{node.id}</code></dd>
        <dt>Kind</dt><dd>{node.kind ?? "unknown"}</dd>
        <dt>Status</dt><dd>{node.status ?? "unknown"}</dd>
        <dt>Risk</dt><dd><span className={`risk-badge risk-badge--${node.riskLevel ?? "read"}`}>{node.riskLevel ?? "read"}</span></dd>
        <dt>Depends on</dt><dd>{node.dependsOn?.join(", ") || "—"}</dd>
        <dt>Required inputs</dt><dd>{node.requiredInputs?.join(", ") || "—"}</dd>
        <dt>Produces</dt><dd>{node.produces?.join(", ") || "—"}</dd>
        <dt>Updated</dt><dd>{node.updatedAt ?? "unknown"}</dd>
      </dl>

      <h4>Consistency</h4>
      {warnings.length === 0
        ? <p className="muted">No inconsistencies detected between stored config and resolved policy.</p>
        : <ul className="node-inspector-warnings">
            {warnings.map((warning) => <li key={warning.key} className={`node-inspector-warning node-inspector-warning--${warning.severity}`}>
              <span className="badge">{warning.severity}</span> {warning.message}
            </li>)}
          </ul>}

      <h4>Metadata</h4>
      <pre className="node-inspector-prompt">{node.metadata ? JSON.stringify(node.metadata, null, 2) : "None."}</pre>

      <h4>Run controls</h4>
      <p className="muted">
        {runControlsEnabled(identity)
          ? "The client contract is live. Run controls arrive with S5 Operate."
          : "Disabled — the client contract is not live, and this workspace does not execute against a guess."}
      </p>
    </div>}

    {tab === "schemas" && <div className="node-inspector-panel" aria-label="Schemas">
      <h4>Input schema</h4>
      <SchemaViewer schema={node.inputSchema as RJSFSchema | undefined} emptyMessage="No input schema stored." />

      <h4>Output schema</h4>
      <SchemaViewer schema={node.outputSchema as RJSFSchema | undefined} emptyMessage="No output schema stored." />

      <h4>Deprecated <code>schema</code> alias</h4>
      <SchemaViewer schema={node.schema as RJSFSchema | undefined} emptyMessage="Not set." />
    </div>}
  </section>;
}
