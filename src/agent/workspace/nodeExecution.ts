// K-A9 (W5, 2026-09-16) — HOW A NODE RUNS, AS A STORED FIELD RATHER THAN A METADATA FLAG.
//
// THE DEFECT THIS CLOSES. Until this file, "is this node a model turn or a deterministic engine
// route" was answered ONLY by reading `node.metadata` for one of a dozen boolean/string keys. The
// keys are ordinary metadata, and `workspace.update_node_metadata` (and `workspace.update_node`, and
// `workspace.import_workspace`) REPLACE the whole metadata object. So one write that merely forgot to
// repeat `releaseExecutorDeterministic` — or deliberately set it `false` — turned the release step
// into a model turn holding `project.call_tool`, with no idempotency ledger and nothing anywhere
// noticing. `npm run store:update` could not undo it either: its allowlist has no tail-node metadata
// entry. That is docs/KNOWN_ISSUES.md K-A9, and K-A1 is the same defect wearing `publish_executor`.
//
// THE FIX, IN ONE SENTENCE. `executionKind` and `route` become FIELDS ON THE NODE. A write that
// replaces `metadata` does not touch them, so the route survives it; changing how a node runs now
// needs the one verb that says so, `workspace.update_node_execution`.
//
// WHY THIS MODULE EXISTS SEPARATELY FROM routeRegistry.ts, WHICH IS WHERE THE ROUTE VOCABULARY LIVES.
// Import cycle, and nothing more interesting: the store (mcp/workspace/store.ts) has to derive these
// fields at parse time, routeRegistry.ts reaches nodeTimings.ts and through it the repository manager,
// and the repository manager reaches the store. This file imports nothing but the node type, so both
// ends can depend on it. routeRegistry.ts re-exports everything below under its historical names.
//
// FAIL-OPEN, WHICH IS THE WHOLE DESIGN. Derivation NEVER manufactures a negative. A node whose
// metadata declares no route gets NO stored fields at all — not `executionKind: "model"` — so it
// keeps resolving through the same metadata scan it always did, and a store row written before this
// change behaves identically to the day it was written. Only a POSITIVE declaration (the metadata
// actually names a route) is ever persisted, and only an EXPLICIT operator write through
// `workspace.update_node_execution` can ever store `executionKind: "model"`.
import type { WorkspaceNode } from "./nodeTypes.js";

export type NodeExecutionKind = "model" | "deterministic";

/**
 * A node's deterministic route, as stored.
 *
 * `id` is the DECLARING ROUTE KEY (`"releaseExecutorDeterministic"`, `"captureStageDeterministic"`),
 * not a route-manifest id — deliberately, and this is the one naming choice in K-A9 worth stating
 * out loud. Only five of the twelve routes have manifests; using manifest ids would have made `route`
 * unrepresentable for the other seven, and would have lost the identity that `resolveRouteEra` (and
 * therefore every timing sample ever filed) is keyed on. `routeRegistry.resolveRouteId` maps this key
 * to a manifest id where one exists, exactly as it did from the metadata key before.
 *
 * `mode` is the value half of a string-valued declaration (`captureStageDeterministic: "crawl"` ->
 * `{ id: "captureStageDeterministic", mode: "crawl" }`). Absent for a boolean-valued route.
 */
export type NodeRoute = { id: string; mode?: string };

// The metadata keys that declare a node terminates in a deterministic route rather than a model
// dispatch. Order matters: a node in a COMPOSED workflow can carry more than one (the shared
// publishing tail inherits the DTC keys while also declaring its own capture/clone stage), and the
// derivation below reads this list in order so such a node resolves to the SAME route on every sample
// rather than to whichever key an unordered iteration reached first.
//
// (Moved here from routeRegistry.ts by K-A9 so the store can derive without importing the registry;
// routeRegistry.ts re-exports it and remains the place a reader is sent for what each route IS.)
export const DETERMINISTIC_ROUTE_METADATA_KEYS = [
  "contractIntelligenceDeterministic",
  "placementResolverDeterministic",
  "publishPayloadDeterministic",
  "publicationControllerDeterministic",
  "publishExecutorDeterministic",
  "releaseExecutorDeterministic",
  "learningRecorderDeterministic",
  // T12.9: the capture_conductor stages (captureConductorRoutes.ts). String-valued ("crawl", ...),
  // which the derivation below treats as declared, with the value as the route's `mode`.
  "captureStageDeterministic",
  // T13.1: the clone_conductor stages (cloneConductorRoutes.ts). Same string-valued declaration.
  "cloneStageDeterministic",
  // C5: visual_identity's second node (visualStandardMaterialization.ts). Boolean-valued, like
  // artifact_materializer's own route flag.
  "visualStandardMaterializerDeterministic",
  // W1.4 (2026-09-09) — artifact_materializer, which had been missing from this list since it was
  // written while every one of its siblings was in it. See routeRegistry.ts's DETERMINISTIC ROUTES
  // section for the two consumers that needed it (plannedNodeTimeoutMs and
  // isConcurrentDispatchEligible) and what each got wrong without it.
  "artifactMaterializerDeterministic"
] as const;

// Attribution and dispatch ask different questions — "what program produced this sample" and "how is
// this node dispatched" — and they briefly had different answers. This alias exists so the distinction
// stays visible: if a route ever needs attributing without changing how it is dispatched, it goes
// here and not above.
export const ROUTE_ERA_METADATA_KEYS = DETERMINISTIC_ROUTE_METADATA_KEYS;

/** The era string a route resolves to: the declaring key, plus its value when string-valued. */
export const routeEraOf = (route: NodeRoute): string => (route.mode === undefined ? route.id : `${route.id}:${route.mode}`);

/** `"captureStageDeterministic:crawl"` -> `{ id, mode }`. The inverse of `routeEraOf`. */
export const routeFromEra = (era: string): NodeRoute => {
  const at = era.indexOf(":");
  return at === -1 ? { id: era } : { id: era.slice(0, at), mode: era.slice(at + 1) };
};

/**
 * The route a node's METADATA declares, or undefined when it declares none.
 *
 * `undefined` is "this metadata names no route" and is NEVER "this node is a model turn" — see the
 * fail-open note in the header. A key present but `false` counts as naming no route, which is exactly
 * how `declaresDeterministicRoute` has always read it.
 */
export const deriveRouteFromMetadata = (metadata: Record<string, unknown> | undefined): NodeRoute | undefined => {
  if (!metadata) return undefined;
  for (const key of ROUTE_ERA_METADATA_KEYS) {
    const declared = metadata[key];
    if (declared === undefined || declared === false) continue;
    return typeof declared === "string" ? { id: key, mode: declared } : { id: key };
  }
  return undefined;
};

/**
 * HOW THIS NODE RUNS — the one function every other answer is built from.
 *
 * Resolution order, and the reason for it:
 *   1. The STORED `executionKind` field, when present. An explicit answer, written either by
 *      derive-on-load from this row's own metadata or by `workspace.update_node_execution`. It wins
 *      over metadata, which is precisely what makes a metadata write unable to flip a route.
 *   2. The node's metadata, scanned exactly as before. This is every row written before K-A9, and
 *      every canonical literal until `npm run nodes:update` carries the fields into nodes.ts.
 *
 * A stored `executionKind: "model"` therefore SUPPRESSES a metadata route key rather than losing to
 * it — an operator who deliberately took a node off its route gets what they asked for, and the
 * change is one auditable verb call rather than an invisible side effect of a metadata replace.
 */
export const resolveNodeExecution = (node: Pick<WorkspaceNode, "metadata" | "executionKind" | "route">): { executionKind: NodeExecutionKind; route?: NodeRoute } => {
  if (node.executionKind === "model") return { executionKind: "model" };
  if (node.executionKind === "deterministic") {
    const route = node.route ?? deriveRouteFromMetadata(node.metadata);
    // A row that says "deterministic" but names no route anywhere is not a reason to refuse or to
    // invent one: the era falls back to the stored field's own name, which is what a reader of the
    // ledger needs and what phase lookup already treats as "no manifest, leave the claim alone".
    return route ? { executionKind: "deterministic", route } : { executionKind: "deterministic" };
  }
  if (node.route) return { executionKind: "deterministic", route: node.route };
  const derived = deriveRouteFromMetadata(node.metadata);
  return derived ? { executionKind: "deterministic", route: derived } : { executionKind: "model" };
};

/**
 * DERIVE-ON-LOAD, for one release.
 *
 * Returns the fields a stored row should carry, given what it already carries. Positive declarations
 * only: a row whose metadata names no route gets `{}` back and stays exactly as it was. Called from
 * the store's node parse (mcp/workspace/store.ts) so every row that HAS a route ends up stating it as
 * a field — which is what a later `update_node_metadata` then cannot take away.
 */
export const deriveStoredExecutionFields = (node: Pick<WorkspaceNode, "metadata" | "executionKind" | "route">): { executionKind?: NodeExecutionKind; route?: NodeRoute } => {
  if (node.executionKind !== undefined) return { executionKind: node.executionKind, ...(node.route ? { route: node.route } : {}) };
  const route = node.route ?? deriveRouteFromMetadata(node.metadata);
  return route ? { executionKind: "deterministic", route } : {};
};
