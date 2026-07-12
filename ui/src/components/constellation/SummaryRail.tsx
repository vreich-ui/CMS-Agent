import { useEffect, useState } from "react";
import type { DesignEdgeModel } from "../../designGraph";
import type { WorkspaceNode } from "../../types/workspace";

type SummaryRailProps = {
  node: WorkspaceNode | null;
  nodes: WorkspaceNode[];
  selectedEdge: DesignEdgeModel | null;
  saving: boolean;
  onAddDependency: (dependencyId: string) => void;
  onRemoveDependency: (dependencyId: string) => void;
  onDeleteNode: () => void;
  onDeleteEdge: (edge: DesignEdgeModel) => void;
  onClearSelection: () => void;
};

const nameFor = (nodes: WorkspaceNode[], id: string) => nodes.find((node) => node.id === id)?.name ?? id;

// The rail is the keyboard/list-based equivalent of every drag-only canvas interaction:
// add/remove dependencies without drawing edges, delete with typed confirmation. It lives in a
// grid column — no absolute positioning, no z-index.
export function SummaryRail({ node, nodes, selectedEdge, saving, onAddDependency, onRemoveDependency, onDeleteNode, onDeleteEdge, onClearSelection }: SummaryRailProps) {
  const [dependencyChoice, setDependencyChoice] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  useEffect(() => {
    setDependencyChoice("");
    setDeleteConfirmation("");
  }, [node?.id]);

  if (selectedEdge) {
    return <aside className="design-rail" aria-label="Selection summary">
      <h3>{selectedEdge.kind} edge</h3>
      <p>{nameFor(nodes, selectedEdge.source)} → {nameFor(nodes, selectedEdge.target)}{selectedEdge.label ? ` (${selectedEdge.label})` : ""}</p>
      {selectedEdge.kind === "execution"
        ? <div className="design-rail-actions">
            <p className="muted">Removing this edge removes the dependency of <strong>{nameFor(nodes, selectedEdge.target)}</strong> on <strong>{nameFor(nodes, selectedEdge.source)}</strong>.</p>
            <button disabled={saving} onClick={() => onDeleteEdge(selectedEdge)}>Remove dependency</button>
          </div>
        : <p className="muted">Stored {selectedEdge.kind} relationships are read-only on the canvas. Editing arrives with the node details modal (S4).</p>}
      <button className="link-button" onClick={onClearSelection}>Clear selection</button>
    </aside>;
  }

  if (!node) {
    return <aside className="design-rail" aria-label="Selection summary">
      <h3>Nothing selected</h3>
      <p className="muted">Select a node on the canvas or in the list below to see its summary and edit its dependencies.</p>
    </aside>;
  }

  const dependsOn = node.dependsOn ?? [];
  const candidates = nodes.filter((candidate) => candidate.id !== node.id && !dependsOn.includes(candidate.id));
  const risk = node.riskLevel ?? "read";

  return <aside className="design-rail" aria-label="Selection summary">
    <h3>{node.name}</h3>
    <dl className="design-rail-facts">
      <dt>Id</dt><dd><code>{node.id}</code></dd>
      <dt>Kind</dt><dd>{node.kind ?? "unknown"}</dd>
      <dt>Status</dt><dd>{node.status ?? "unknown"}</dd>
      <dt>Risk</dt><dd><span className={`risk-badge risk-badge--${risk}`}>{risk}</span></dd>
      <dt>Skills</dt><dd>{node.assignedSkills?.length ?? 0}</dd>
      <dt>Tools</dt><dd>{node.allowedTools?.length ?? 0}</dd>
      {node.updatedAt && <><dt>Updated</dt><dd>{node.updatedAt}</dd></>}
    </dl>

    <section aria-label="Dependencies">
      <h4>Depends on ({dependsOn.length})</h4>
      {dependsOn.length > 0
        ? <ul className="design-rail-deps">{dependsOn.map((dependencyId) => <li key={dependencyId}>
            <span>{nameFor(nodes, dependencyId)}</span>
            <button className="link-button" disabled={saving} onClick={() => onRemoveDependency(dependencyId)}>Remove</button>
          </li>)}</ul>
        : <p className="muted">No dependencies.</p>}
      <label>
        Add dependency
        <select value={dependencyChoice} onChange={(event) => setDependencyChoice(event.target.value)}>
          <option value="">Select a node…</option>
          {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
      </label>
      <button disabled={saving || !dependencyChoice} onClick={() => { onAddDependency(dependencyChoice); setDependencyChoice(""); }}>Add</button>
    </section>

    <button disabled title="Arrives with the node details modal (S4)">Open details (arrives in S4)</button>

    <section aria-label="Delete node" className="design-rail-danger">
      <h4>Delete node</h4>
      <p className="muted">Type <code>{node.id}</code> to confirm. Canonical workspace nodes are refused by the server; this UI does not grant admin removal.</p>
      <label>
        Confirm node id
        <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder={node.id} />
      </label>
      <button disabled={saving || deleteConfirmation !== node.id} onClick={onDeleteNode}>Delete {node.name}</button>
    </section>
  </aside>;
}
