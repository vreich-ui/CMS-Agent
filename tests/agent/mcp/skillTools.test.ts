import { beforeEach, describe, expect, it } from "vitest";
import { handleMcpJsonRpc } from "../../../src/agent/mcp/workspace/server.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const rpc = async (method: string, params?: Record<string, unknown>) =>
  (await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method, params })) as { result?: any; error?: { code: number; data?: any } };
const call = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });

describe("skill.create MCP tool", () => {
  beforeEach(() => resetRepositoryManager());

  it("creates a skill when the connector sends the `skill` object as a JSON string", async () => {
    // Remote MCP clients serialize object-typed args as JSON strings. Previously the stringified
    // `skill` reached skillDefinitionSchema.parse and threw "expected object, received string";
    // the handler now coerces it back to an object exactly as workspace.create_node does.
    const skill = { skillId: "connector_string_skill", name: "Connector string skill", description: "Sent as a JSON string.", instructions: "Return output." };
    const created = await call("skill.create", { skill: JSON.stringify(skill) });
    expect(created.result.structuredContent.ok).toBe(true);
    expect(created.result.structuredContent.data.skill.skillId).toBe("connector_string_skill");

    const stored = (await call("skill.get", { skillId: "connector_string_skill" })).result.structuredContent.data.skill;
    expect(stored.skillId).toBe("connector_string_skill");
  });

  it("creates a valid record from a minimally-specified skill by defaulting server-owned fields", async () => {
    const created = await call("skill.create", { skill: { skillId: "minimal_skill", name: "Minimal", description: "Only the essentials.", instructions: "Do the thing." } });
    expect(created.result.structuredContent.ok).toBe(true);
    const skill = created.result.structuredContent.data.skill;
    // Server-owned / optional fields are filled; the record is fully valid, not weakened.
    expect(skill).toMatchObject({ version: "1.0.0", status: "active", riskLevel: "read", allowedTools: [], metadata: {} });
    expect(skill.examples.length).toBeGreaterThanOrEqual(1);
    expect(skill.memoryPolicy).toMatchObject({ read: true, write: false });
    expect(skill.toolPolicy).toMatchObject({ mutatingToolsRequireApproval: true });
    expect(typeof skill.createdAt).toBe("string");
    expect(typeof skill.updatedAt).toBe("string");
  });

  it("accepts a fully-specified skill object and honours caller-supplied fields", async () => {
    const skill = {
      skillId: "full_skill", name: "Full", description: "Fully specified.", version: "2.1.0", status: "draft", instructions: "Run.",
      inputSchema: { type: "object", properties: { brief: { type: "string" } }, required: ["brief"] }, outputSchema: { type: "object" },
      allowedTools: ["web.fetch"], requiredArtifacts: [], producedArtifacts: [],
      examples: [{ name: "ok", input: { brief: "x" }, output: {} }], preconditions: [], completionCriteria: [], blockerCriteria: [],
      memoryPolicy: { namespaces: ["full_skill"], read: true, write: true }, toolPolicy: { requestedTools: ["web.fetch"], mutatingToolsRequireApproval: false },
      riskLevel: "write", metadata: { team: "docs" }
    };
    const created = await call("skill.create", { skill });
    expect(created.result.structuredContent.ok).toBe(true);
    expect(created.result.structuredContent.data.skill).toMatchObject({ skillId: "full_skill", version: "2.1.0", status: "draft", riskLevel: "write", metadata: { team: "docs" } });
    expect(created.result.structuredContent.data.skill.toolPolicy.mutatingToolsRequireApproval).toBe(false);
  });

  it("does not weaken validation: a requested tool outside allowedTools is still rejected", async () => {
    const created = await call("skill.create", { skill: { skillId: "bad_policy_skill", name: "Bad", description: "Requests a tool it is not allowed.", instructions: "Run.", allowedTools: [], toolPolicy: { requestedTools: ["publish.post"], mutatingToolsRequireApproval: true } } });
    expect(created.result?.structuredContent?.ok).toBeUndefined();
    expect(created.error?.code).toBe(-32603);
  });

  it("advertises exactly its accept shape (nested `skill`, no misleading flat fields)", async () => {
    const tool = (await rpc("tools/list")).result.tools.find((t: { name: string }) => t.name === "skill_create");
    expect(tool.inputSchema.required).toEqual(["skill"]);
    // The old shared union advertised flat fields the strict handler rejected — they are gone now.
    expect(tool.inputSchema.properties).not.toHaveProperty("newSkillId");
    expect(tool.inputSchema.properties).not.toHaveProperty("runInstructions");
    expect(tool.inputSchema.properties.skill.required).toEqual(["skillId", "name", "description", "instructions"]);
  });

  it("rejects the flat shape that the broken advertised schema used to invite", async () => {
    const flat = await call("skill.create", { newSkillId: "flat_skill", runInstructions: "Do the thing.", riskPolicy: "read" });
    expect(flat.result?.structuredContent?.ok).toBeUndefined();
    expect(flat.error?.code).toBe(-32603);
  });
});
