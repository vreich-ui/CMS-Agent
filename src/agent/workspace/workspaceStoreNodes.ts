import { listWorkspaceNodes } from "./nodes.js";
import { captureConductorNodes } from "./captureConductorNodes.js";
import { cloneConductorNodes } from "./cloneConductorNodes.js";
import { visualIdentityNodes } from "./visualIdentityNodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";

// T15.16 (#195) — the workspace STORE's own governance-visible node set, as distinct from a
// WORKFLOW's execution topology (workflowRegistry.ts's canonicalNodes(), what resolveConductorNodes
// actually runs).
//
// WHY THIS IS A SEPARATE MODULE FROM nodes.ts. publishingConductorNodes / listWorkspaceNodes() IS
// the canonical node array for the publishing_conductor WORKFLOW — the exact array
// scripts/seedNodesFromWorkspace.ts round-trips against the live store, composeWorkflowNodes reads
// as "the shared tail's own definitions", and workflowRegistry.ts registers verbatim as
// publishing_conductor's run topology. Folding captureConductorNodes/cloneConductorNodes into THAT
// array would make them appear to be part of publishing_conductor's own DAG (they are not — they
// have no publishing_conductor dependents) and would feed capture/clone's node literals through
// seedNodesFromWorkspace.ts's live-store round-trip and prompt-shrink/tail-conformance guards, which
// are scoped to the publishing tail only. Keeping this union in its OWN module (importing nodes.ts,
// never the reverse) means nodes.ts, publishingTail.ts and the re-seed script's guards are completely
// unaffected — see publishingTail.ts and captureConductorNodes.ts, unchanged by this file.
//
// WHY THIS EXISTS AT ALL. nodeResolution.ts's findCanonicalNodeById (T12.15) already lets EXECUTION
// find block_classifier et al. through the workflow registry when the store has no row for them —
// that was deliberately built so these nodes never needed a store row to RUN correctly. What it
// does not do is make them GOVERNABLE: workspace.get_node, workspace.get_node_effective_config,
// the optimizer and playbook curation tools all read the store directly (workspaceRepository.getNode),
// with no canonical fallback, so an id absent from document.nodes reads back null — issue #195's
// "workspace_get_node('block_classifier') -> null while node_get_effective_prompt on the same id
// resolves". This module is what closes that: an ADDITIVE union of every node id an operator should
// be able to inspect/edit through the workspace.* surface, used to seed a fresh workspace document
// (store.ts's defaultWorkspaceNodes) and to top up an existing one (store.ts's
// ensureWorkspaceNodeSeeds), the same way conversational agents are additively topped up
// (ensureConversationalAgentSeeds).
//
// WHY THE RAW (UNCOMPOSED) captureConductorNodes/cloneConductorNodes ARRAYS, NEVER
// listCaptureConductorNodes()/listCloneConductorNodes(). Those functions COMPOSE the upstream with
// the shared publishing tail (composeWorkflowNodes), which means their output carries capture's/
// clone's OWN COPIES of publish_payload/publication_controller/publish_executor/release_executor/
// learning_recorder — same ids as the publishing tail's own canonical rows, rebound dependsOn
// (capture_emit_live/capture_score, or recipe_mint/theme_bind/layout_restamp) instead of
// (article_body/artifact_plan). Merging those copies into ONE flat, id-keyed store document would
// either silently overwrite the shared tail's canonical row with a workflow-specific rebinding (three
// workflows fighting over one id) or require picking a winner arbitrarily — exactly the tail-forking
// hazard publishingTail.ts's drift guard exists to prevent. The raw upstream arrays declare no tail
// node at all (capture_report/clone_report merely DEPEND on publish_executor/release_executor by id,
// which already resolve against the publishing tail's own canonical row below), so merging them
// produces zero id collisions and asks nothing of the tail's shared definition.
const cloneNode = (node: WorkspaceNode): WorkspaceNode => ({
  ...node,
  dependsOn: [...node.dependsOn],
  allowedTools: [...node.allowedTools],
  assignedSkills: node.assignedSkills ? [...node.assignedSkills] : node.assignedSkills,
  requiredInputs: [...node.requiredInputs],
  produces: [...node.produces],
  position: { ...node.position },
  metadata: node.metadata ? structuredClone(node.metadata) : undefined
});

// The four sources, in the order they appear in a fresh union: publishing's own canonical set first
// (unchanged ordering/behavior for every existing publishing-only caller), then capture_conductor's
// own upstream nodes, then clone_conductor's own upstream nodes, then (C5) visual_identity's pair.
//
// visual_identity's two nodes are listed RAW for the same reason capture's and clone's are, and the
// reason is even simpler here: this workflow composes no publishing tail at all, so its array declares
// no shared-tail node and can collide with nothing.
const workspaceStoreSources = (): WorkspaceNode[] => [...listWorkspaceNodes(), ...captureConductorNodes, ...cloneConductorNodes, ...visualIdentityNodes];

// Duplicate ids across the three sources are not expected (verified by
// workspaceStoreNodes.test.ts) — this defensive dedup keeps the FIRST occurrence (publishing's own
// tail definition wins over anything a future capture/clone edit might accidentally declare under
// the same id) rather than throwing, so a governance-surface read degrades to "one of the two", never
// to a crash.
export function workspaceStoreSeedNodes(): WorkspaceNode[] {
  const seen = new Set<string>();
  const merged: WorkspaceNode[] = [];
  for (const node of workspaceStoreSources()) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    merged.push(cloneNode(node));
  }
  return merged;
}

export function workspaceStoreCanonicalIds(): Set<string> {
  return new Set(workspaceStoreSeedNodes().map((node) => node.id));
}
