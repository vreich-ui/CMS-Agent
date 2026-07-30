import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RJSFSchema } from "@rjsf/utils";
import type { McpClient } from "../mcp/client";
import type { RepositoryHealthSummary, SkillDefinition, SkillResolvedPolicy, WorkspaceDocument, WorkspaceNode } from "../types/workspace";

const asSchema = (schema: unknown): RJSFSchema | undefined => schema && typeof schema === "object" ? schema as RJSFSchema : undefined;

export function useWorkspace(client: McpClient) {
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [workspaceVersion, setWorkspaceVersion] = useState<number | undefined>();
  const [exportedWorkspace, setExportedWorkspace] = useState<WorkspaceDocument | null>(null);
  const [repositoryHealth, setRepositoryHealth] = useState<RepositoryHealthSummary | null>(null);
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [resolvedSkillPolicy, setResolvedSkillPolicy] = useState<SkillResolvedPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Every piece of state above belongs to a specific McpClient (i.e. a specific control-plane
  // connection). The instant the client identity changes, reset it all — SYNCHRONOUSLY, during
  // render, not inside a useEffect. An effect-based reset still lags one commit behind the client
  // change, so a render could briefly paint the PREVIOUS client's nodes under the NEW connection;
  // updating state mid-render (React's documented pattern for "adjusting state when a prop
  // changes") makes React discard that render and restart before anything is painted, so the
  // previous plane's data is never visible even for one frame. loadedFor is otherwise unused —
  // it exists only to detect the transition.
  const [loadedFor, setLoadedFor] = useState(client);
  if (loadedFor !== client) {
    setLoadedFor(client);
    setNodes([]);
    setSelectedId(null);
    setPromptDraft("");
    setWorkspaceVersion(undefined);
    setSkills([]);
    setSelectedSkillId(null);
    setResolvedSkillPolicy(null);
    setLoadError(null);
    setLoading(true);
  }

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const selectedSchema = asSchema(selectedNode?.outputSchema ?? selectedNode?.schema);

  useEffect(() => {
    setPromptDraft(selectedNode ? selectedNode.prompt : "");
  }, [selectedNode]);

  // The most recent client the hook has been asked to load for, updated every render. Each
  // loadWorkspace() invocation is permanently bound (via useCallback's [client] dep) to the
  // client value it was created for; comparing against this ref after every await is how it
  // detects that it has been SUPERSEDED by a newer client before applying its result — otherwise
  // an out-of-order response (client A's request resolves AFTER client B's already has) could
  // silently overwrite B's fresh state with A's stale one.
  const activeClientRef = useRef(client);
  activeClientRef.current = client;

  // Manages its own loading/error state so both the automatic client-change load below AND a
  // manual call (a "Retry" button, the legacy "Load workspace" button) report through the same
  // loading/loadError fields — callers that want to react themselves still get the rejection.
  const loadWorkspace = useCallback(async () => {
    const forClient = client;
    setLoading(true);
    setLoadError(null);
    try {
      const { nodes: nextNodes } = await client.call<{ nodes: WorkspaceNode[] }>("workspace.get_nodes");
      if (activeClientRef.current !== forClient) return; // superseded — a newer client already owns this state
      setNodes(nextNodes);
      const { workspaceVersion: nextVersion } = await client.call<WorkspaceDocument>("workspace.export_workspace");
      if (activeClientRef.current !== forClient) return;
      setWorkspaceVersion(nextVersion);
      setSelectedId((current) => current ?? nextNodes[0]?.id ?? null);
    } catch (error) {
      if (activeClientRef.current === forClient) setLoadError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (activeClientRef.current === forClient) setLoading(false);
    }
  }, [client]);

  // Auto-load whenever the client identity changes (including the very first render) — the fix
  // for the split-brain bug: switching control plane / connection previously left this hook's
  // state (and everything that reads it — the node inspector, the Constellation canvas) showing
  // whatever the PREVIOUS client last loaded, because nothing ever re-fetched. Race-safety against
  // a superseded, out-of-order response is loadWorkspace's own concern (see activeClientRef
  // above), so this effect needs no cancellation flag of its own. Failures are swallowed here —
  // they are already captured in loadError for any UI that wants to show them; a caller that needs
  // the rejection (e.g. a "Retry" button) calls loadWorkspace() itself.
  useEffect(() => {
    void loadWorkspace().catch(() => { /* surfaced via loadError; see comment above */ });
  }, [client, loadWorkspace]);

  const mutationArgs = (summary: string) => ({ expectedWorkspaceVersion: workspaceVersion ?? 0, summary });

  const savePrompt = async () => {
    if (!selectedNode) return null;
    const result = await client.call<{ node: WorkspaceNode; workspaceVersion?: number }>("workspace.update_node_prompt", { id: selectedNode.id, prompt: promptDraft, ...mutationArgs("UI prompt update") });
    setNodes((current) => current.map((node) => node.id === result.node.id ? result.node : node));
    setWorkspaceVersion(result.workspaceVersion);
    return result;
  };

  const refreshNodes = async (nextVersion?: number) => { const { nodes: nextNodes } = await client.call<{ nodes: WorkspaceNode[] }>("workspace.get_nodes"); setNodes(nextNodes); if (nextVersion !== undefined) setWorkspaceVersion(nextVersion); };
  const createNode = async () => { const id = `custom_${Date.now()}`; const result = await client.call<{ node: WorkspaceNode; workspaceVersion: number }>("workspace.create_node", { node: { id, name: "New node", kind: "custom", description: "", prompt: "", inputSchema: { type: "object" }, outputSchema: { type: "object" }, allowedTools: [], assignedSkills: [], requiredInputs: [], produces: [], dependsOn: [], riskLevel: "read", status: "draft", position: { x: 0, y: nodes.length * 96 }, updatedAt: new Date().toISOString() }, ...mutationArgs("UI create node") }); await refreshNodes(result.workspaceVersion); setSelectedId(result.node.id); return result; };
  const cloneNode = async () => { if (!selectedNode) return null; const result = await client.call<{ node: WorkspaceNode; workspaceVersion: number }>("workspace.clone_node", { id: selectedNode.id, newId: `${selectedNode.id}_copy_${Date.now()}`, ...mutationArgs("UI clone node") }); await refreshNodes(result.workspaceVersion); setSelectedId(result.node.id); return result; };
  const deleteNode = async () => { if (!selectedNode) return null; const result = await client.call<{ workspaceVersion: number }>("workspace.delete_node", { id: selectedNode.id, ...mutationArgs("UI delete node") }); await refreshNodes(result.workspaceVersion); setSelectedId(null); return result; };
  const updateNodePatch = async (patch: Partial<WorkspaceNode>, summary: string) => { if (!selectedNode) return null; const result = await client.call<{ node: WorkspaceNode; workspaceVersion: number }>("workspace.update_node", { id: selectedNode.id, patch, ...mutationArgs(summary) }); await refreshNodes(result.workspaceVersion); return result; };
  const updateOutputSchema = async (schema: unknown) => { if (!selectedNode) return null; const result = await client.call<{ node: WorkspaceNode; workspaceVersion: number }>("workspace.update_node_output_schema", { id: selectedNode.id, schema, ...mutationArgs("UI output schema update") }); await refreshNodes(result.workspaceVersion); return result; };
  const reorderNodes = async (orderedNodeIds: string[]) => { const result = await client.call<{ workspaceVersion: number }>("workspace.reorder_nodes", { orderedNodeIds, ...mutationArgs("UI graph reorder") }); await refreshNodes(result.workspaceVersion); return result; };
  // Design-canvas mutation: positions, dependency edits, and deletes in one atomic guarded call.
  // Never sends orderedNodeIds — the server's reorder branch rewrites every position.y and would
  // destroy the spatial layout the canvas exists to preserve. update_graph returns the full node
  // list, so state applies directly with no refetch.
  const updateGraph = async (update: { dependencies?: Record<string, string[]>; positions?: Record<string, { x: number; y: number }>; delete?: string[] }, summary: string) => {
    const result = await client.call<{ nodes: WorkspaceNode[]; workspaceVersion: number }>("workspace.update_graph", { ...update, ...mutationArgs(summary), source: "ui" });
    setNodes(result.nodes);
    setWorkspaceVersion(result.workspaceVersion);
    setSelectedId((current) => current && result.nodes.some((node) => node.id === current) ? current : null);
    return result;
  };
  const validateGraph = async () => client.call<{ validation: { valid: boolean; issues: string[] } }>("workspace.validate_graph", {});
  const loadSkills = async () => { const result = await client.call<{ skills: SkillDefinition[] }>("skill.list", {}); setSkills(result.skills); setSelectedSkillId((current) => current ?? result.skills[0]?.skillId ?? null); return result.skills; };
  const assignSkill = async () => { if (!selectedNode || !selectedSkillId) return null; const result = await client.call<{ node: WorkspaceNode; workspaceVersion: number }>("skill.assign", { nodeId: selectedNode.id, skillId: selectedSkillId, ...mutationArgs("UI skill assignment") }); await refreshNodes(result.workspaceVersion); return result; };
  const unassignSkill = async () => { if (!selectedNode || !selectedSkillId) return null; const result = await client.call<{ node: WorkspaceNode; workspaceVersion: number }>("skill.unassign", { nodeId: selectedNode.id, skillId: selectedSkillId, ...mutationArgs("UI skill unassignment") }); await refreshNodes(result.workspaceVersion); return result; };
  const resolveSkillPolicy = async () => { if (!selectedNode) return null; const result = await client.call<{ policy: SkillResolvedPolicy }>("skill.resolve_for_node", { nodeId: selectedNode.id, platformTools: selectedNode.allowedTools ?? [], runAuthorizedTools: selectedNode.allowedTools ?? [] }); setResolvedSkillPolicy(result.policy); return result.policy; };

  const exportWorkspace = async () => {
    const document = await client.call<WorkspaceDocument>("workspace.export_workspace");
    setExportedWorkspace(document);
    setWorkspaceVersion(document.workspaceVersion);
    return document;
  };

  const loadRepositoryHealth = async () => {
    const result = await client.call<{ health: RepositoryHealthSummary }>("repository.get_health");
    setRepositoryHealth(result.health);
    return result.health;
  };

  return {
    nodes,
    selectedId,
    selectedNode,
    selectedSchema,
    promptDraft,
    workspaceVersion,
    exportedWorkspace,
    repositoryHealth,
    skills,
    selectedSkillId,
    resolvedSkillPolicy,
    loading,
    loadError,
    setSelectedId,
    setPromptDraft,
    setSelectedSkillId,
    loadWorkspace,
    savePrompt,
    createNode,
    cloneNode,
    deleteNode,
    updateNodePatch,
    updateOutputSchema,
    reorderNodes,
    updateGraph,
    validateGraph,
    loadSkills,
    assignSkill,
    unassignSkill,
    resolveSkillPolicy,
    exportWorkspace,
    loadRepositoryHealth
  };
}
