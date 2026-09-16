import { createHash } from "node:crypto";
import { resolveExecutionKind, type NodeExecutionKind } from "./routeRegistry.js";
import type { WorkspaceNode } from "./nodeTypes.js";

// W2 — the list projection of a workspace node.
//
// `workspace_get_nodes` measured 310 KB for 51 nodes on 2026-09-16: prompt 53 %, outputSchema 17 %,
// and 12 % (38 KB) the deprecated `schema` alias duplicating outputSchema. Every surface that shows
// a LIST of nodes — the rail, the graph overlay, the workflow menu's counts, ⌘K's index — needs
// identity, shape and status. None of them render a prompt or a schema; the inspector fetches the
// one selected node with `workspace_get_node` and gets everything.
//
// What a summary row deliberately keeps, beyond identity:
//   * `dependsOn`/`requiredInputs`/`produces` — the graph is drawn from these, so dropping them
//     would just force a second call.
//   * `executionKind` — the rail's model/deterministic glyph, already derivable server-side
//     (routeRegistry.resolveExecutionKind) and NOT derivable client-side without the metadata this
//     projection omits. Computing it here is what lets the metadata go.
//   * `hasDefaultOutput` — whether a push-through is possible at all. The VALUE can be arbitrarily
//     large and belongs to the inspector; the boolean is one bit.
//   * `promptSha` — a stable identity for the prompt WITHOUT the prompt. It is what lets a client
//     cache a prompt across paints and know when it went stale, and it is why dropping 53 % of the
//     payload does not cost the rail any correctness.
//
// `phase` is NOT here: no phase exists server-side. Phases are presentation config
// (workbench/src/api/workflowCatalog.ts) and a workflow the catalog does not know is grouped as
// "ungrouped (live)" by the client. Inventing a server-side phase would be inventing data.

// Absent means empty, and absent means false. Across 51 nodes the empty arrays and the
// almost-always-false boolean are ~2 KB of pure "no" — the same reason `runSummaryOf` omits an
// empty `nodeStatuses` rather than writing one. Every field below is optional in exactly the case
// where its value carries no information.
export type WorkspaceNodeSummary = {
  id: string;
  name: string;
  kind: string;
  executionKind: NodeExecutionKind;
  status: WorkspaceNode["status"];
  riskLevel: WorkspaceNode["riskLevel"];
  dependsOn?: string[];
  requiredInputs?: string[];
  produces?: string[];
  position: WorkspaceNode["position"];
  hasDefaultOutput?: true;
  promptSha: string;
  updatedAt: string;
};

/** Short, stable, and never reversible into the prompt — an identity, not a payload. */
export const promptSha = (prompt: string): string => createHash("sha256").update(prompt ?? "", "utf8").digest("hex").slice(0, 12);

const listOrOmit = (values: string[] | undefined) => (values && values.length ? { values } : undefined);

export const summarizeWorkspaceNode = (node: WorkspaceNode): WorkspaceNodeSummary => ({
  id: node.id,
  name: node.name,
  kind: node.kind,
  executionKind: resolveExecutionKind(node),
  status: node.status,
  riskLevel: node.riskLevel,
  ...(listOrOmit(node.dependsOn) ? { dependsOn: node.dependsOn } : {}),
  ...(listOrOmit(node.requiredInputs) ? { requiredInputs: node.requiredInputs } : {}),
  ...(listOrOmit(node.produces) ? { produces: node.produces } : {}),
  position: node.position,
  ...(node.defaultOutput !== undefined && node.defaultOutput !== null ? { hasDefaultOutput: true as const } : {}),
  promptSha: promptSha(node.prompt),
  updatedAt: node.updatedAt
});

export const summarizeWorkspaceNodes = (nodes: WorkspaceNode[]): WorkspaceNodeSummary[] => nodes.map(summarizeWorkspaceNode);

export type NodeDetail = "summary" | "full";
