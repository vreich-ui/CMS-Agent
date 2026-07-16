import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const call = async (name: string, args: Record<string, unknown> = {}) => (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;
const validArticleBody = { schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "T", body: "Reader body." } }] };

describe("conductor cost-control MCP tools", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("advertises the conductor tools under canonical names", async () => {
    const names = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["workflow_get_run_context", "workflow_get_run_cost"]));
  });

  it("caches the reusable run context bundle per run", async () => {
    const runId = (await data("workflow.start_dry_run", { projectId: "dr-lurie", input: {} })).run.runId;

    const first = await data("workflow.get_run_context", { runId, projectId: "dr-lurie" });
    expect(first.cacheHit).toBe(false);
    expect(first.context.projectContract.canonicalArticleBody).toBe("article_body.v1");
    expect(first.context.projectToolPolicy.defaultToolPolicy).toBe("allowed");
    expect(first.context.registry.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining(["article_body", "publish_payload"]));

    const second = await data("workflow.get_run_context", { runId, projectId: "dr-lurie" });
    expect(second.cacheHit).toBe(true);
  });

  it("reports a per-node cost ledger and a reuse plan", async () => {
    const runId = (await data("workflow.start_dry_run", { projectId: "dr-lurie", input: {} })).run.runId;
    await data("workflow.run_next_node", { runId });
    await data("workflow.run_next_node", { runId });

    const { ledger, plan } = await data("workflow.get_run_cost", { runId });
    expect(ledger.reusableNodeIds).toContain("input_triage");
    expect(ledger.stages.find((stage: { nodeId: string }) => stage.nodeId === "input_triage").reusable).toBe(true);
    expect(ledger.totalTokens).toBeGreaterThan(0);
    // No reusable late-stage artifact yet, so the plan is a full run from the current node.
    expect(plan.strategy).toBe("full_run");
    expect(plan.reusableStages).toContain("input_triage");
  });

  it("recommends a narrow late-stage re-run once article_body is complete", async () => {
    const runId = (await data("workflow.start_dry_run", { projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: validArticleBody })).run.runId;

    const { ledger, plan } = await data("workflow.get_run_cost", { runId });
    expect(ledger.reusableNodeIds).toContain("article_body");
    expect(plan.strategy).toBe("late_stage_rerun");
    expect(plan.recommendedEntrypoint).toBe("article_body");
    expect(plan.narrowerThanFullRun).toBe(true);
  });

  it("returns nulls for an unknown run", async () => {
    const result = await data("workflow.get_run_cost", { runId: "run_missing" });
    expect(result).toEqual({ ledger: null, plan: null });
  });
});
