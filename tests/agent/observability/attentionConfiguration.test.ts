// R-10 — attention resolution. `constellation.get_attention` returned `items: []` against a
// workspace holding 18 real defects, which is worse than having no endpoint: it actively asserted
// that everything was fine. These cover the classes the audit actually found, plus the false
// positives a naive implementation would produce.
import { describe, expect, it } from "vitest";
import { configurationAttentionItems, type ConstellationInputs, type NodeSkillPolicySnapshot, type ProjectConnectionSnapshot } from "../../../src/agent/observability/constellationMetrics.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const node = (overrides: Partial<WorkspaceNode> & { id: string }): WorkspaceNode =>
  ({ name: overrides.id, prompt: "", schema: {}, allowedTools: [], assignedSkills: [], requiredInputs: [], produces: [], dependsOn: [], riskLevel: "read", status: "active", updatedAt: "2026-07-27T00:00:00.000Z", ...overrides }) as WorkspaceNode;

const inputs = (overrides: Partial<ConstellationInputs> = {}): ConstellationInputs => ({
  nodes: [],
  relationships: [],
  runs: [],
  usageRecords: [],
  toolExecutions: [],
  ...overrides
});

const policy = (overrides: Partial<NodeSkillPolicySnapshot> & { nodeId: string }): NodeSkillPolicySnapshot =>
  ({ conflicts: [], requestedTools: [], deniedTools: [], effectiveTools: [], ...overrides });

const project = (overrides: Partial<ProjectConnectionSnapshot> & { projectId: string }): ProjectConnectionSnapshot =>
  ({
    status: "active",
    connection: { endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "ACME_MCP_ENDPOINT", tokenEnvVar: "ACME_MCP_TOKEN" },
    ...overrides
  });

const ids = (items: { id: string }[]) => items.map((item) => item.id);

const RISK = { "stage.get_output": "read", "stage.save_output": "write", "project.call_tool": "write" } as const;

describe("dependsOn vs requiredInputs", () => {
  it("reports a node that disagrees with itself", () => {
    const items = configurationAttentionItems(inputs({ nodes: [node({ id: "trust_factual", dependsOn: ["research"], requiredInputs: ["research", "draft_writer"] })] }));

    expect(ids(items)).toContain("attn_dependency_mismatch_trust_factual");
    expect(items[0].reasons.join(" ")).toContain("draft_writer");
  });

  it("ignores order", () => {
    const items = configurationAttentionItems(inputs({ nodes: [node({ id: "n", dependsOn: ["b", "a"], requiredInputs: ["a", "b"] })] }));

    expect(items).toEqual([]);
  });

  // The false positive a naive check produces: the entry node's requiredInputs is an external
  // envelope, not an upstream node id, and it has no dependencies by definition.
  it("does not flag an entry node whose requiredInputs is an external envelope", () => {
    const items = configurationAttentionItems(inputs({ nodes: [node({ id: "input_triage", dependsOn: [], requiredInputs: ["content_source.v1"] })] }));

    expect(items).toEqual([]);
  });
});

describe("tools a node grants above its own risk level", () => {
  it("reports the ungrantable grant and names both risk levels", () => {
    const items = configurationAttentionItems(inputs({
      nodes: [node({ id: "topic_opportunity", riskLevel: "read", allowedTools: ["stage.get_output", "stage.save_output"] })],
      toolRiskLevels: RISK
    }));

    expect(ids(items)).toContain("attn_ungrantable_tools_topic_opportunity");
    expect(items[0].reasons[0]).toContain("stage.save_output is riskLevel write");
  });

  it("accepts a write tool on a write node", () => {
    const items = configurationAttentionItems(inputs({
      nodes: [node({ id: "learning_recorder", riskLevel: "write", allowedTools: ["stage.save_output"] })],
      toolRiskLevels: RISK
    }));

    expect(items).toEqual([]);
  });

  it("skips the check entirely when no tool registry was supplied, rather than reporting a false clean", () => {
    const items = configurationAttentionItems(inputs({ nodes: [node({ id: "n", riskLevel: "read", allowedTools: ["stage.save_output"] })] }));

    expect(items).toEqual([]);
  });
});

describe("skill conflicts", () => {
  it("reports a blocker conflict at action severity, not warning", () => {
    const items = configurationAttentionItems(inputs({
      nodes: [node({ id: "article_body" })],
      skillPolicies: [policy({ nodeId: "article_body", conflicts: [{ severity: "blocker", source: "output_schema", message: "incompatible" }] })]
    }));

    expect(items.find((item) => item.id === "attn_skill_blocker_article_body")?.severity).toBe("action");
    expect(items[0].reasons).toEqual(["output_schema: incompatible"]);
  });

  it("does not raise a blocker item for a warning-only conflict", () => {
    const items = configurationAttentionItems(inputs({
      nodes: [node({ id: "publication_controller" })],
      skillPolicies: [policy({ nodeId: "publication_controller", conflicts: [{ severity: "warning", source: "tool_policy", message: "not granted" }] })]
    }));

    expect(ids(items)).not.toContain("attn_skill_blocker_publication_controller");
  });

  it("reports a skill requesting a tool the node does not grant", () => {
    const items = configurationAttentionItems(inputs({
      nodes: [node({ id: "publish_executor", allowedTools: [] })],
      skillPolicies: [policy({ nodeId: "publish_executor", requestedTools: ["project.call_tool"], deniedTools: ["project.call_tool"] })]
    }));

    expect(ids(items)).toContain("attn_skill_requests_denied_tool_publish_executor");
  });

  it("stays quiet when the node grants what the skill requests", () => {
    const items = configurationAttentionItems(inputs({
      nodes: [node({ id: "article_body", allowedTools: ["project.call_tool"] })],
      skillPolicies: [policy({ nodeId: "article_body", requestedTools: ["project.call_tool"], effectiveTools: ["project.call_tool"] })]
    }));

    expect(items).toEqual([]);
  });
});

describe("client connections", () => {
  it("reports an active project missing both env vars, naming them", () => {
    const items = configurationAttentionItems(inputs({
      projects: [project({ projectId: "dr-lurie", connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN" } })]
    }));

    expect(ids(items)).toContain("attn_project_unconfigured_dr-lurie");
    expect(items[0].severity).toBe("action");
    expect(items[0].reasons.join(" ")).toContain("DR_LURIE_MCP_ENDPOINT");
    expect(items[0].reasons.join(" ")).toContain("DR_LURIE_MCP_TOKEN");
  });

  it("names only the variable actually missing", () => {
    const items = configurationAttentionItems(inputs({
      projects: [project({ projectId: "acme", connection: { endpointConfigured: true, tokenConfigured: false, mcpEndpointEnvVar: "ACME_MCP_ENDPOINT", tokenEnvVar: "ACME_MCP_TOKEN" } })]
    }));

    expect(items[0].reasons).toEqual(["ACME_MCP_TOKEN is not configured on this deployment"]);
  });

  // A disabled project is deliberately parked; nagging about its env vars is noise, and noise is
  // what made the previous surface useless.
  it("ignores a disabled project", () => {
    const items = configurationAttentionItems(inputs({
      projects: [project({ projectId: "snoocle", status: "disabled", connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: "SNOOCLE_MCP_ENDPOINT", tokenEnvVar: "SNOOCLE_MCP_TOKEN" } })]
    }));

    expect(items).toEqual([]);
  });

  it("ignores a fully configured project", () => {
    expect(configurationAttentionItems(inputs({ projects: [project({ projectId: "platform" })] }))).toEqual([]);
  });
});

describe("a clean workspace stays clean", () => {
  it("reports nothing when every check passes", () => {
    const items = configurationAttentionItems(inputs({
      nodes: [node({ id: "a", dependsOn: [], requiredInputs: [], riskLevel: "read", allowedTools: ["stage.get_output"] })],
      toolRiskLevels: RISK,
      skillPolicies: [policy({ nodeId: "a" })],
      projects: [project({ projectId: "platform" })]
    }));

    expect(items).toEqual([]);
  });
});

// Wiring check: the pure logic above is only useful if get_attention actually feeds it real skill,
// project, and tool-registry data. Driven through the Netlify adapter, against the seeded default
// workspace, where no client env vars are configured.
describe("constellation.get_attention integration", () => {
  it("reports unconfigured client connections through the real endpoint", async () => {
    const { handler } = await import("../../../netlify/functions/mcp.mjs");
    const { resetRepositoryManager } = await import("../../../src/agent/runtime/repositories.js");
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();

    const response = await handler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "constellation_get_attention", arguments: {} } })
    });
    const items = JSON.parse(response.body).result.structuredContent.data.items as { id: string; severity: string }[];

    // The endpoint used to return [] here no matter what was wrong.
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.id.startsWith("attn_project_unconfigured_"))).toBe(true);
    // Sorted action-first, so the thing that blocks work is not below an info item.
    expect(items[0].severity).toBe("action");
    resetRepositoryManager();
  });
});
