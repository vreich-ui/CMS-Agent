import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import {
  listOperationExecutorBindings,
  getOperationExecutorBinding,
  getOperationExecutorRunner,
  checkExecutorInputContract,
  resolveExecutorInputContract,
  type OperationExecutorBinding
} from "../../../src/agent/operations/operationExecutorBindings.js";
import { SITE_INVENTORY_EXECUTOR_ID } from "../../../src/agent/operations/siteInventoryExecutor.js";

describe("operationExecutorBindings (A4)", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/agent/operations/operationWorkflowBindings.js");
    vi.resetModules();
  });

  it("is deterministic and sorted by operationId across calls", () => {
    const first = listOperationExecutorBindings().map((binding) => binding.operationId);
    const second = listOperationExecutorBindings().map((binding) => binding.operationId);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort((a, b) => a.localeCompare(b)));
  });

  it("registers exactly one binding today: site_inventory -> site_inventory_executor", () => {
    const bindings = listOperationExecutorBindings();
    expect(bindings).toEqual([
      { operationId: "site_inventory", executorId: SITE_INVENTORY_EXECUTOR_ID, inputSchema: expect.any(Object) }
    ]);
  });

  it("getOperationExecutorBinding returns the site_inventory binding without the live run function", () => {
    const binding = getOperationExecutorBinding("site_inventory");
    expect(binding).not.toBeNull();
    expect(binding!.executorId).toBe(SITE_INVENTORY_EXECUTOR_ID);
    expect((binding as unknown as Record<string, unknown>).run).toBeUndefined();
  });

  it("getOperationExecutorBinding returns null (never a guess, never a throw) for an unbound or unknown operationId", () => {
    expect(getOperationExecutorBinding("visual_identity_review_change")).toBeNull();
    expect(getOperationExecutorBinding("not_a_real_operation_xyz")).toBeNull();
  });

  it("getOperationExecutorRunner returns a callable function for site_inventory and null otherwise", () => {
    expect(typeof getOperationExecutorRunner("site_inventory")).toBe("function");
    expect(getOperationExecutorRunner("visual_identity_review_change")).toBeNull();
    expect(getOperationExecutorRunner("not_a_real_operation_xyz")).toBeNull();
  });

  it("a caller cannot mutate the module's own table through a returned binding's inputSchema", () => {
    const binding = getOperationExecutorBinding("site_inventory")!;
    (binding.inputSchema as Record<string, unknown>).required = ["tampered"];
    const again = getOperationExecutorBinding("site_inventory")!;
    expect(again.inputSchema.required).not.toEqual(["tampered"]);
  });

  describe("checkExecutorInputContract", () => {
    const binding: Pick<OperationExecutorBinding, "executorId" | "inputSchema"> = {
      executorId: "test_executor",
      inputSchema: { type: "object", required: ["tenantId", "objectType"] }
    };

    it("is satisfied when every required field is guaranteed present (required or defaulted) on the operation side, under the identical name", () => {
      const result = checkExecutorInputContract(binding, { requiredFields: ["tenantId"], defaultedFields: ["objectType"] });
      expect(result.satisfied).toBe(true);
      expect(result.unsatisfiedRequired).toEqual([]);
      expect(result.unsupportedConstructs).toEqual([]);
      expect(result.guaranteedFields).toEqual(["objectType", "tenantId"]);
    });

    it("is UNSATISFIED when a required field has no operation-side guarantee under that name (no rename to fall back on)", () => {
      const result = checkExecutorInputContract(binding, { requiredFields: ["tenantId"], defaultedFields: [] });
      expect(result.satisfied).toBe(false);
      expect(result.unsatisfiedRequired).toEqual(["objectType"]);
    });

    it("treats an unevaluated top-level requiredness keyword (e.g. anyOf) as UNSATISFIABLE, never silently satisfied", () => {
      const anyOfBinding: Pick<OperationExecutorBinding, "executorId" | "inputSchema"> = {
        executorId: "test_executor",
        inputSchema: { type: "object", required: ["tenantId"], anyOf: [{ required: ["a"] }, { required: ["b"] }] }
      };
      const result = checkExecutorInputContract(anyOfBinding, { requiredFields: ["tenantId"], defaultedFields: [] });
      expect(result.satisfied).toBe(false);
      expect(result.unsupportedConstructs).toEqual(["anyOf"]);
    });

    it("an executor with no required fields at all is trivially satisfied", () => {
      const noRequired: Pick<OperationExecutorBinding, "executorId" | "inputSchema"> = { executorId: "test_executor", inputSchema: { type: "object" } };
      const result = checkExecutorInputContract(noRequired, { requiredFields: [], defaultedFields: [] });
      expect(result.satisfied).toBe(true);
      expect(result.unsatisfiedRequired).toEqual([]);
    });
  });

  describe("resolveExecutorInputContract", () => {
    it("resolves the real site_inventory binding against the real site_inventory descriptor as satisfied (tenantId is required on both sides)", () => {
      const binding = listOperationExecutorBindings().find((entry) => entry.operationId === "site_inventory")!;
      // resolveExecutorInputContract needs the run function too; pull the full (private-shaped)
      // binding via getOperationExecutorRunner is not possible (it returns only the function), so
      // this exercises resolveExecutorInputContract's own null-resolution path plus the public
      // binding's contract-relevant fields directly through checkExecutorInputContract, which is
      // what resolveExecutorInputContract delegates to internally.
      const status = resolveExecutorInputContract({ ...binding, run: getOperationExecutorRunner("site_inventory")! });
      expect(status.resolved).toBe(true);
      expect(status.contract).not.toBeNull();
      expect(status.contract!.satisfied).toBe(true);
    });

    it("never throws for an operationId this build cannot resolve (reported as resolved:false, contract:null)", () => {
      const status = resolveExecutorInputContract({
        operationId: "not_a_real_operation_xyz" as never,
        executorId: "fake_executor",
        inputSchema: { type: "object" },
        run: async () => ({ ok: false, blockers: [] })
      });
      expect(status).toEqual({ operationId: "not_a_real_operation_xyz", executorId: "fake_executor", resolved: false, contract: null });
    });
  });

  // THE IMPORT-TIME MUTUAL-EXCLUSIVITY ASSERTION. operationExecutorBindings.ts checks its own
  // BINDINGS table against operationWorkflowBindings.ts's live table AT MODULE EVALUATION TIME (not
  // inside any exported function), so the only way to observe it firing is to force a fresh
  // evaluation of the module under a workflow-bindings table that conflicts with it. We mock
  // operationWorkflowBindings.js to claim "site_inventory" (operationExecutorBindings.ts's one real
  // binding) is ALSO workflow-bound, then force a fresh module graph and dynamically import
  // operationExecutorBindings.ts: its own top-level loop must throw before the import resolves.
  it("throws AT IMPORT when an operation is bound to both a workflow and an executor", async () => {
    vi.resetModules();
    vi.doMock("../../../src/agent/operations/operationWorkflowBindings.js", () => ({
      listOperationWorkflowBindings: () => [{ operationId: "site_inventory", workflowId: "fake_workflow_for_this_test", inputMapping: {} }]
    }));
    await expect(import("../../../src/agent/operations/operationExecutorBindings.js")).rejects.toThrow(
      /operation "site_inventory" is bound to BOTH a workflow.*and an executor/
    );
  });
});
