import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { listOperationIds } from "../../../src/agent/operations/operationCatalog.js";
import { listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import {
  getOperationWorkflowBinding,
  listOperationWorkflowBindings,
  listBindingInputContractStatuses,
  resolveBindingInputContract,
  UNBOUND_OPERATION_IMPLEMENTING_TASK, listRequiredCapabilitiesForWorkflow } from "../../../src/agent/operations/operationWorkflowBindings.js";
import { listOperationExecutorBindings } from "../../../src/agent/operations/operationExecutorBindings.js";

describe("operationWorkflowBindings", () => {
  it("is deterministic and sorted by operationId across calls", () => {
    const first = listOperationWorkflowBindings().map((binding) => binding.operationId);
    const second = listOperationWorkflowBindings().map((binding) => binding.operationId);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort((a, b) => a.localeCompare(b)));
  });

  it("no operation is bound to a workflow id workflowRegistry.ts has not registered", () => {
    const registeredWorkflowIds = listRegisteredWorkflowIds();
    expect(registeredWorkflowIds.length).toBeGreaterThan(0);
    for (const binding of listOperationWorkflowBindings()) {
      expect(registeredWorkflowIds).toContain(binding.workflowId);
    }
  });

  // Milestone A remainder (A6) — the field-rename table is GONE, replaced by a builder: a rename
  // could map tenantId->projectId and autoApply->apply but never SUPPLY the `mode` and `brief`
  // brand_imagery_writer requires, and a row carrying both a rename and a builder is refused at
  // import (Platform renames before the builder runs — see operationWorkflowBindings.ts).
  it("binds visual_identity_review_change to the visual_identity workflow with an empty inputMapping and a declared initial-input builder", () => {
    const binding = getOperationWorkflowBinding("visual_identity_review_change");
    expect(binding).toEqual({
      operationId: "visual_identity_review_change",
      workflowId: "visual_identity",
      inputMapping: {},
      initialInputBuilder: {
        builderId: "visual_identity_review_change_brief_builder.v1",
        providesInitialInputFields: ["projectId", "mode", "brief", "apply"],
        requiredOperationFields: ["tenantId", "focus", "autoApply"]
      }
    });
  });

  it("binds pdf_template_family to the pdf_template_studio workflow with an empty inputMapping and a declared initial-input builder", () => {
    const binding = getOperationWorkflowBinding("pdf_template_family");
    expect(binding).toEqual({
      operationId: "pdf_template_family",
      workflowId: "pdf_template_studio",
      inputMapping: {},
      initialInputBuilder: {
        builderId: "pdf_template_family_brief_builder.v1",
        providesInitialInputFields: ["pdfTemplateFamilyBrief"],
        requiredOperationFields: ["tenantId", "familyId"]
      }
    });
  });

  // A8 (Milestone A remainder, runner 3b) — document_render is BOUND, builder-backed, and its
  // builder's declared contract is checked here the same way every other row's is.
  it("binds document_render to the document_render_studio workflow with an empty inputMapping and a declared initial-input builder", () => {
    const binding = getOperationWorkflowBinding("document_render");
    expect(binding).toEqual({
      operationId: "document_render",
      workflowId: "document_render_studio",
      inputMapping: {},
      initialInputBuilder: {
        builderId: "document_render_brief_builder.v1",
        providesInitialInputFields: ["documentRenderBrief"],
        requiredOperationFields: ["tenantId", "documentRef"]
      }
    });
  });

  // A5 (Milestone A remainder, runner 3c) — the last operation to be bound.
  it("binds asset_lookup_adopt to the asset_lookup_studio workflow with an empty inputMapping and a declared initial-input builder", () => {
    const binding = getOperationWorkflowBinding("asset_lookup_adopt");
    expect(binding).toEqual({
      operationId: "asset_lookup_adopt",
      workflowId: "asset_lookup_studio",
      inputMapping: {},
      initialInputBuilder: {
        builderId: "asset_lookup_adopt_brief_builder.v1",
        providesInitialInputFields: ["assetLookupBrief"],
        requiredOperationFields: ["tenantId", "query"]
      }
    });
  });

  it("no binding carries BOTH a rename table and a builder — Platform applies inputMapping before the builder runs, which would hide the builder's own required fields from it", () => {
    for (const binding of listOperationWorkflowBindings()) {
      if (binding.initialInputBuilder) expect(binding.inputMapping, `${binding.operationId} must not rename fields its builder reads`).toEqual({});
    }
  });

  it("listRequiredCapabilitiesForWorkflow answers from the bound operation's own descriptor, and null for a workflow no operation is bound to", () => {
    expect(listRequiredCapabilitiesForWorkflow("visual_identity")).toEqual(["visual_identity_propose", "visual_identity_read"]);
    expect(listRequiredCapabilitiesForWorkflow("pdf_template_studio")).toEqual(["pdf_template_publish", "pdf_template_write"]);
    expect(listRequiredCapabilitiesForWorkflow("image_template_revision_studio")).toEqual(["image_search", "image_template_write", "pdf_template_publish"]);
    expect(listRequiredCapabilitiesForWorkflow("document_render_studio")).toEqual(["pdf_render"]);
    expect(listRequiredCapabilitiesForWorkflow("asset_lookup_studio")).toEqual(["asset_search"]);
    expect(listRequiredCapabilitiesForWorkflow("publishing_conductor")).toBeNull();
    expect(listRequiredCapabilitiesForWorkflow(undefined)).toBeNull();
  });

  it("getOperationWorkflowBinding returns null (never a guess, never a throw) for every operation with no genuine implementing workflow today", () => {
    // A8 (Milestone A remainder) — document_render moved OUT of this set: documentRenderWorkflow.ts
    // registers document_render_studio and the binding below is real, exactly as A7 and A9 moved out
    // before it. site_inventory stays here for its own, different reason (it has a registered
    // EXECUTOR, not a workflow — see operationWorkflowBindings.ts's header).
    // A5 (Milestone A remainder) — asset_lookup_adopt moved out too; site_inventory is the ONLY id
    // left here, and for its own different reason: it has a registered EXECUTOR, not a workflow, so
    // getOperationWorkflowBinding correctly still returns null for it (see this module's header).
    const unboundOperationIds = ["site_inventory"];
    for (const operationId of unboundOperationIds) {
      expect(getOperationWorkflowBinding(operationId)).toBeNull();
    }
  });

  // A9 — image_template_revision is now BOUND to image_template_revision_studio (see
  // operationWorkflowBindings.ts's own header). Moved OUT of the unbound set above, mirroring A7's
  // own pdf_template_family precedent immediately below.
  // A10 — inputMapping is still EMPTY (nothing is renamed) and the binding now ALSO declares the
  // initial-input BUILDER that constructs the nested brief inputMapping structurally cannot express.
  it("binds image_template_revision to the image_template_revision_studio workflow, with an empty inputMapping and a declared initial-input builder", () => {
    const binding = getOperationWorkflowBinding("image_template_revision");
    expect(binding).toEqual({
      operationId: "image_template_revision",
      workflowId: "image_template_revision_studio",
      inputMapping: {},
      initialInputBuilder: {
        builderId: "image_template_revision_brief_builder.v1",
        providesInitialInputFields: ["imageTemplateRevisionBrief"],
        requiredOperationFields: ["tenantId", "templateRefs", "sourceAsset"]
      }
    });
  });

  // The public shape is DATA ONLY — a caller asking "is this bound" never receives a callable it
  // could invoke out of band, the same posture operationExecutorBindings.ts takes with its `run`.
  it("a declared initial-input builder is exposed as plain data, never as the live build function", () => {
    const binding = getOperationWorkflowBinding("image_template_revision")!;
    expect(Object.keys(binding.initialInputBuilder!).sort()).toEqual(["builderId", "providesInitialInputFields", "requiredOperationFields"]);
    expect("build" in binding.initialInputBuilder!).toBe(false);
  });

  it("a caller cannot mutate the module's own table through a returned binding's builder declaration", () => {
    const binding = getOperationWorkflowBinding("image_template_revision")!;
    (binding.initialInputBuilder!.requiredOperationFields as string[]).push("tampered");
    expect(getOperationWorkflowBinding("image_template_revision")!.initialInputBuilder!.requiredOperationFields).toEqual(["tenantId", "templateRefs", "sourceAsset"]);
  });

  // A7 — pdf_template_family is now BOUND to pdf_template_studio (see operationWorkflowBindings.ts's
  // own header). This is the counterpart of the test above, not a duplicate of it: this operation
  // moved OUT of the unbound set.

  it("getOperationWorkflowBinding returns null for an operation id nobody registered at all", () => {
    expect(getOperationWorkflowBinding("not_a_real_operation_xyz")).toBeNull();
  });

  it("every registered catalog operation is accounted for as exactly one of: workflow-bound, executor-bound (A4), or named with an implementing task — never more than one", () => {
    const workflowBoundIds = new Set(listOperationWorkflowBindings().map((binding) => binding.operationId));
    const executorBoundIds = new Set(listOperationExecutorBindings().map((binding) => binding.operationId));
    const unboundIds = new Set(Object.keys(UNBOUND_OPERATION_IMPLEMENTING_TASK));
    for (const operationId of listOperationIds()) {
      const memberships = [workflowBoundIds.has(operationId), executorBoundIds.has(operationId), unboundIds.has(operationId)];
      expect(memberships.filter(Boolean).length).toBe(1);
    }
  });

  it("a caller cannot mutate the module's own table through a returned binding's inputMapping", () => {
    const binding = getOperationWorkflowBinding("visual_identity_review_change");
    binding!.inputMapping.tenantId = "tampered";
    const again = getOperationWorkflowBinding("visual_identity_review_change");
    expect(again!.inputMapping).toEqual({});
  });

  // R1c — resolveBindingInputContract() / listBindingInputContractStatuses() close the gap
  // assertBindingIsSound never checked: that a binding's operation-side input, after inputMapping's
  // rename and the declared builder's construction, can actually satisfy the target workflow's entry
  // node(s). These tests ASSERT THE CURRENT REAL STATE, DELIBERATELY: until the Milestone A
  // remainder, visual_identity_review_change (rename-only, `mode`/`brief` never supplied) and
  // pdf_template_family (open entry schema, no builder — A10-D1's vacuous case) were both pinned
  // here as UNSATISFIED. Both now carry builders and both entry nodes name what they require, so the
  // assertions flipped — for a checked reason each, spelled out below. A future regression (a builder
  // removed, a required field added to an entry node, an operation field un-defaulted) flips them back.
  describe("R1c: binding input-contract status", () => {
    it("the visual_identity_review_change binding is SATISFIED — its builder supplies `mode` and `brief` (the references/brief anyOf) from the operation's own guaranteed fields", () => {
      const status = resolveBindingInputContract(getOperationWorkflowBinding("visual_identity_review_change")!);
      expect(status.resolved).toBe(true);
      expect(status.contract).not.toBeNull();
      expect(status.contract!.satisfied).toBe(true);
      expect(status.contract!.builderId).toBe("visual_identity_review_change_brief_builder.v1");
      expect(status.contract!.unsatisfiedBuilderOperationFields).toEqual([]);
      expect(status.contract!.builderProvidedTargetFields).toEqual(["apply", "brief", "mode", "projectId"]);
      const entryNodeCheck = status.contract!.entryNodeChecks.find((check) => check.nodeId === "brand_imagery_writer");
      expect(entryNodeCheck).toBeDefined();
      expect(entryNodeCheck!.unsatisfiedRequired).toEqual([]);
      expect(entryNodeCheck!.anyOfBranches).toEqual([["references"], ["brief"]]);
      expect(entryNodeCheck!.satisfiedAnyOfBranchIndex).toBe(1);
      expect(entryNodeCheck!.unsupportedConstructs).toEqual([]);
      expect(status.contract!.guaranteedTargetFields).toEqual(["apply", "brief", "mode", "projectId"]);
    });

    it("the pdf_template_family binding is SATISFIED — pdf_template_intake now names pdfTemplateFamilyBrief and the binding's declared builder is verified to supply exactly that", () => {
      const status = resolveBindingInputContract(getOperationWorkflowBinding("pdf_template_family")!);
      expect(status.resolved).toBe(true);
      expect(status.contract).not.toBeNull();
      expect(status.contract!.satisfied).toBe(true);
      expect(status.contract!.builderId).toBe("pdf_template_family_brief_builder.v1");
      expect(status.contract!.unsatisfiedBuilderOperationFields).toEqual([]);
      expect(status.contract!.builderProvidedTargetFields).toEqual(["pdfTemplateFamilyBrief"]);
      const entryNodeCheck = status.contract!.entryNodeChecks.find((check) => check.nodeId === "pdf_template_intake");
      expect(entryNodeCheck).toBeDefined();
      expect(entryNodeCheck!.unsatisfiedRequired).toEqual([]);
      expect(entryNodeCheck!.anyOfBranches).toEqual([["pdfTemplateFamilyBrief"], ["initialInput"]]);
      expect(entryNodeCheck!.satisfiedAnyOfBranchIndex).toBe(0);
      expect(entryNodeCheck!.unsupportedConstructs).toEqual([]);
      expect(entryNodeCheck!.satisfied).toBe(true);
    });

    // A10 — SATISFIED, and for a CHECKED reason, which is the whole point of the flip. The two
    // halves of the vacuous pass this test used to pin are both gone: image_revision_intake's own
    // inputSchema now NAMES `imageTemplateRevisionBrief` in a top-level `required` (so the checker
    // evaluates a real requirement instead of an open schema), and the binding declares an
    // initial-input builder whose `providesInitialInputFields` is exactly that field — credited only
    // because every one of its own `requiredOperationFields` is guaranteed by this operation's own
    // inputSchema/defaults (asserted below). Neither check was relaxed: open_schema_no_guaranteed_input
    // still fires for any binding whose entry node is open and whose row has no builder (see
    // bindingInputContract.test.ts) — none of the three real bindings is in that state any more.
    it("the image_template_revision binding is SATISFIED — its entry node names the brief it requires, and the binding's declared builder is verified to supply exactly that", () => {
      const status = resolveBindingInputContract(getOperationWorkflowBinding("image_template_revision")!);
      expect(status.resolved).toBe(true);
      expect(status.contract).not.toBeNull();
      expect(status.contract!.satisfied).toBe(true);
      // The builder's own precondition was checked, not assumed: nothing it needs is unguaranteed.
      expect(status.contract!.builderId).toBe("image_template_revision_brief_builder.v1");
      expect(status.contract!.unsatisfiedBuilderOperationFields).toEqual([]);
      expect(status.contract!.builderProvidedTargetFields).toEqual(["imageTemplateRevisionBrief"]);
      // Nothing is credited to inputMapping (still empty): the brief is the ONLY guaranteed field.
      expect(status.contract!.guaranteedTargetFields).toEqual(["imageTemplateRevisionBrief"]);
      const entryNodeCheck = status.contract!.entryNodeChecks.find((check) => check.nodeId === "image_revision_intake");
      expect(entryNodeCheck).toBeDefined();
      expect(entryNodeCheck!.unsatisfiedRequired).toEqual([]);
      // A REAL requirement was evaluated — not an open schema waved through.
      expect(entryNodeCheck!.unsupportedConstructs).toEqual([]);
      expect(entryNodeCheck!.satisfied).toBe(true);
    });

    it("listBindingInputContractStatuses() reports one resolved status per registered binding, in operationId order", () => {
      const statuses = listBindingInputContractStatuses();
      expect(statuses.map((status) => status.operationId)).toEqual(listOperationWorkflowBindings().map((binding) => binding.operationId));
      for (const status of statuses) expect(status.resolved).toBe(true);
    });

    it("resolveBindingInputContract never throws, even for a binding naming an operationId or workflowId this build cannot resolve (reported as resolved:false, contract:null)", () => {
      const status = resolveBindingInputContract({ operationId: "not_a_real_operation_xyz", workflowId: "not_a_real_workflow_xyz", inputMapping: {} });
      expect(status).toEqual({ operationId: "not_a_real_operation_xyz", workflowId: "not_a_real_workflow_xyz", resolved: false, contract: null });
    });
  });
});
