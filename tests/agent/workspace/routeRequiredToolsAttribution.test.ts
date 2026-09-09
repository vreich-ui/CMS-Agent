import { describe, expect, it } from "vitest";
import { ROUTE_MANIFESTS, routeRequiredToolsFor } from "../../../src/agent/workspace/routeRegistry.js";
import { auditNodeCapabilities, summarizeCapabilityAudit } from "../../../src/agent/workspace/nodeCapabilityAudit.js";
import { __test__ } from "../../../src/agent/workspace/executor.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// ACCEPTANCE — W3.2.0 (2026-09-09).
//
// W3.1 landed the route manifests with four stages marked `requiredToolsUnverified`: capture's
// emit_live and clone's pdf_intake / pdf_mint / pdf_publish. That marker is an honest statement —
// "this stage reaches the tenant and we did not establish which verbs" — and it is exactly the state
// a choke point cannot work from: a gate that does not know what a route legitimately calls can only
// fail open on every call it sees.
//
// So this is the first task of W3.2 and it comes before the choke point itself. The four stages were
// attributed by reading the code the conductor actually dispatches, not by inference from names:
//
//   capture emit_live  -> captureEmitStep(live:true) -> executeEmission (capture/engine/emit.mjs).
//                         Fourteen `transport.call(...)` sites, every verb a string literal, nine
//                         distinct. No dynamic dispatch, so the list is exhaustive.
//   clone pdf_intake   -> pdfTemplateIntakeStep. Synchronous, takes no deps, reads run.initialInput.
//                         It calls nothing, which is a different fact from "unverified".
//   clone pdf_mint     -> pdfTemplateMintStep -> callProjectTool x3 (create/validate/get validation).
//   clone pdf_publish  -> pdfTemplatePublishStep -> callProjectTool("publish_pdf_template").
//
// What this does NOT claim: that every deterministic route in the system now has a manifest. The
// publishing-tail routes (publish_payload, publication_controller, publish_executor,
// learning_recorder, contract_intelligence, placement_resolver) still resolve to no routeId at all,
// which the audit distinguishes from "makes no tenant calls" by the ABSENCE of routeId — see
// nodeCapabilityAudit.ts's header. Their verbs come from per-tenant publish hooks and are not
// statically attributable from this repository alone; the choke point treats an unmanifested route as
// fail-open and records the call regardless.

const node = (over: Partial<WorkspaceNode>): WorkspaceNode => ({
  id: "n", name: "n", kind: "executor", description: "", prompt: "",
  inputSchema: {}, outputSchema: {}, allowedTools: [], produces: [], dependsOn: [],
  ...over
} as unknown as WorkspaceNode);

describe("W3.2.0 — no route stage is left unattributed", () => {
  // The headline acceptance: `workspace.audit_capabilities` names no engineToolsUnverified node.
  it("leaves no phase in any manifest marked requiredToolsUnverified", () => {
    const open = ROUTE_MANIFESTS.flatMap((manifest) =>
      manifest.phases.filter((phase) => phase.requiredToolsUnverified).map((phase) => `${manifest.id}:${phase.id}`)
    );
    expect(open).toEqual([]);
  });

  it("reports no engineToolsUnverified node across every conductor workflow", async () => {
    const seen = new Map<string, WorkspaceNode>();
    for (const workflowId of ["publishing_conductor", "capture_conductor", "clone_conductor", "visual_identity"]) {
      for (const resolved of await __test__.resolveConductorNodes(undefined, workflowId)) {
        if (!seen.has(resolved.id)) seen.set(resolved.id, resolved);
      }
    }
    const unverified = [...seen.values()].map(auditNodeCapabilities).filter((audit) => audit.engineToolsUnverified).map((audit) => audit.nodeId);
    expect(unverified).toEqual([]);
    // The rest of the graph is unmoved: the same 51 nodes, the same 23 deterministic ones. W3.2.0
    // changed what is KNOWN about four stages, not what any node is or does.
    const summary = summarizeCapabilityAudit([...seen.values()]);
    expect(summary.nodeCount).toBe(51);
    expect(summary.deterministicNodes).toBe(23);
  });
});

describe("W3.2.0 — the attributed verbs, per stage", () => {
  it("capture emit_live: nine verbs, none of them publish or admin risk", () => {
    const verbs = routeRequiredToolsFor("capture_stage", "emit_live");
    expect(verbs?.map((tool) => tool.verb)).toEqual([
      "object_inventory", "object_contract", "object_get", "object_validate",
      "object_create", "object_checkout", "object_patch", "object_checkin", "create_artifact_from_url"
    ]);
    // The emitter refuses object_publish / release_to_production / trigger_netlify_build / deploy
    // pre-transport (buildAdapterTransport, captureEngine.ts), and this list is the evidence for it:
    // capture creates drafts and never publishes them.
    expect(verbs?.some((tool) => tool.risk === "publish" || tool.risk === "admin")).toBe(false);
  });

  it("clone pdf_intake calls nothing, and says so rather than leaving it open", () => {
    expect(routeRequiredToolsFor("clone_stage", "pdf_intake")).toEqual([]);
    const audit = auditNodeCapabilities(node({ id: "pdf_template_intake", metadata: { cloneStageDeterministic: "pdf_intake" } }));
    expect(audit.engineToolsUnverified).toBeUndefined();
    expect(audit.findings).toEqual([]);
  });

  it("clone pdf_mint: create, validate, poll", () => {
    expect(routeRequiredToolsFor("clone_stage", "pdf_mint")?.map((tool) => tool.verb))
      .toEqual(["create_pdf_template", "validate_pdf_template", "get_pdf_template_validation"]);
  });

  it("clone pdf_publish reaches one publish-risk verb, and the audit now names it", () => {
    expect(routeRequiredToolsFor("clone_stage", "pdf_publish")?.map((tool) => tool.verb)).toEqual(["publish_pdf_template"]);
    const audit = auditNodeCapabilities(node({
      id: "pdf_template_publish",
      riskLevel: "publish",
      metadata: { cloneStageDeterministic: "pdf_publish" }
    }));
    const highRisk = audit.findings.find((finding) => finding.code === "high_risk_engine_verb");
    expect(highRisk).toBeDefined();
    expect((highRisk as { verbs: string[] }).verbs).toEqual(["publish_pdf_template"]);
  });

  // The per-stage model is what makes the above safe to state: a sibling stage on the same route must
  // not inherit these verbs. pdf_intake and pdf_mint share clone_stage with theme_bind, whose one
  // admin verb restyles a whole site.
  it("does not leak a stage's verbs to its siblings", () => {
    expect(routeRequiredToolsFor("clone_stage", "pdf_mint")?.map((tool) => tool.verb)).not.toContain("site_apply_theme");
    expect(routeRequiredToolsFor("capture_stage", "emit_dry")).toEqual([]);
  });
});
