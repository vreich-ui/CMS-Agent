import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

describe("constellation.* MCP tools", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("advertises the five read-only constellation tools", async () => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = JSON.parse(response.body ?? "{}").result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ["constellation.get_structure", "constellation.get_metrics", "constellation.get_relationship", "constellation.get_summary", "constellation.get_attention"]) expect(names).toContain(name);
  });

  it("returns structural data with derived execution edges matching the graph derivation", async () => {
    const structure = await data("constellation.get_structure");
    expect(structure.agents).toHaveLength(18);
    expect(structure.relationships).toEqual([]);
    const graph = await data("workspace.get_graph");
    expect(structure.derivedExecutionEdges).toHaveLength(graph.edges.length);
    expect(structure.derivedExecutionEdges.every((edge: { derivedFrom: string }) => edge.derivedFrom === "dependsOn")).toBe(true);
    // Minimal agent summaries only — no prompts or schemas on the structural payload.
    expect(Object.keys(structure.agents[0]).sort()).toEqual(["dependsOn", "id", "kind", "name", "position", "riskLevel", "status"]);
  });

  it("returns honest empty-system shapes before any runs or usage exist", async () => {
    const metrics = await data("constellation.get_metrics");
    expect(metrics.agents).toHaveLength(18);
    for (const agent of metrics.agents) {
      expect(agent.usage.estimated.recordCount).toBe(0);
      expect(agent.usage.actual.recordCount).toBe(0);
      expect(agent.successRate).toBeNull();
      expect(agent.latency).toBeNull();
      expect(agent.retries).toBeNull();
    }
    const { summary } = await data("constellation.get_summary");
    expect(summary.runs.total).toBe(0);
    expect(summary.usage.unattributedRecordCount).toBe(0);
    expect(summary.caveats.length).toBeGreaterThan(0);
    expect((await data("constellation.get_attention")).items).toEqual([]);
  });

  it("aggregates a real dry-run into metrics, summary, and evidence-cited attention", async () => {
    const started = await data("workflow.start_dry_run", { projectId: "project-a", input: "Constellation metrics test" });
    await data("workflow.run_all", { runId: started.run.runId });

    const metrics = await data("constellation.get_metrics", { runId: started.run.runId });
    const triage = metrics.agents.find((agent: { nodeId: string }) => agent.nodeId === "input_triage");
    expect(triage.executions.total).toBe(1);
    expect(triage.successRate).toBe(1);
    expect(triage.usage.estimated.recordCount).toBe(1);
    expect(triage.usage.actual.recordCount).toBe(0);
    expect(metrics.caveats.join(" ")).toContain("not billing-grade");
    // Aggregated tools never return raw record arrays.
    expect(metrics.runs).toBeUndefined();
    expect(metrics.records).toBeUndefined();

    const relationship = await data("constellation.get_relationship", { sourceId: "input_triage", targetId: "topic_opportunity" });
    expect(relationship.relationship.kind).toBe("execution");
    expect(relationship.metrics.interactionCount).toBe(1);
    expect(relationship.metrics.successRate).toBe(1);
    expect(relationship.metrics.payloadBytes.total).toBeGreaterThan(0);
    expect(relationship.metrics.schemaMismatchCount.value).toBeNull();
    expect(relationship.metrics.schemaMismatchCount.reason).toBeTruthy();

    const attention = (await data("constellation.get_attention")).items;
    const approval = attention.find((item: { id: string }) => item.id === `attn_approval_pending_${started.run.runId}`);
    expect(approval.severity).toBe("action");
    expect(approval.reasons.join(" ")).toContain("publication_controller");
    expect(approval.evidence.runIds).toEqual([started.run.runId]);
  });

  it("enforces exactly one addressing mode on constellation.get_relationship", async () => {
    const invalid = await call("constellation.get_relationship", { sourceId: "input_triage" });
    expect(invalid.error.data.error.code).toBe("validation_error");
    const byPair = await data("constellation.get_relationship", { sourceId: "input_triage", targetId: "topic_opportunity" });
    expect(byPair.relationship.kind).toBe("execution");
    const byMissingId = await data("constellation.get_relationship", { relationshipId: "rel_missing" });
    expect(byMissingId.relationship).toBeNull();
    expect(byMissingId.metrics).toBeNull();
  });
});
