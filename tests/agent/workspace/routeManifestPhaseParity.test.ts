// ROUTE MANIFEST PHASE PARITY (2026-09-17) — every deterministic STAGE the fleet can dispatch has a
// PHASE in its route manifest, so the verbs it speaks reach `declaredRouteVerbs()` and therefore the
// tenant policy every blocked-by-default tenant is minted and migrated with.
//
// WHAT WENT WRONG. `image_annotation` (#368/#377) shipped live-verified — bridge working, operation
// descriptor registered, workflow bound — and `operation_preflight {operationId:"image_annotation",
// tenantId:"zilberman"}` still reported `image_annotate: not_configured`, evidence
// `requiredToolName: "annotate_image"`. The tenant record was not stale: zilberman's `toolPolicies`
// was BYTE-IDENTICAL to what `tenantToolPolicies()` writes today. The FLEET DEFAULT was missing the
// verb, because the default is derived from `ROUTE_MANIFESTS` and image_annotation_studio's three
// stages had no phases there. `analyze_image_layout` and `check_image_text` were present only
// because v3 had hand-added them to the curated base map for a different feature — the hand-kept
// list the v4 derivation was introduced to end, still load-bearing.
//
// dr-lurie and platform reported zero gaps throughout, which is what kept this invisible: they run
// `defaultToolPolicy: "allowed"`, so they were never GRANTED the verb — they simply never gate on it.
//
// THE PROPERTY. Every deterministic stage declared by any registered workflow's canonical nodes
// resolves to a manifest phase. A new stage that forgets its phase fails HERE, naming the node and
// the stage, instead of stalling one blocked-by-default tenant at a time, months later, with an
// ok:true on every config write in between.
import { describe, expect, it } from "vitest";
// Side-effect import: executor.ts registers every workflow (publishing/capture/clone conductors plus
// the studio workflows), exactly as workflowRegistry.test.ts relies on.
import "../../../src/agent/workspace/executor.js";
import { getWorkflowDefinition, listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import { declaredRouteVerbs, routeManifestPhaseGaps, type RouteManifestPhaseGap } from "../../../src/agent/workspace/routeRegistry.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const everyCanonicalNode = (): WorkspaceNode[] =>
  listRegisteredWorkflowIds().flatMap((workflowId) => getWorkflowDefinition(workflowId)?.canonicalNodes() ?? []);

/**
 * The ONE gap that is a decision rather than an omission, in the shape tenantRouteParity.test.ts's
 * DECLARED_TENANT_EXCEPTIONS uses and for the same reason: without a written-down exception, a gap
 * and a decision look identical, which is how the pdf-template one survived for months.
 *
 * `publishExecutorDeterministic:execute` is the shared publishing tail's own route key and maps to no
 * manifest (`resolveRouteId` does not name it). Its single verb, `object_publish`, is already granted
 * fleet-wide by the curated base map AND gated three further ways — the publish-risk gate on the
 * node's own riskLevel, FORBIDDEN_PROJECT_VERBS pre-transport for every other node, and the project's
 * `publishEnabled` kill switch. Giving it a manifest would change `phaseTimeoutMsFor`'s answer for a
 * live publish route, which is a claim-timing change and not this change's business. Listed, not
 * fixed, so the next reader sees a decision rather than an oversight.
 */
const DECLARED_PHASE_EXCEPTIONS: Record<string, string> = {
  "publishExecutorDeterministic:execute":
    "the shared publishing tail's own route key, deliberately unmapped: object_publish is granted by the base map and gated three further ways, and minting a manifest would change claim timing on a live publish route"
};

const isDeclaredException = (gap: RouteManifestPhaseGap): boolean => gap.route in DECLARED_PHASE_EXCEPTIONS;

describe("route manifest phase parity", () => {
  it("covers the studio workflows whose stages this guard exists for", () => {
    const ids = listRegisteredWorkflowIds();
    expect(ids).toContain("image_annotation_studio");
    expect(ids).toContain("asset_lookup_studio");
    expect(ids).toContain("document_render_studio");
    expect(everyCanonicalNode().length).toBeGreaterThan(0);
  });

  it("gives every deterministic stage a phase in its route manifest", () => {
    const gaps = routeManifestPhaseGaps(everyCanonicalNode()).filter((gap) => !isDeclaredException(gap));
    // Named rather than counted: a failure has to tell the reader which node and which stage.
    expect(gaps.map((gap) => `${gap.route} (${gap.nodeId})`)).toEqual([]);
  });

  it("keeps every declared exception real — a stale entry is itself a defect", () => {
    const live = new Set(routeManifestPhaseGaps(everyCanonicalNode()).map((gap) => gap.route));
    expect(Object.keys(DECLARED_PHASE_EXCEPTIONS).filter((route) => !live.has(route))).toEqual([]);
  });

  it("carries image_annotation's own three bridge verbs into the derived tenant policy", () => {
    // The regression this whole change exists for, asserted at the surface the tenant policy reads.
    const verbs = declaredRouteVerbs();
    expect(verbs).toContain("annotate_image");
    expect(verbs).toContain("analyze_image_layout");
    expect(verbs).toContain("check_image_text");
  });
});
