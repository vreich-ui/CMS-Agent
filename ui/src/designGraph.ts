// Framework-free graph model for the Design-mode canvas. Everything here is pure data → data so
// the root node test suite can exercise it, mirroring route.ts/projects.ts. The server remains
// authoritative for graph validity — local checks exist only for instant feedback.

import type { RelationshipKind, WorkspaceNode, WorkspaceRelationship } from "./types/workspace.js";

export type DesignLayerKind = "execution" | "data" | "policy";
export type DesignLayers = Record<DesignLayerKind, boolean>;

export const defaultDesignLayers: DesignLayers = { execution: true, data: false, policy: false };

export type DesignNodeModel = {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  riskLevel?: WorkspaceNode["riskLevel"];
  position: { x: number; y: number };
  counts: { skills: number; tools: number; dependsOn: number };
};

export type DesignEdgeModel = {
  id: string;
  source: string;
  target: string;
  kind: DesignLayerKind;
  // Execution edges are editable (they are node.dependsOn projections); stored data/policy
  // relationships are read-only on the canvas until the S4 modal owns relationship editing.
  readonly: boolean;
  label?: string;
};

export function buildDesignNodes(nodes: WorkspaceNode[]): DesignNodeModel[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    status: node.status,
    riskLevel: node.riskLevel,
    position: node.position ?? { x: 0, y: 0 },
    counts: {
      skills: node.assignedSkills?.length ?? 0,
      tools: node.allowedTools?.length ?? 0,
      dependsOn: node.dependsOn?.length ?? 0
    }
  }));
}

// Execution edges point dependency → dependent, matching the server's derived direction.
export function buildDesignEdges(
  nodes: WorkspaceNode[],
  relationships: WorkspaceRelationship[],
  layers: DesignLayers
): DesignEdgeModel[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: DesignEdgeModel[] = [];
  if (layers.execution) {
    for (const node of nodes) {
      for (const dependency of node.dependsOn ?? []) {
        if (!nodeIds.has(dependency)) continue;
        edges.push({ id: `dep:${dependency}->${node.id}`, source: dependency, target: node.id, kind: "execution", readonly: false });
      }
    }
  }
  for (const relationship of relationships) {
    if (relationship.kind !== "data" && relationship.kind !== "policy") continue;
    if (!layers[relationship.kind]) continue;
    if (!relationship.enabled) continue;
    if (!nodeIds.has(relationship.sourceId) || !nodeIds.has(relationship.targetId)) continue;
    edges.push({
      id: `rel:${relationship.id}`,
      source: relationship.sourceId,
      target: relationship.targetId,
      kind: relationship.kind,
      readonly: true,
      label: relationship.label
    });
  }
  return edges;
}

// Local pre-check for adding target→dependsOn→source. Mirrors the server's cycle detection for
// instant refusal; the server re-validates every update_graph regardless.
export function connectDependencyPatch(
  nodes: WorkspaceNode[],
  sourceId: string,
  targetId: string
): { patch: Record<string, string[]> } | { refusal: string } {
  if (sourceId === targetId) return { refusal: "A node cannot depend on itself." };
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || !target) return { refusal: `Unknown node: ${source ? targetId : sourceId}` };
  const existing = target.dependsOn ?? [];
  if (existing.includes(sourceId)) return { refusal: `${target.name} already depends on ${source.name}.` };

  // Would source (or anything source depends on) reach target? Then target→source closes a cycle.
  const dependsOnById = new Map(nodes.map((node) => [node.id, node.dependsOn ?? []]));
  const visited = new Set<string>();
  const stack = [sourceId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === targetId) return { refusal: `Adding this dependency would create a cycle (${source.name} already depends on ${target.name}).` };
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(dependsOnById.get(current) ?? []));
  }
  return { patch: { [targetId]: [...existing, sourceId] } };
}

export function removeDependencyPatch(
  nodes: WorkspaceNode[],
  dependentId: string,
  dependencyId: string
): Record<string, string[]> {
  const dependent = nodes.find((node) => node.id === dependentId);
  const existing = dependent?.dependsOn ?? [];
  return { [dependentId]: existing.filter((id) => id !== dependencyId) };
}

export function hasIdenticalPositions(nodes: WorkspaceNode[]): boolean {
  const seen = new Set<string>();
  for (const node of nodes) {
    const key = `${node.position?.x ?? 0},${node.position?.y ?? 0}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

// Deterministic grid for the explicit "Arrange grid" action — never applied silently.
export function arrangeGridPositions(
  nodes: WorkspaceNode[],
  columns = 5,
  spacingX = 280,
  spacingY = 180
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  nodes.forEach((node, index) => {
    positions[node.id] = { x: (index % columns) * spacingX, y: Math.floor(index / columns) * spacingY };
  });
  return positions;
}

export type LayerOption = { kind: RelationshipKind; available: boolean; count: number; note?: string };

// Honest layer availability: execution is always derivable; data/policy count stored enabled
// relationships; memory/evaluation have no stored representation yet and say so.
export function layerAvailability(relationships: WorkspaceRelationship[]): LayerOption[] {
  const countFor = (kind: RelationshipKind) =>
    relationships.filter((relationship) => relationship.kind === kind && relationship.enabled).length;
  return [
    { kind: "execution", available: true, count: 0 },
    { kind: "data", available: true, count: countFor("data") },
    { kind: "policy", available: true, count: countFor("policy") },
    { kind: "memory", available: false, count: 0, note: "Memory relationships are not stored per-edge yet." },
    { kind: "evaluation", available: false, count: 0, note: "Evaluation relationships are not stored per-edge yet." }
  ];
}

export type MutationErrorKind = "workspace_version_conflict" | "revision_conflict" | "refused" | "other";

// Classifies the server's string-error conventions without ever rewriting the message — the
// verbatim text is part of the honesty contract.
export function describeMutationError(message: string): { kind: MutationErrorKind; message: string } {
  if (message.includes("workspace_version_conflict")) return { kind: "workspace_version_conflict", message };
  if (message.includes("revision_conflict")) return { kind: "revision_conflict", message };
  if (message.includes("Missing required canonical node") || message.includes("Cannot delete referenced node")) {
    return { kind: "refused", message };
  }
  return { kind: "other", message };
}

// Screen-reader list view: the canvas must be fully understandable without the visual graph.
export function graphListEntries(
  nodes: WorkspaceNode[],
  relationships: WorkspaceRelationship[]
): Array<{ id: string; text: string }> {
  const nameFor = (id: string) => nodes.find((node) => node.id === id)?.name ?? id;
  const entries = nodes.map((node) => {
    const deps = (node.dependsOn ?? []).map(nameFor);
    const parts = [
      `${node.name} — kind ${node.kind ?? "unknown"}, status ${node.status ?? "unknown"}, risk ${node.riskLevel ?? "unknown"}`,
      deps.length > 0 ? `depends on: ${deps.join(", ")}` : "no dependencies"
    ];
    return { id: node.id, text: parts.join("; ") };
  });
  const stored = relationships
    .filter((relationship) => relationship.enabled)
    .map((relationship) => ({
      id: `rel:${relationship.id}`,
      text: `${relationship.kind} relationship: ${nameFor(relationship.sourceId)} → ${nameFor(relationship.targetId)}${relationship.label ? ` (${relationship.label})` : ""}`
    }));
  return [...entries, ...stored];
}
