// T5 (2026-08-26) — STABLE GATE IDS for every publish-risk gate a run can raise.
//
// THE DEFECT. A gate surfaced as an `approvalsRequired[]` entry carrying a nodeId and a prose
// `reason`, and nothing else. Two consequences, both live:
//   1. An operator who wants ONE gate switched to manual approval has nothing to name. `nodeId` is
//      close, but it is not an address: `publish_executor` is a node id THREE workflows share (the
//      shared publishing tail is the point — publishingTail.ts / workflowRegistry.ts), so "hold
//      publish_executor" cannot mean "hold clone's" without also meaning "hold the article path's".
//   2. Run 01's approval demanded a decision at `pdf_template_publish` with `siteId: null` and zero
//      entries — a branch with nothing in it consumed a gate. Diagnosing that required reading prose.
//
// THE OPERATING PRINCIPLE THIS SERVES, and the reason this is a registry rather than a string built
// at each call site: agents publish and operate autonomously by default; manual approval is a mode
// the operator may switch ON, not the resting state. A mode that can only be switched on for a WHOLE
// RUN is not a mode anyone will use — it is the blunt instrument that keeps human involvement from
// falling. Per-gate addressability is what makes "hold exactly this one" expressible, so the rest of
// the run keeps running.
//
// SHAPE, and why (workflowId, nodeId) rather than nodeId alone: see consequence 1 above. The gate id
// is `gate.<workflow>.<node>`, with the workflow segment abbreviated to the studio/capture/publishing
// name rather than the full registered id, because these strings are typed by operators.
//
// THIS IS A CODE-DECLARED TABLE, exactly like publishableTypeCharter.ts's charter table and
// workflowRegistry.ts's own per-workflow entries, and for the same reason: which gates exist is a
// property of the composition, never a tenant-patchable field. A project does not get to invent, or
// quietly delete, a gate.
//
// CONFORMANCE. publishGateConformanceIssues below is the floor: every publish-risk node in a
// registered workflow's node array must resolve to a gate id here. gateRegistry.test.ts runs it over
// listRegisteredWorkflowIds(), so adding a publish-risk node — or registering a fourth workflow that
// composes the tail — without declaring its gate FAILS THE BUILD rather than shipping an
// unaddressable gate. That is T5's acceptance criterion stated as a test rather than as a convention.
import type { WorkspaceNode } from "./nodeTypes.js";

export type PublishGateDefinition = {
  gateId: string;
  workflowId: string;
  nodeId: string;
  // Quotable in an approval entry / a blocked output — what this gate is actually holding.
  description: string;
};

// The workflow segment of a gate id. Deliberately short and stable: an operator types these.
const WORKFLOW_GATE_SEGMENT: Record<string, string> = {
  publishing_conductor: "publishing",
  capture_conductor: "capture",
  clone_conductor: "clone"
};

const gate = (workflowId: string, nodeId: string, description: string): PublishGateDefinition => ({
  gateId: `gate.${WORKFLOW_GATE_SEGMENT[workflowId] ?? workflowId}.${nodeId}`,
  workflowId,
  nodeId,
  description
});

// The three tail gates every tail-composing workflow shares, declared PER WORKFLOW rather than once,
// because that separation is the whole point (consequence 1 in the header).
const tailGates = (workflowId: string, what: string): PublishGateDefinition[] => [
  gate(workflowId, "publication_controller", `Run-scoped go/no-go on ${what} before any publish call is made.`),
  gate(workflowId, "publish_executor", `The publish call itself for ${what}.`),
  gate(workflowId, "release_executor", `release_to_production for ${what} — the go-live, downstream of the publish.`)
];

const GATE_REGISTRY: readonly PublishGateDefinition[] = [
  ...tailGates("publishing_conductor", "a DTC article/page client object"),
  ...tailGates("capture_conductor", "the objects a capture run's emit_live stage minted"),
  ...tailGates("clone_conductor", "the structure a studio run minted (section_template, page template, theme, the site singleton)"),
  // T15.34 (#210) — the pdf-template branch is riskLevel "publish" WITHOUT composing the shared tail
  // (see cloneConductorNodes.ts's own note on why). It is a gate for exactly the same reason the tail
  // nodes are — it passes through the executor's publish-risk dispatch guard — so it is addressable
  // for exactly the same reason.
  gate("clone_conductor", "pdf_template_publish", "publish_pdf_template for the pdf-tool templates a studio run minted. Not a CMS release: pdf-tool publication never triggers a production build.")
];

const byWorkflowAndNode = new Map(GATE_REGISTRY.map((definition) => [`${definition.workflowId} ${definition.nodeId}`, definition]));

export const listPublishGates = (): readonly PublishGateDefinition[] => GATE_REGISTRY;
export const listKnownGateIds = (): string[] => GATE_REGISTRY.map((definition) => definition.gateId);

/**
 * The stable gate id for one publish-risk node of one workflow, or undefined when the pair is not a
 * declared gate. Deliberately returns undefined rather than synthesizing an id: a synthesized id
 * would be an address no operator could have been told about, and one the conformance check below
 * could never fail on — which is the whole failure mode this registry exists to end.
 */
export function resolveGateId(workflowId: string | undefined, nodeId: string): string | undefined {
  if (!workflowId) return undefined;
  return byWorkflowAndNode.get(`${workflowId} ${nodeId}`)?.gateId;
}

export function resolvePublishGate(workflowId: string | undefined, nodeId: string): PublishGateDefinition | undefined {
  if (!workflowId) return undefined;
  return byWorkflowAndNode.get(`${workflowId} ${nodeId}`);
}

/**
 * Conformance, in the vein of publishingTail.ts's publishingTailConformanceIssues and
 * publishableTypeCharter.ts's recipeAuthorityConformanceIssues: every node this workflow can raise a
 * gate on must have a declared gate id. "Can raise a gate" is riskLevel — the same semantic property
 * the executor's own publish-risk dispatch guard (isPublishRisk) matches on, never a hardcoded id
 * list, so a future publish-risk node is caught by construction.
 */
export function publishGateConformanceIssues(nodes: readonly WorkspaceNode[], workflowId: string): string[] {
  const issues: string[] = [];
  for (const node of nodes) {
    if (node.riskLevel !== "publish" && node.riskLevel !== "admin") continue;
    if (resolveGateId(workflowId, node.id)) continue;
    issues.push(`${node.id}: workflow "${workflowId}" can raise a gate on this riskLevel "${node.riskLevel}" node, but gateRegistry.ts declares no gate id for it — an operator switching one gate to manual would have no way to name it.`);
  }
  return issues;
}
