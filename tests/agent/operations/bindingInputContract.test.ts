import { describe, expect, it } from "vitest";
import { checkBindingInputContract, resolveWorkflowEntryNodes, type OperationInputContractSource } from "../../../src/agent/operations/bindingInputContract.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// A minimal, valid WorkspaceNode fixture — only the fields checkBindingInputContract /
// resolveWorkflowEntryNodes actually read (id, dependsOn, inputSchema) are varied per test; the rest
// are filled with harmless placeholders so the type checker is satisfied without pulling in the real
// node literals.
const node = (overrides: Partial<WorkspaceNode> & Pick<WorkspaceNode, "id" | "dependsOn" | "inputSchema">): WorkspaceNode => ({
  name: overrides.id,
  kind: "drafting",
  description: "fixture",
  prompt: "fixture",
  outputSchema: {},
  allowedTools: [],
  requiredInputs: [],
  produces: [],
  riskLevel: "read",
  status: "active",
  position: { x: 0, y: 0 },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

describe("bindingInputContract", () => {
  describe("resolveWorkflowEntryNodes", () => {
    it("returns exactly the nodes with an empty dependsOn, never a hardcoded id", () => {
      const nodes = [
        node({ id: "a", dependsOn: [], inputSchema: {} }),
        node({ id: "b", dependsOn: ["a"], inputSchema: {} }),
        node({ id: "c", dependsOn: [], inputSchema: {} })
      ];
      expect(resolveWorkflowEntryNodes(nodes).map((n) => n.id)).toEqual(["a", "c"]);
    });

    it("returns an empty array when every node has a dependency (a workflow-authoring defect, not silently ignored)", () => {
      const nodes = [node({ id: "a", dependsOn: ["b"], inputSchema: {} }), node({ id: "b", dependsOn: ["a"], inputSchema: {} })];
      expect(resolveWorkflowEntryNodes(nodes)).toEqual([]);
    });
  });

  describe("checkBindingInputContract", () => {
    const source = (requiredFields: string[], defaultedFields: string[] = []): OperationInputContractSource => ({ requiredFields, defaultedFields });

    it("is satisfied when the mapped guaranteed input covers every plain `required` field on the entry node", () => {
      const nodes = [node({ id: "entry", dependsOn: [], inputSchema: { required: ["mode", "siteId"] } })];
      const result = checkBindingInputContract(
        "wf",
        { tenantId: "siteId", kind: "mode" },
        source(["tenantId"], ["kind"]),
        nodes
      );
      expect(result.satisfied).toBe(true);
      expect(result.guaranteedTargetFields).toEqual(["mode", "siteId"]);
      expect(result.entryNodeChecks).toEqual([
        { nodeId: "entry", unsatisfiedRequired: [], anyOfBranches: null, satisfiedAnyOfBranchIndex: null, unsupportedConstructs: [], satisfied: true }
      ]);
    });

    it("reports unsatisfiable when a plain `required` field on the entry node has no mapped equivalent", () => {
      const nodes = [node({ id: "entry", dependsOn: [], inputSchema: { required: ["mode", "siteId"] } })];
      // "mode" has no mapping at all — the operation never supplies it under any name.
      const result = checkBindingInputContract("wf", { tenantId: "siteId" }, source(["tenantId"]), nodes);
      expect(result.satisfied).toBe(false);
      expect(result.entryNodeChecks[0].unsatisfiedRequired).toEqual(["mode"]);
    });

    it("handles a top-level anyOf: satisfied when the guaranteed set fully covers at least one branch", () => {
      const nodes = [node({ id: "entry", dependsOn: [], inputSchema: { anyOf: [{ required: ["references"] }, { required: ["brief"] }] } })];
      const result = checkBindingInputContract("wf", { brief: "brief" }, source([], ["brief"]), nodes);
      expect(result.satisfied).toBe(true);
      expect(result.entryNodeChecks[0].anyOfBranches).toEqual([["references"], ["brief"]]);
      expect(result.entryNodeChecks[0].satisfiedAnyOfBranchIndex).toBe(1);
    });

    it("handles a top-level anyOf: unsatisfiable when the guaranteed set covers no branch", () => {
      const nodes = [node({ id: "entry", dependsOn: [], inputSchema: { anyOf: [{ required: ["references"] }, { required: ["brief"] }] } })];
      const result = checkBindingInputContract("wf", { tenantId: "projectId" }, source(["tenantId"]), nodes);
      expect(result.satisfied).toBe(false);
      expect(result.entryNodeChecks[0].satisfiedAnyOfBranchIndex).toBeNull();
    });

    it("an anyOf branch requiring MULTIPLE fields is satisfied only when the guaranteed set covers all of them", () => {
      const nodes = [node({ id: "entry", dependsOn: [], inputSchema: { anyOf: [{ required: ["a", "b"] }] } })];
      const partiallyMapped = checkBindingInputContract("wf", { x: "a" }, source(["x"]), nodes);
      expect(partiallyMapped.satisfied).toBe(false);
      const fullyMapped = checkBindingInputContract("wf", { x: "a", y: "b" }, source(["x", "y"]), nodes);
      expect(fullyMapped.satisfied).toBe(true);
    });

    it("an unevaluatable top-level construct (oneOf) is reported unsatisfiable, never silently passed", () => {
      const nodes = [node({ id: "entry", dependsOn: [], inputSchema: { oneOf: [{ required: ["a"] }] } })];
      const result = checkBindingInputContract("wf", { x: "a" }, source(["x"]), nodes);
      expect(result.satisfied).toBe(false);
      expect(result.entryNodeChecks[0].unsupportedConstructs).toContain("oneOf");
    });

    it("an anyOf branch shaped as something other than exactly {required:[...]} is reported unsatisfiable, not silently matched", () => {
      const nodes = [
        node({ id: "entry", dependsOn: [], inputSchema: { anyOf: [{ required: ["a"], properties: { a: { type: "string" } } }] } })
      ];
      const result = checkBindingInputContract("wf", { x: "a" }, source(["x"]), nodes);
      expect(result.satisfied).toBe(false);
      expect(result.entryNodeChecks[0].unsupportedConstructs).toEqual(["anyOf[0]"]);
      // Never falls back to reporting the branch as satisfied just because its `required` half
      // happened to be coverable.
      expect(result.entryNodeChecks[0].satisfiedAnyOfBranchIndex).toBeNull();
    });

    it("no entry node resolved (every node has a dependency) is unsatisfiable, never vacuously satisfied", () => {
      const nodes = [node({ id: "a", dependsOn: ["b"], inputSchema: {} }), node({ id: "b", dependsOn: ["a"], inputSchema: {} })];
      const result = checkBindingInputContract("wf", {}, source([]), nodes);
      expect(result.satisfied).toBe(false);
      expect(result.entryNodeChecks).toEqual([]);
    });

    it("a workflow with multiple entry nodes requires every one of them to be satisfied", () => {
      const nodes = [
        node({ id: "e1", dependsOn: [], inputSchema: { required: ["a"] } }),
        node({ id: "e2", dependsOn: [], inputSchema: { required: ["b"] } })
      ];
      const onlyOneMapped = checkBindingInputContract("wf", { x: "a" }, source(["x"]), nodes);
      expect(onlyOneMapped.satisfied).toBe(false);
      expect(onlyOneMapped.entryNodeChecks.find((c) => c.nodeId === "e1")?.satisfied).toBe(true);
      expect(onlyOneMapped.entryNodeChecks.find((c) => c.nodeId === "e2")?.satisfied).toBe(false);

      const bothMapped = checkBindingInputContract("wf", { x: "a", y: "b" }, source(["x", "y"]), nodes);
      expect(bothMapped.satisfied).toBe(true);
    });

    it("a field with no entry in inputMapping is dropped, not guessed at, even when its name matches the target field by coincidence", () => {
      const nodes = [node({ id: "entry", dependsOn: [], inputSchema: { required: ["mode"] } })];
      // "mode" is a guaranteed SOURCE field but is never mapped — it must not be assumed to pass
      // through under its own name.
      const result = checkBindingInputContract("wf", {}, source(["mode"]), nodes);
      expect(result.satisfied).toBe(false);
      expect(result.guaranteedTargetFields).toEqual([]);
    });

    it("the real visual_identity_review_change binding's shape (as a synthetic fixture matching brand_imagery_writer exactly) is unsatisfiable", () => {
      const nodes = [node({ id: "brand_imagery_writer", dependsOn: [], inputSchema: { required: ["mode"], anyOf: [{ required: ["references"] }, { required: ["brief"] }] } })];
      const result = checkBindingInputContract(
        "visual_identity",
        { tenantId: "projectId", autoApply: "apply" },
        source(["tenantId"], ["autoApply", "focus"]),
        nodes
      );
      expect(result.satisfied).toBe(false);
      expect(result.entryNodeChecks[0].unsatisfiedRequired).toEqual(["mode"]);
      expect(result.entryNodeChecks[0].satisfiedAnyOfBranchIndex).toBeNull();
    });
  });
});
