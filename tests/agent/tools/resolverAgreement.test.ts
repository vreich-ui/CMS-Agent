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
// The two publish-risk nodes hold the project.call_tool GRANT but no longer carry the contract
// skill (node-system overhaul): the skill's instructions center on project.call_read_tool
// discovery, which those nodes rightly deny — the standing "skill requests a tool the node denies"
// warnings were resolved by unassigning the mismatched skill, not by widening the nodes' grants.
const SKILL_BEARING_CALL_TOOL_NODES = NODES_THAT_DISAGREED;
const PUBLISH_RISK_GRANT_ONLY_NODES = ["publication_controller", "publish_executor"];

describe("one authority for whether a node may reach a tool", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("skill.resolve_for_node and node.get_effective_tools agree on project.call_tool for every node that requests it", async () => {
    for (const nodeId of SKILL_BEARING_CALL_TOOL_NODES) {
      const policy = (await data("skill.resolve_for_node", { nodeId })).policy as { effectiveTools: string[]; requestedTools: string[]; deniedTools: string[] };
      const tools = (await data("node.get_effective_tools", { nodeId })).tools as { toolId: string; allowed: boolean }[];
      const toolVerdict = tools.find((tool) => tool.toolId === "project.call_tool")?.allowed;

      expect(policy.requestedTools, `${nodeId}'s skill requests the client tool`).toContain("project.call_tool");
      const skillVerdict = policy.effectiveTools.includes("project.call_tool");
      expect(skillVerdict, `${nodeId}: the two resolvers must not disagree about project.call_tool`).toBe(toolVerdict);
    }
  });

  it("publish-risk nodes keep the call_tool grant with NO skill assuming capabilities they deny", async () => {
    for (const nodeId of PUBLISH_RISK_GRANT_ONLY_NODES) {
      const policy = (await data("skill.resolve_for_node", { nodeId })).policy as { requestedTools: string[] };
      const tools = (await data("node.get_effective_tools", { nodeId })).tools as { toolId: string; allowed: boolean }[];
      // No assigned skill means no skill-requested tools — the "skill requests a tool the node
      // denies" warning class cannot occur on the publish gate anymore.
      expect(policy.requestedTools, `${nodeId} must carry no skill-requested tools`).toEqual([]);
      // Go-live: the per-run approval lock on project.call_tool was removed, so the grant resolves allowed.
      expect(tools.find((tool) => tool.toolId === "project.call_tool")?.allowed, `${nodeId} grant resolves allowed at go-live`).toBe(true);
    }
  });

  it("no longer denies project.call_tool for approval — the go-live posture grants it outright", async () => {
    // publish_payload carries both the grant and the contract skill that requests project.call_tool.
    // Since go-live removed the per-run approval lock, the resolver must NOT report it denied.
    const policy = (await data("skill.resolve_for_node", { nodeId: "publish_payload" })).policy as { deniedTools: string[]; deniedToolReasons: Record<string, string[]> };
    expect(policy.deniedTools).not.toContain("project.call_tool");
    expect(policy.deniedToolReasons["project.call_tool"] ?? []).toEqual([]);
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
