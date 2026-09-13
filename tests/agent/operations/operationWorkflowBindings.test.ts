import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { listOperationIds } from "../../../src/agent/operations/operationCatalog.js";
import { listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import {
  getOperationWorkflowBinding,
  listOperationWorkflowBindings,
  UNBOUND_OPERATION_IMPLEMENTING_TASK
} from "../../../src/agent/operations/operationWorkflowBindings.js";

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

  it("every registered catalog operation is accounted for as exactly bound or exactly named with an implementing task, never both", () => {
    const boundIds = new Set(listOperationWorkflowBindings().map((binding) => binding.operationId));
    const unboundIds = new Set(Object.keys(UNBOUND_OPERATION_IMPLEMENTING_TASK));
    for (const operationId of listOperationIds()) {
      expect(boundIds.has(operationId) && unboundIds.has(operationId)).toBe(false);
      expect(boundIds.has(operationId) || unboundIds.has(operationId)).toBe(true);
    }
  });

  it("a caller cannot mutate the module's own table through a returned binding's inputMapping", () => {
    const binding = getOperationWorkflowBinding("visual_identity_review_change");
    binding!.inputMapping.tenantId = "tampered";
    const again = getOperationWorkflowBinding("visual_identity_review_change");
    expect(again!.inputMapping.tenantId).toBe("projectId");
  });
});
