import type { DesignEdgeModel } from "../../designGraph";
import type { WorkspaceNode } from "../../types/workspace";

type SummaryRailProps = {
  nodes: WorkspaceNode[];
  selectedEdge: DesignEdgeModel | null;
  saving: boolean;
  onDeleteEdge: (edge: DesignEdgeModel) => void;
  onClearSelection: () => void;
};

const nameFor = (nodes: WorkspaceNode[], id: string) => nodes.find((node) => node.id === id)?.name ?? id;

// The dock's other two states (S7): an edge is selected, or nothing is. A selected NODE never
// reaches this component any more — NodeInspector renders directly for that case (see
// ConstellationDesignMode), folding in the facts and dependency/delete actions this rail used to
// own, so a node click opens its full detail in one step instead of a summary-then-"Open details"
// hop.
export function SummaryRail({ nodes, selectedEdge, saving, onDeleteEdge, onClearSelection }: SummaryRailProps) {
  if (selectedEdge) {
    return <aside className="node-dock" aria-label="Selection summary">
      <h3>{selectedEdge.kind} edge</h3>
      <p>{nameFor(nodes, selectedEdge.source)} → {nameFor(nodes, selectedEdge.target)}{selectedEdge.label ? ` (${selectedEdge.label})` : ""}</p>
      {selectedEdge.kind === "execution"
        ? <div className="design-rail-actions">
            <p className="muted">Removing this edge removes the dependency of <strong>{nameFor(nodes, selectedEdge.target)}</strong> on <strong>{nameFor(nodes, selectedEdge.source)}</strong>.</p>
            <button disabled={saving} onClick={() => onDeleteEdge(selectedEdge)}>Remove dependency</button>
          </div>
        : <p className="muted">Stored {selectedEdge.kind} relationships are read-only on the canvas. Editing arrives with the S4 write path (after R-4).</p>}
      <button className="link-button" onClick={onClearSelection}>Clear selection</button>
    </aside>;
  }

  return <aside className="node-dock node-dock-empty" aria-label="Selection summary">
    <h3>Nothing selected</h3>
    <p className="muted">Select a node on the canvas or in the list below to see its full detail — prompt, tools, skills and schemas, right here.</p>
  </aside>;
}
