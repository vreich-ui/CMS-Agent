import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

// F3 — `valid` (schema well-formedness) and `readiness` (can this node actually dispatch) are
// deliberately different questions. A node can be schema-valid and still refuse at dispatch because
// an assigned skill is missing — that gap is exactly what `readiness` makes answerable from this
// tool instead of from a failed run.
describe("workspace.validate_node — readiness is honest about a missing assigned skill", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("a schema-valid MODEL node with a missing assigned skill: valid:true, readiness.runnable:false, blocker named", async () => {
    await call("workspace.create_node", {
      node: { id: "readiness_model_node", name: "Readiness Model Node", prompt: "Do the work.", assignedSkills: ["does_not_exist_skill"] }
    });

    const result = await data("workspace.validate_node", { id: "readiness_model_node" });
    expect(result.valid).toBe(true);
    expect(result.capabilities.executionKind).toBe("model");
    expect(result.readiness.executionKind).toBe("model");
    expect(result.readiness.runnable).toBe(false);
    expect(result.readiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocker", source: "does_not_exist_skill" })
    ]));
  });

  it("the identical situation on a DETERMINISTIC node: valid:true, readiness.runnable:true, warning instead of a blocker", async () => {
    await call("workspace.create_node", {
      node: {
        id: "readiness_deterministic_node", name: "Readiness Deterministic Node", prompt: "Do the work.",
        assignedSkills: ["does_not_exist_skill"], metadata: { cloneStageDeterministic: "test_stage" }
      }
    });

    const result = await data("workspace.validate_node", { id: "readiness_deterministic_node" });
    expect(result.valid).toBe(true);
    expect(result.capabilities.executionKind).toBe("deterministic");
    expect(result.readiness.executionKind).toBe("deterministic");
    // A deterministic node completes with zero model calls, so a skill blocker can never stop IT.
    expect(result.readiness.runnable).toBe(true);
    expect(result.readiness.blockers).toEqual([]);
    expect(result.readiness.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocker", source: "does_not_exist_skill" })
    ]));
  });
});
