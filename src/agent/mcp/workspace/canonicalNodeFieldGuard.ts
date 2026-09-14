import { CANONICAL_OWNED_FIELDS } from "../../workspace/executor.js";
import { workspaceStoreCanonicalIds } from "../../workspace/workspaceStoreNodes.js";
import { getWorkflowDefinition, listRegisteredWorkflowIds } from "../../workspace/workflowRegistry.js";
import { CanonicalOwnedFieldWriteError } from "../../workspace/workspaceErrors.js";

// T5 (docs/plan/two-plane-reconciliation-plan.md §B; ADR-2026-09-13-node-definition-field-ownership).
//
// THE PROBLEM. workspace.update_node took an arbitrary patch and workspace.update_node_dependencies /
// workspace.update_graph wrote dependsOn outright. None of those reach a run: overlayStoreNode
// (executor.ts) rebuilds every dispatched node with CANONICAL_OWNED_FIELDS taken from the canonical
// definition, whatever the store row says. So each such write was a write-only lie — it returned ok,
// changed the governance view, never changed behaviour, and then blocked the next re-seed of nodes.ts
// because the generator could no longer tell a deliberate topology change from accumulated noise.
// That is how the live store came to hold the pre-W8 graph.
//
// THE RULE. For a node id canonical defines, refuse. For a node the store adds and canonical does not
// know, allow — there is no canonical row to be pinned from, and adding such a node is a supported act
// (tests/agent/workspace/seedNodesScoping.test.ts).
//
// WHAT THIS DELIBERATELY DOES NOT COVER, and why each is safe to leave. `changes.restore`
// (changesTools.ts) writes a PREVIOUS stored row back wholesale — it can only reinstate state the
// store already held, never author a new divergence, and narrowing it would make a rollback
// unrunnable for exactly the rows a rollback is for. `workspace.import_workspace` is a bulk admin
// restore of a whole document with the same property. Neither is a path an editing agent reaches by
// accident, and both stay visible in the change history. The engine itself writes none of these
// fields through the store: the only in-code callers of updateNode write modelConfig, assignedSkills
// or a restored snapshot. If a future `tail:` line shows up in nodes:check, one of those two is where
// to look first.
//
// WHY `position` IS EXEMPT, and it is the only exemption. position is canonical-owned at DISPATCH like
// the rest, but it is also the constellation design canvas's persisted layout: the SPA reads positions
// straight out of the store document and writes them back on drop and on "Arrange grid"
// (ui/src/components/constellation/ConstellationDesignMode.tsx, ui/src/hooks/useWorkspace.ts's
// reorderNodes/updateGraph). Refusing it would break a working operator affordance to prevent a write
// that carries no run semantics at all — no edge, no gate, no risk level. Every other canonical-owned
// field does carry run semantics, and is refused. Derived from CANONICAL_OWNED_FIELDS by subtraction so
// a field added to that constant is refused here by default, never silently unguarded.
export const CANONICAL_OWNED_WRITE_EXEMPT_FIELDS = ["position"] as const;
export const CANONICAL_OWNED_WRITE_REFUSED_FIELDS: readonly string[] =
  CANONICAL_OWNED_FIELDS.filter((field) => !(CANONICAL_OWNED_WRITE_EXEMPT_FIELDS as readonly string[]).includes(field));

// TWO SOURCES, UNIONED, because neither alone is the set overlayStoreNode actually pins.
//
// workspaceStoreCanonicalIds() is the workspace STORE's governance-visible seed union (publishing +
// capture + clone + visual_identity). It deliberately excludes pdfTemplateStudioNodes.ts — see that
// module's header — so it is NOT a complete list of ids a run resolves from canonical.
// resolveConductorNodes pins per REGISTERED WORKFLOW, via each definition's canonicalNodes(), and
// pdf_template_studio and image_template_revision are registered workflows whose ids are invisible to
// the first source. A write to one of their canonical-owned fields is discarded at dispatch exactly
// like any other, so refusing it is the same obligation. Missing them was a real hole in the first
// draft of this guard.
//
// Every workflow module is registered by import side effect before this runs: executor.js (imported
// above for CANONICAL_OWNED_FIELDS) imports each of them. Recomputed per call rather than cached —
// registration is import-time, the arrays are what a test swaps, and the union is a few dozen strings.
const canonicalNodeIds = (): Set<string> => {
  const ids = workspaceStoreCanonicalIds();
  for (const workflowId of listRegisteredWorkflowIds()) {
    for (const node of getWorkflowDefinition(workflowId)?.canonicalNodes() ?? []) ids.add(node.id);
  }
  return ids;
};

export const isCanonicalNodeId = (nodeId: string): boolean => canonicalNodeIds().has(nodeId);

export const canonicalOwnedFieldsIn = (patchKeys: Iterable<string>): string[] =>
  CANONICAL_OWNED_WRITE_REFUSED_FIELDS.filter((field) => [...patchKeys].includes(field));

// Throws CanonicalOwnedFieldWriteError naming every offending field at once, so an operator fixes the
// patch in one round instead of discovering the fields one at a time.
export const assertNoCanonicalOwnedFieldWrite = (toolName: string, nodeId: string, patchKeys: Iterable<string>): void => {
  if (!isCanonicalNodeId(nodeId)) return;
  const offending = canonicalOwnedFieldsIn(patchKeys);
  if (offending.length) throw new CanonicalOwnedFieldWriteError(toolName, nodeId, offending, CANONICAL_OWNED_WRITE_REFUSED_FIELDS);
};
