import { describe, expect, it } from "vitest";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { composeWorkflowNodes, isTailNode, publishingTailNodeIds } from "../../../src/agent/workspace/publishingTail.js";
import { getWorkflowDefinition, listRegisteredWorkflowIds, registerWorkflow } from "../../../src/agent/workspace/workflowRegistry.js";
import { __test__, publishingConductorWorkflowId } from "../../../src/agent/workspace/executor.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";

// §2.23 — minimal multi-workflow plumbing at the seam that matters. The registry carries SIX shipped
// entries: publishing_conductor (the canonical array), capture_conductor (since T12.9, registered by
// captureConductorWorkflow.ts), clone_conductor (since T13.1, registered by cloneConductorWorkflow.ts),
// visual_identity (C5, registered by visualIdentityWorkflow.ts), pdf_template_studio (A7, registered
// by pdfTemplateStudioWorkflow.ts), image_template_revision_studio (A9, registered by
// imageTemplateRevisionWorkflow.ts) — all side-effect-imported by executor.ts, which this file imports,
// so all six registrations are present here exactly as on every run-driving plane. A genuinely ABSENT
// workflowId (no second argument / `undefined`) still falls back to the publishing_conductor canonical
// set, byte-identical to every run before the registry existed; R1b (2026-09) closed the DIFFERENT
// case this file used to also call "unknown workflowId" — an EXPLICIT, non-empty id nobody
// registered — which no longer falls back to anything: see "refuses an unregistered EXPLICIT
// workflowId" below.

describe("§2.23 workflow registry", () => {
  it("ships publishing_conductor, capture_conductor, clone_conductor, visual_identity and pdf_template_studio as the registered workflows, resolving the canonical arrays", () => {
    expect(listRegisteredWorkflowIds()).toEqual([publishingConductorWorkflowId, "capture_conductor", "clone_conductor", "visual_identity", "pdf_template_studio", "image_template_revision_studio", "document_render_studio", "asset_lookup_studio"]);
    expect(getWorkflowDefinition(publishingConductorWorkflowId)?.canonicalNodes()).toEqual(listWorkspaceNodes());
    expect(getWorkflowDefinition("capture_conductor")?.canonicalNodes().map((node) => node.id)).toContain("capture_crawl");
    expect(getWorkflowDefinition("clone_conductor")?.canonicalNodes().map((node) => node.id)).toContain("clone_intake");
    // C5's pair — two nodes, no composed tail: visual_identity publishes nothing (visual_standard is
    // not a publishable type), so it is the first registered workflow that carries no tail node at all.
    expect(getWorkflowDefinition("visual_identity")?.canonicalNodes().map((node) => node.id)).toEqual(["brand_imagery_writer", "visual_standard_materializer"]);
    // A7 — the standalone PDF template studio: six nodes, also no composed tail (a pdf_template is
    // not a CMS-publishable type; see pdfTemplateStudioNodes.ts's own header).
    expect(getWorkflowDefinition("pdf_template_studio")?.canonicalNodes().map((node) => node.id)).toEqual([
      "pdf_template_intake",
      "pdf_template_designer",
      "pdf_template_mint",
      "pdf_template_publish",
      "pdf_template_library_deposit",
      "pdf_template_family_report"
    ]);
    // A9 — the standalone image-on-every-page batch operation's workflow: four nodes, also no
    // composed tail (its apply stage reuses pdf-tool's own template store, never a CMS
    // object_publish/release_to_production node).
    // A8 (Milestone A remainder) — document_render_studio: the two-node graph document_render's own
    // declared effect describes.
    expect(getWorkflowDefinition("document_render_studio")?.canonicalNodes().map((node) => node.id)).toEqual(["document_render_execute", "document_render_report"]);
    // A5 (Milestone A remainder) — asset_lookup_studio: one node per declared effect, read then write.
    expect(getWorkflowDefinition("asset_lookup_studio")?.canonicalNodes().map((node) => node.id)).toEqual(["asset_lookup_search", "asset_lookup_adopt"]);
    expect(getWorkflowDefinition("image_template_revision_studio")?.canonicalNodes().map((node) => node.id)).toEqual([
      "image_revision_intake",
      "image_revision_compile_preview",
      "image_revision_apply",
      "image_revision_report"
    ]);
    expect(getWorkflowDefinition("money_page")).toBeUndefined();
  });

  // REVIEW — R-17's rule ("dry-run outputs are DERIVED from each node's own output schema") only
  // holds if the derivation can actually satisfy the schema. brand_imagery_writer's outputSchema
  // declares a hex-pattern palette and a patternProperties-keyed aspectRatios map with
  // minProperties: 1, and mockValueFromSchema could satisfy neither — so every mock traversal of
  // visual_identity failed at the writer with output_schema_violation, and the materializer's own
  // "a mock run falls through so CI graph traversal keeps working" branch was unreachable in a real
  // run. Asserted across every registered workflow, so the next schema that outruns the generator
  // fails here rather than the first time somebody dry-runs it.
  it("every registered workflow's nodes have a dry-run output their own schema accepts", () => {
    for (const workflowId of listRegisteredWorkflowIds()) {
      for (const node of getWorkflowDefinition(workflowId)?.canonicalNodes() ?? []) {
        const mock = mockOutputForNode(node);
        const validation = validateOutput(mock, node.outputSchema);
        expect(validation.ok, `${workflowId}/${node.id}: ${JSON.stringify(validation.ok ? [] : validation.errors)}`).toBe(true);
      }
    }
  });

  it("refuses a duplicate registration", () => {
    expect(() => registerWorkflow({ workflowId: publishingConductorWorkflowId, canonicalNodes: listWorkspaceNodes })).toThrowError(/already registered: publishing_conductor/);
  });

  it("lets a future workflow register a composed node array (different upstream + the shared tail) and the executor resolve it by workflowId", async () => {
    const upstream = listWorkspaceNodes()
      .filter((node) => !isTailNode(node.id))
      .map((node) => ({ ...node, id: `money_${node.id}`, dependsOn: node.dependsOn.map((dependency) => `money_${dependency}`), requiredInputs: node.requiredInputs.map((input) => (input.includes(".") ? input : `money_${input}`)) }));
    const binding = {
      contract_intelligence: ["money_brief_architect"],
      artifact_plan: ["money_brief_architect", "money_draft_writer"],
      artifact_materializer: ["money_brief_architect"],
      article_body: ["money_review_aggregator", "money_draft_writer", "money_narrative_movement", "money_angle_strategy"]
    } as const;
    registerWorkflow({ workflowId: "money_page_test", canonicalNodes: () => composeWorkflowNodes(upstream, binding) });

    const resolved = await __test__.resolveConductorNodes(undefined, "money_page_test");
    expect(resolved.map((node) => node.id)).toEqual([...upstream.map((node) => node.id), ...publishingTailNodeIds]);
    expect(resolved.find((node) => node.id === "contract_intelligence")?.dependsOn).toEqual(["money_brief_architect"]);
    // The shared tail's publish gates travel with it.
    expect(resolved.find((node) => node.id === "publish_executor")?.riskLevel).toBe("publish");
  });

  it("keeps behavior byte-identical for existing runs: an ABSENT workflowId (no second argument) resolves the publishing_conductor canonical set", async () => {
    const resolved = await __test__.resolveConductorNodes(undefined);
    expect(resolved.map((node) => node.id)).toEqual(listWorkspaceNodes().map((node) => node.id));
  });

  // R1b — the defect this task closes. Before this change, resolveConductorNodes' fallback made no
  // distinction between "no workflowId at all" (legitimately publishing_conductor, above) and "an
  // explicit id nobody registered" — both resolved to the SAME full publishing_conductor array,
  // publish/release tail included. A caller naming a real, specific, wrong id got the DTC publishing
  // pipeline instead of an error telling it the id was wrong.
  it("refuses an unregistered EXPLICIT workflowId instead of silently substituting publishing_conductor's node array", async () => {
    await expect(__test__.resolveConductorNodes(undefined, "some_legacy_stamp")).rejects.toMatchObject({
      name: "WorkspaceToolError",
      code: "unknown_workflow",
      message: expect.stringContaining("some_legacy_stamp"),
      details: expect.objectContaining({
        requestedWorkflowId: "some_legacy_stamp",
        registeredWorkflowIds: listRegisteredWorkflowIds()
      })
    });
  });

  it("treats null and empty-string workflowId the same as absent — the legacy adapter, not a refusal", async () => {
    const nullResolved = await __test__.resolveConductorNodes(undefined, null);
    const emptyResolved = await __test__.resolveConductorNodes(undefined, "");
    expect(nullResolved.map((node) => node.id)).toEqual(listWorkspaceNodes().map((node) => node.id));
    expect(emptyResolved.map((node) => node.id)).toEqual(listWorkspaceNodes().map((node) => node.id));
  });
});
