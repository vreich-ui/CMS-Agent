import { useEffect, useState } from "react";
import { SchemaViewer } from "./SchemaViewer";
import { useClientContract } from "../hooks/useClientContract";
import { useNodeInspector } from "../hooks/useNodeInspector";
import {
  buildNodePatch,
  buildNodeToolRows,
  classifyWriteFailure,
  draftChanges,
  draftFromNode,
  formatFetchedAt,
  groupToolRowsByCategory,
  identityLayer,
  INSPECTOR_TABS,
  MIN_REASON_LENGTH,
  mutationArgsFor,
  nodeWarnings,
  parseSchemaDraft,
  promptComposition,
  runControlsEnabled,
  saveBlockers,
  SCHEMA_DRAFT_FIELDS,
  summarizeSkillPolicy,
  summarizeToolRows,
  type InspectorTab,
  type NodeDraft,
  type ToolRow,
  type WriteFailure
} from "../nodeInspector";
import type { McpClient } from "../mcp/client";
import type { RJSFSchema } from "@rjsf/utils";
import type { ProjectSummary, WorkspaceNode } from "../types/workspace";

// S4 node inspector (CHANGE-PLAN R-11). Read surface plus the write path, which ships only now that
// R-4 gives conflicts a typed envelope: before that, a failed save could not distinguish "someone
// else edited this" from "the server broke", and a UI that cannot tell those apart has no honest
// recovery to offer.
//
// Three rules the write path holds to, all of them because the change ledger is only as good as
// what the editor insists on:
//   1. A reason is mandatory. With agents doing most of the editing, "why" is the only thing a human
//      reviewing the ledger later can act on.
//   2. Nothing is written until the operator has seen a field-level diff of what will change.
//   3. A version conflict is never retried silently — it reports the version someone else landed on
//      and makes reloading an explicit choice.
//
// The component stays thin: every decision it renders is computed in ui/src/nodeInspector.ts and
// tested by the root vitest suite.

type Props = {
  node: WorkspaceNode;
  client: McpClient;
  project: ProjectSummary | null;
  workspaceVersion?: number;
  onClose: () => void;
  // Called after a successful write so the canvas and node list refetch rather than showing stale
  // config next to a node the operator just changed.
  onSaved?: () => void | Promise<void>;
  onReloadWorkspace?: () => void | Promise<void>;
};

const TAB_LABELS: Record<InspectorTab, string> = {
  prompt: "Prompt",
  tools: "Tools",
  skills: "Skills",
  overview: "Overview",
  schemas: "Schemas"
};

const stateLabel = (row: ToolRow): string => (row.state === "allowed" ? "allowed" : row.state === "denied" ? "denied" : "unknown tool");

const toggle = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];

export function NodeInspector({ node, client, project, workspaceVersion, onClose, onSaved, onReloadWorkspace }: Props) {
  const [tab, setTab] = useState<InspectorTab>("prompt");
  const { effectivePrompt, effectiveTools, skillPolicy, skills, loading, errors, fetchedAt, reload } = useNodeInspector(client, node.id);
  const contract = useClientContract(client, project?.projectId ?? null);

  const [draft, setDraft] = useState<NodeDraft>(() => draftFromNode(node));
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // A new node — or the same node reloaded after a save — resets the draft. Keeping a stale draft
  // across a node switch would let an edit intended for one node land on another.
  useEffect(() => {
    setDraft(draftFromNode(node));
    setReason("");
    setConfirming(false);
    setFailure(null);
    setSaved(null);
  }, [node.id, node.updatedAt]);

  const identity = identityLayer(project, { fetchedAt: contract.fetchedAt, error: contract.error });
  const rows = buildNodeToolRows({ allowedTools: draft.allowedTools }, effectiveTools ?? []);
  const storedRows = buildNodeToolRows(node, effectiveTools ?? []);
  const toolTotals = summarizeToolRows(storedRows);
  const skillSummary = summarizeSkillPolicy(skillPolicy);
  const composition = promptComposition(effectivePrompt, node);
  const warnings = nodeWarnings(node, skillPolicy, storedRows);

  const changes = draftChanges(node, draft);
  const blockers = saveBlockers(node, draft, reason, workspaceVersion);

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const summary = `S4 inspector: ${changes.map((change) => change.label.toLowerCase()).join(", ")}`;
      await client.call("workspace.update_node", {
        id: node.id,
        patch: buildNodePatch(node, draft),
        ...mutationArgsFor(reason, summary, workspaceVersion!)
      });
      setSaved(`Saved: ${changes.map((change) => change.label.toLowerCase()).join(", ")}.`);
      setConfirming(false);
      setReason("");
      await onSaved?.();
      await reload();
    } catch (error) {
      setFailure(classifyWriteFailure(error));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

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

    <div className="node-inspector-layers" role="group" aria-label="Resolution layers">
      <span className="badge" title="Stored on the node.">Method · stored</span>
      <span className="badge" title={`Resolved by the workspace. ${formatFetchedAt(fetchedAt)}.`}>Effective · {formatFetchedAt(fetchedAt)}</span>
      <span
        className={`badge node-inspector-identity node-inspector-identity--${identity.state}`}
        title={identity.state === "live" ? `${identity.message} ${formatFetchedAt(identity.fetchedAt)}.` : identity.message}
      >
        Identity · {identity.state === "live" ? formatFetchedAt(identity.fetchedAt) : identity.state.replace("_", " ")}
      </span>
      {workspaceVersion !== undefined && <span className="badge" title="Every save is guarded against this version.">v{workspaceVersion}</span>}
    </div>

    {identity.state !== "live" && <p className="node-inspector-identity-note muted">
      {identity.message} Run controls are disabled until the client contract can be fetched.
      {"detail" in identity && identity.detail ? <> <span className="muted">({identity.detail})</span></> : null}
    </p>}

    {errors.length > 0 && <ul className="node-inspector-errors" aria-label="Inspector load errors">
      {errors.map((error) => <li key={error}>{error}</li>)}
    </ul>}

    {/* A conflict is a recoverable outcome with a named target, not a generic failure. */}
    {failure && <div className={`node-inspector-failure node-inspector-failure--${failure.kind}`} role="alert">
      <p><strong>{failure.code}</strong> — {failure.message}</p>
      <p>{failure.recovery}</p>
      {failure.currentVersion !== undefined && <p className="muted">Current workspace version: v{failure.currentVersion}{failure.currentRevisionId ? ` (${failure.currentRevisionId})` : ""}.</p>}
      {failure.kind === "conflict" && onReloadWorkspace && <button onClick={() => void onReloadWorkspace()}>Reload workspace</button>}
    </div>}

    {saved && <p className="node-inspector-saved" role="status">{saved}</p>}

    <nav className="node-inspector-tabs" aria-label="Node inspector sections">
      {INSPECTOR_TABS.map((id) => <button
        key={id}
        className={id === tab ? "node-inspector-tab node-inspector-tab--active" : "node-inspector-tab"}
        aria-pressed={id === tab}
        onClick={() => setTab(id)}
      >
        {TAB_LABELS[id]}
        {id === "tools" && toolTotals.denied > 0 ? <span className="badge node-inspector-tab-badge">{toolTotals.denied}</span> : null}
        {id === "skills" && skillSummary.hasBlocker ? <span className="badge node-inspector-tab-badge node-inspector-tab-badge--blocker">blocker</span> : null}
      </button>)}
    </nav>

    {tab === "prompt" && <div className="node-inspector-panel" aria-label="Prompt">
      {composition.injectedFromSkills
        ? <p className="node-inspector-note">An assigned skill appends instructions to this prompt. The node's own text below is only part of what runs.</p>
        : <p className="muted">No skill instructions are injected — the stored prompt is what runs.</p>}
      {composition.unexplainedDrift && <p className="node-inspector-note node-inspector-note--warning">
        The effective prompt differs from the stored prompt and no skill explains the difference.
      </p>}

      <label className="node-inspector-field">
        <span>Own prompt <span className="muted">(Method · editable)</span></span>
        <textarea
          className="node-inspector-prompt-input"
          rows={16}
          value={draft.prompt}
          onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
        />
      </label>

      <h4>Injected skill instructions <span className="muted">(Effective · read-only)</span></h4>
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
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Grant ${row.toolId}`}
                      checked={row.own}
                      onChange={() => setDraft((current) => ({ ...current, allowedTools: toggle(current.allowedTools, row.toolId) }))}
                    />
                  </td>
                  <td>{stateLabel(row)}</td>
                  <td>{row.denialReasons.length ? row.denialReasons.join(", ") : "—"}</td>
                </tr>)}
              </tbody>
            </table>
          </div>)}
    </div>}

    {tab === "skills" && <div className="node-inspector-panel" aria-label="Skills">
      <h4>Assigned skills</h4>
      {skills === null
        ? <p className="empty-state">The skill registry could not be loaded, so assignment is unavailable. Refresh to retry.</p>
        : <ul className="node-inspector-skill-list">
            {skills.map((skill) => <li key={skill.skillId}>
              <label>
                <input
                  type="checkbox"
                  checked={draft.assignedSkills.includes(skill.skillId)}
                  onChange={() => setDraft((current) => ({ ...current, assignedSkills: toggle(current.assignedSkills, skill.skillId) }))}
                />
                <code>{skill.skillId}</code> <span className="muted">{skill.name}</span>
              </label>
            </li>)}
          </ul>}

      <h4>Conflicts</h4>
      {skillPolicy === null
        ? <p className="empty-state">The skill policy could not be resolved, so conflicts are unknown — not clean.</p>
        : skillSummary.conflicts.length === 0
          ? <p className="muted">No conflicts reported.</p>
          : <ul className="node-inspector-conflicts">
              {skillSummary.conflicts.map((conflict, index) => <li key={`${conflict.source}-${index}`} className={`node-inspector-conflict node-inspector-conflict--${conflict.severity}`}>
                <span className="badge">{conflict.severity}</span> <code>{conflict.source}</code> {conflict.message}
              </li>)}
            </ul>}

      <h4>Resolved tools</h4>
      <dl className="design-rail-facts">
        <dt>Effective</dt><dd>{skillSummary.effectiveTools.join(", ") || "—"}</dd>
        <dt>Requested</dt><dd>{skillSummary.requestedTools.join(", ") || "—"}</dd>
        <dt>Denied</dt><dd>{skillSummary.deniedTools.join(", ") || "—"}</dd>
      </dl>

      <h4>Skill instructions</h4>
      <pre className="node-inspector-prompt">{skillSummary.instructions || "None."}</pre>
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
      {SCHEMA_DRAFT_FIELDS.map((field) => {
        const parsed = parseSchemaDraft(draft[field]);
        const label = field === "inputSchema" ? "Input schema" : "Output schema";
        return <div key={field} className="node-inspector-schema-editor">
          <h4>{label}</h4>
          <label className="node-inspector-field">
            <span className="muted">JSON Schema — an object, or <code>true</code>/<code>false</code></span>
            <textarea
              aria-label={`${label} JSON`}
              className={parsed.ok ? undefined : "node-inspector-textarea--invalid"}
              rows={12}
              spellCheck={false}
              value={draft[field]}
              onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
            />
          </label>
          {/* The parse verdict is shown while typing rather than saved for the blocker list, so the
              operator sees which brace they dropped at the moment they drop it. */}
          {parsed.ok
            ? <p className="muted">Valid JSON Schema.</p>
            : <p className="node-inspector-schema-error" role="status">{label} {parsed.error}.</p>}
        </div>;
      })}

      <h4>Deprecated <code>schema</code> alias</h4>
      <SchemaViewer schema={node.schema as RJSFSchema | undefined} emptyMessage="Not set." />
      <p className="muted">Derived, not edited: saving the output schema writes this alias in lockstep, exactly as <code>workspace.update_node_output_schema</code> does, so it can never trail a stale copy.</p>
    </div>}

    {/* The save bar is always visible, so an edit made on one tab is never lost by switching to
        another and it is always obvious that changes are pending. */}
    <footer className="node-inspector-save" role="group" aria-label="Save changes">
      {changes.length === 0
        ? <p className="muted">No pending changes.</p>
        : <>
            <h4>{changes.length} pending change{changes.length === 1 ? "" : "s"}</h4>
            <ul className="node-inspector-diff">
              {changes.map((change) => <li key={change.field}>
                <strong>{change.label}</strong>: <span className="node-inspector-diff-before">{change.before}</span> → <span className="node-inspector-diff-after">{change.after}</span>
              </li>)}
            </ul>
          </>}

      <label className="node-inspector-field">
        <span>Reason <span className="muted">(required — this is what a human reviewing the change ledger reads)</span></span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={`At least ${MIN_REASON_LENGTH} characters`}
        />
      </label>

      {blockers.length > 0 && changes.length > 0 && <ul className="node-inspector-blockers">
        {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
      </ul>}

      {confirming
        ? <div className="node-inspector-confirm">
            <p><strong>Apply these {changes.length} change{changes.length === 1 ? "" : "s"} to <code>{node.id}</code>?</strong> The write is guarded against workspace v{workspaceVersion}.</p>
            <button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Confirm save"}</button>
            <button className="link-button" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        : <div className="node-inspector-save-actions">
            <button disabled={blockers.length > 0 || saving} onClick={() => setConfirming(true)}>Review and save</button>
            <button className="link-button" disabled={changes.length === 0 || saving} onClick={() => { setDraft(draftFromNode(node)); setFailure(null); }}>Discard changes</button>
          </div>}
    </footer>
  </section>;
}
