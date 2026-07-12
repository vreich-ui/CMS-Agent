import { useEffect, useMemo, useRef, useState } from "react";
import { DesignCanvas } from "./DesignCanvas";
import { SummaryRail } from "./SummaryRail";
import { LayerToggles } from "./LayerToggles";
import { GraphListView } from "./GraphListView";
import {
  arrangeGridPositions,
  connectDependencyPatch,
  defaultDesignLayers,
  describeMutationError,
  graphListEntries,
  hasIdenticalPositions,
  layerAvailability,
  removeDependencyPatch,
  type DesignEdgeModel,
  type DesignLayerKind,
  type DesignLayers
} from "../../designGraph";
import { getErrorMessage } from "../../hooks/useConnection";
import type { useWorkspace } from "../../hooks/useWorkspace";
import type { McpClient } from "../../mcp/client";
import type { ConstellationStructure, WorkspaceRelationship } from "../../types/workspace";
import type { StatusMessage } from "../../status";

type Props = {
  client: McpClient;
  workspace: ReturnType<typeof useWorkspace>;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

type GraphUpdate = { dependencies?: Record<string, string[]>; positions?: Record<string, { x: number; y: number }>; delete?: string[] };

// Design mode container: owns relationship/layer/conflict state and the single persist pipeline.
// Every mutation is version-guarded; conflicts surface verbatim with an explicit reload action —
// never a silent retry.
export function ConstellationDesignMode({ client, workspace, onStatus, onError }: Props) {
  const [relationships, setRelationships] = useState<WorkspaceRelationship[]>([]);
  const [layers, setLayers] = useState<DesignLayers>(defaultDesignLayers);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<DesignEdgeModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const { nodes, selectedId, selectedNode, setSelectedId, loadWorkspace, updateGraph, validateGraph } = workspace;

  const loadStructure = async () => {
    try {
      const structure = await client.call<ConstellationStructure>("constellation.get_structure");
      setRelationships(structure.relationships);
    } catch (error) {
      // Relationships are an optional overlay; the canvas still renders execution truth.
      setRelationships([]);
      onStatus({ tone: "info", message: `Stored relationships unavailable: ${getErrorMessage(error)}` });
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      if (nodes.length === 0) {
        try {
          await loadWorkspace();
        } catch (error) {
          setLoadError(getErrorMessage(error));
          return;
        }
      }
      await loadStructure();
    };
    void bootstrap();
    // Mount-only: loadWorkspace/loadStructure are stable enough for a one-time bootstrap.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = async (update: GraphUpdate, summary: string) => {
    if (savingRef.current) {
      onStatus({ tone: "info", message: "A save is in flight — try again in a moment." });
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await updateGraph(update, summary);
      setConflict(null);
      onStatus({ tone: "success", message: summary });
      return true;
    } catch (error) {
      const described = describeMutationError(getErrorMessage(error));
      if (described.kind === "workspace_version_conflict" || described.kind === "revision_conflict") {
        setConflict(described.message);
      } else if (described.kind === "refused") {
        onStatus({ tone: "error", message: described.message });
      } else {
        onError(error);
        if (update.dependencies) await refreshIssues();
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const refreshIssues = async () => {
    try {
      const result = await validateGraph();
      setIssues(result.validation.issues);
    } catch {
      // validate_graph is advisory; a failed validation fetch must not mask the original error.
    }
  };

  const nameFor = (id: string) => nodes.find((node) => node.id === id)?.name ?? id;

  const handleMoveNode = (id: string, position: { x: number; y: number }) => {
    void persist({ positions: { [id]: position } }, `Moved ${nameFor(id)} on the canvas`);
  };

  const handleConnect = (sourceId: string, targetId: string) => {
    const result = connectDependencyPatch(nodes, sourceId, targetId);
    if ("refusal" in result) {
      onStatus({ tone: "info", message: result.refusal });
      return;
    }
    void persist({ dependencies: result.patch }, `Added dependency: ${nameFor(targetId)} now depends on ${nameFor(sourceId)}`);
  };

  const handleRemoveDependency = (dependentId: string, dependencyId: string) => {
    void persist(
      { dependencies: removeDependencyPatch(nodes, dependentId, dependencyId) },
      `Removed dependency: ${nameFor(dependentId)} no longer depends on ${nameFor(dependencyId)}`
    );
  };

  const handleDeleteNode = () => {
    if (!selectedNode) return;
    void persist({ delete: [selectedNode.id] }, `Deleted ${selectedNode.id} from the canvas`);
  };

  const handleEdgeDelete = (edge: DesignEdgeModel) => {
    if (edge.kind !== "execution") {
      onStatus({ tone: "info", message: `Stored ${edge.kind} relationships are read-only on the canvas until S4.` });
      return;
    }
    setSelectedEdge(edge);
    setSelectedId(null);
  };

  const handleReload = async () => {
    try {
      await loadWorkspace();
      await loadStructure();
      setConflict(null);
      setIssues(null);
      onStatus({ tone: "success", message: "Workspace reloaded. Re-apply your change on the latest state." });
    } catch (error) {
      onError(error);
    }
  };

  const handleValidate = async () => {
    try {
      const result = await validateGraph();
      setIssues(result.validation.issues);
      onStatus(result.validation.valid
        ? { tone: "success", message: "Graph is valid." }
        : { tone: "error", message: `Graph has ${result.validation.issues.length} issue(s).` });
    } catch (error) {
      onError(error);
    }
  };

  const layerOptions = useMemo(() => layerAvailability(relationships), [relationships]);
  const listEntries = useMemo(() => graphListEntries(nodes, relationships), [nodes, relationships]);
  const showArrange = useMemo(() => hasIdenticalPositions(nodes), [nodes]);

  if (loadError) {
    return <section className="panel design-empty">
      <h3>Workspace not loaded</h3>
      <p className="muted">{loadError}</p>
      <p className="muted">Check the connection in Settings, then try again.</p>
      <button onClick={() => { setLoadError(null); void loadWorkspace().then(loadStructure).catch((error) => setLoadError(getErrorMessage(error))); }}>Retry</button>
    </section>;
  }

  return <section className="design-mode" aria-label="Design mode">
    <div className="design-toolbar">
      <LayerToggles options={layerOptions} layers={layers} onToggle={(kind: DesignLayerKind) => setLayers((current) => ({ ...current, [kind]: !current[kind] }))} />
      <div className="design-toolbar-actions">
        {saving && <span className="design-saving" aria-live="polite">Saving…</span>}
        {showArrange && <button disabled={saving} onClick={() => void persist({ positions: arrangeGridPositions(nodes) }, "Arranged nodes on a grid")}>Arrange grid</button>}
        <button disabled={saving} onClick={() => void handleValidate()}>Validate graph</button>
      </div>
    </div>

    {conflict && <div className="design-conflict status error" role="alert">
      <p><strong>{conflict}</strong></p>
      <p>Someone else changed the workspace. Reload to get the latest state, then re-apply your change.</p>
      <button onClick={() => void handleReload()}>Reload workspace</button>
    </div>}

    {issues && issues.length > 0 && <div className="status error" role="status">
      <strong>Validation issues:</strong>
      <ul className="design-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
    </div>}

    <div className="design-grid">
      <DesignCanvas
        nodes={nodes}
        relationships={relationships}
        layers={layers}
        selectedId={selectedId}
        selectedEdgeId={selectedEdge?.id ?? null}
        saving={saving}
        onSelectNode={(id) => { setSelectedId(id); if (id) setSelectedEdge(null); }}
        onSelectEdge={(edge) => { setSelectedEdge(edge); if (edge) setSelectedId(null); }}
        onMoveNode={handleMoveNode}
        onConnectDependency={handleConnect}
        onRequestEdgeDelete={handleEdgeDelete}
      />
      <SummaryRail
        node={selectedNode}
        nodes={nodes}
        selectedEdge={selectedEdge}
        saving={saving}
        onAddDependency={(dependencyId) => { if (selectedNode) handleConnect(dependencyId, selectedNode.id); }}
        onRemoveDependency={(dependencyId) => { if (selectedNode) handleRemoveDependency(selectedNode.id, dependencyId); }}
        onDeleteNode={handleDeleteNode}
        onDeleteEdge={(edge) => { handleRemoveDependency(edge.target, edge.source); setSelectedEdge(null); }}
        onClearSelection={() => setSelectedEdge(null)}
      />
    </div>

    <GraphListView entries={listEntries} />
  </section>;
}
