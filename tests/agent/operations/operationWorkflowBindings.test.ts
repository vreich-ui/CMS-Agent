import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { listOperationIds } from "../../../src/agent/operations/operationCatalog.js";
import { listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import {
  getOperationWorkflowBinding,
  listOperationWorkflowBindings,
  listBindingInputContractStatuses,
  resolveBindingInputContract,
  UNBOUND_OPERATION_IMPLEMENTING_TASK
} from "../../../src/agent/operations/operationWorkflowBindings.js";
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

  it("binds visual_identity_review_change to the visual_identity workflow with a field-rename inputMapping", () => {
    const binding = getOperationWorkflowBinding("visual_identity_review_change");
    expect(binding).toEqual({
      operationId: "visual_identity_review_change",
      workflowId: "visual_identity",
      inputMapping: { tenantId: "projectId", autoApply: "apply" }
    });
  });

  it("getOperationWorkflowBinding returns null (never a guess, never a throw) for every operation with no genuine implementing workflow today", () => {
    const unboundOperationIds = ["site_inventory", "document_render", "asset_lookup_adopt"];
    for (const operationId of unboundOperationIds) {
      expect(getOperationWorkflowBinding(operationId)).toBeNull();
    }
  });

  // A9 — image_template_revision is now BOUND to image_template_revision_studio (see
  // operationWorkflowBindings.ts's own header). Moved OUT of the unbound set above, mirroring A7's
  // own pdf_template_family precedent immediately below.
  it("binds image_template_revision to the image_template_revision_studio workflow, with a deliberately empty inputMapping", () => {
    const binding = getOperationWorkflowBinding("image_template_revision");
    expect(binding).toEqual({
      operationId: "image_template_revision",
      workflowId: "image_template_revision_studio",
      inputMapping: {}
    });
  });

  // A7 — pdf_template_family is now BOUND to pdf_template_studio (see operationWorkflowBindings.ts's
  // own header). This is the counterpart of the test above, not a duplicate of it: this operation
  // moved OUT of the unbound set.
  it("binds pdf_template_family to the pdf_template_studio workflow, with a deliberately empty inputMapping", () => {
    const binding = getOperationWorkflowBinding("pdf_template_family");
    expect(binding).toEqual({
      operationId: "pdf_template_family",
      workflowId: "pdf_template_studio",
      inputMapping: {}
    });
  });

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
    expect(again!.inputMapping.tenantId).toBe("projectId");
  });

  // R1c — resolveBindingInputContract() / listBindingInputContractStatuses() close the gap
  // assertBindingIsSound never checked: that a binding's operation-side input, after inputMapping's
  // rename, can actually satisfy the target workflow's entry node(s). THIS TEST ASSERTS THE CURRENT
  // REAL STATE, DELIBERATELY, SO IT FLIPS TO PASSING THE MOMENT SOMEONE REPAIRS THE BINDING: today
  // visual_identity_review_change's binding maps only {tenantId->projectId, autoApply->apply}, but
  // brand_imagery_writer (visual_identity's entry node — the only node in the workflow with an empty
  // dependsOn) requires `mode` and one of `references`/`brief`, none of which the mapping ever
  // supplies. If a future change to either the operation's own inputSchema/defaults, the binding's
  // inputMapping, or brand_imagery_writer's own inputSchema closes that gap, `satisfied` here becomes
  // true and this assertion (not a throw, not a silent pass) is what will tell a reader that happened.
  describe("R1c: binding input-contract status", () => {
    it("the real visual_identity_review_change binding is detected as incomplete: KNOWN-INCOMPLETE, not working, naming mode and the references/brief anyOf", () => {
      const status = resolveBindingInputContract(getOperationWorkflowBinding("visual_identity_review_change")!);
      expect(status.resolved).toBe(true);
      expect(status.contract).not.toBeNull();
      // THE ASSERTION THAT MATTERS: this is currently false. A change that makes it true is the
      // binding being repaired, not this test being wrong — see the comment above.
      expect(status.contract!.satisfied).toBe(false);
      const entryNodeCheck = status.contract!.entryNodeChecks.find((check) => check.nodeId === "brand_imagery_writer");
      expect(entryNodeCheck).toBeDefined();
      expect(entryNodeCheck!.unsatisfiedRequired).toEqual(["mode"]);
      expect(entryNodeCheck!.anyOfBranches).toEqual([["references"], ["brief"]]);
      expect(entryNodeCheck!.satisfiedAnyOfBranchIndex).toBeNull();
      expect(entryNodeCheck!.unsupportedConstructs).toEqual([]);
      expect(status.contract!.guaranteedTargetFields).toEqual(["apply", "projectId"]);
    });

    // A10-D1 (was: "the OPPOSITE case from visual_identity_review_change's... genuinely SATISFIED").
    // It was not — it was a VACUOUS pass: pdf_template_studio's entry node (pdf_template_intake)
    // uses the permissive openInput schema (no declared `required` array) because it reads a NESTED
    // initialInput.pdfTemplateFamilyBrief its schema never names, and the empty inputMapping
    // guarantees the node NOTHING under any name — there was no structural evidence of delivery to
    // check at all, in either direction, and this test used to read that absence of a check as a
    // pass. bindingInputContract.ts's checkEntryNode now treats "open schema + zero guaranteed
    // fields" as itself unsatisfied (see its own comment), so this binding correctly reports
    // unsatisfied until a real executor supplies the brief or the entry node's schema is taught to
    // require it.
    it("the pdf_template_family binding is detected as UNSATISFIED — its entry node's permissive schema gives the empty inputMapping nothing to prove", () => {
      const status = resolveBindingInputContract(getOperationWorkflowBinding("pdf_template_family")!);
      expect(status.resolved).toBe(true);
      expect(status.contract).not.toBeNull();
      expect(status.contract!.satisfied).toBe(false);
      const entryNodeCheck = status.contract!.entryNodeChecks.find((check) => check.nodeId === "pdf_template_intake");
      expect(entryNodeCheck).toBeDefined();
      expect(entryNodeCheck!.unsatisfiedRequired).toEqual([]);
      expect(entryNodeCheck!.unsupportedConstructs).toEqual(["open_schema_no_guaranteed_input"]);
      expect(entryNodeCheck!.satisfied).toBe(false);
    });

    // A10-D1 (was: "A9 — same shape as pdf_template_family's precedent immediately above... the
    // empty inputMapping trivially satisfies it."). Same vacuous pass, same fix: image_revision_intake
    // (image_template_revision_studio's entry node) uses the permissive openInput schema for the
    // identical reason pdf_template_intake does — it reads a NESTED
    // initialInput.imageTemplateRevisionBrief its schema never names — so checkEntryNode's
    // open_schema_no_guaranteed_input check now catches this binding too.
    it("the image_template_revision binding is detected as UNSATISFIED — its entry node's permissive schema gives the empty inputMapping nothing to prove", () => {
      const status = resolveBindingInputContract(getOperationWorkflowBinding("image_template_revision")!);
      expect(status.resolved).toBe(true);
      expect(status.contract).not.toBeNull();
      expect(status.contract!.satisfied).toBe(false);
      const entryNodeCheck = status.contract!.entryNodeChecks.find((check) => check.nodeId === "image_revision_intake");
      expect(entryNodeCheck).toBeDefined();
      expect(entryNodeCheck!.unsatisfiedRequired).toEqual([]);
      expect(entryNodeCheck!.unsupportedConstructs).toEqual(["open_schema_no_guaranteed_input"]);
      expect(entryNodeCheck!.satisfied).toBe(false);
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
