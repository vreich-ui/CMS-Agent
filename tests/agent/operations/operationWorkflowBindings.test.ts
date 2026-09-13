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
    const unboundOperationIds = ["site_inventory", "pdf_template_family", "document_render", "asset_lookup_adopt", "image_template_revision"];
    for (const operationId of unboundOperationIds) {
      expect(getOperationWorkflowBinding(operationId)).toBeNull();
    }
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
