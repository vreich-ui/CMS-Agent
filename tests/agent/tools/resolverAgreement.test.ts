import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// R-5. skill.resolve_for_node and node.get_effective_tools used to answer "may this node reach this
// tool?" independently, and disagreed for project.call_tool on article_body, contract_intelligence,
// publish_payload and artifact_plan: the skill resolver did a plain set intersection and said
// granted, while the tool resolver ran the real policy (which also honors tool.enabled, the risk
// ladder, and requiresApproval) and said approval_required. Both were "the answer" depending on
// which tool you asked. There is now one implementation and the other delegates to it.
const NODES_THAT_DISAGREED = ["article_body", "contract_intelligence", "publish_payload", "artifact_plan"];
// Both publish-risk nodes now hold the grant too, so they belong in the same agreement check.
const ALL_CALL_TOOL_NODES = [...NODES_THAT_DISAGREED, "publication_controller", "publish_executor"];

describe("one authority for whether a node may reach a tool", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("skill.resolve_for_node and node.get_effective_tools agree on project.call_tool for every node that requests it", async () => {
    for (const nodeId of ALL_CALL_TOOL_NODES) {
      const policy = (await data("skill.resolve_for_node", { nodeId })).policy as { effectiveTools: string[]; requestedTools: string[]; deniedTools: string[] };
      const tools = (await data("node.get_effective_tools", { nodeId })).tools as { toolId: string; allowed: boolean }[];
      const toolVerdict = tools.find((tool) => tool.toolId === "project.call_tool")?.allowed;

      expect(policy.requestedTools, `${nodeId}'s skill requests the client tool`).toContain("project.call_tool");
      const skillVerdict = policy.effectiveTools.includes("project.call_tool");
      expect(skillVerdict, `${nodeId}: the two resolvers must not disagree about project.call_tool`).toBe(toolVerdict);
    }
  });

  it("names WHY a tool was denied, so an approval gate is not mistaken for a misconfiguration", async () => {
    const policy = (await data("skill.resolve_for_node", { nodeId: "publish_executor" })).policy as { deniedTools: string[]; deniedToolReasons: Record<string, string[]> };
    // publish_executor now carries the grant, so node_tool_not_allowed is gone; what remains is the
    // per-run approval requirement, which is the gate working, not a workspace defect.
    expect(policy.deniedTools).toContain("project.call_tool");
    expect(policy.deniedToolReasons["project.call_tool"]).toEqual(["approval_required"]);
    expect(policy.deniedToolReasons["project.call_tool"]).not.toContain("node_tool_not_allowed");
  });

  it("agrees across the whole registry, not just the tool that exposed the split", async () => {
    const nodeId = "contract_intelligence";
    const policy = (await data("skill.resolve_for_node", { nodeId })).policy as { effectiveTools: string[]; requestedTools: string[] };
    const tools = (await data("node.get_effective_tools", { nodeId })).tools as { toolId: string; allowed: boolean }[];
    const allowedByPolicy = new Set(tools.filter((tool) => tool.allowed).map((tool) => tool.toolId));

    for (const toolId of policy.requestedTools) {
      expect(policy.effectiveTools.includes(toolId), `${nodeId}/${toolId} verdicts must match`).toBe(allowedByPolicy.has(toolId));
    }
  });
});
