// budget-override-and-ui-save — workflow.set_node_budget_override end-to-end: registered (and
// identical) on both control-plane adapters, callable, persists onto run.nodeBudgetOverrides, does
// NOT retry the node itself, and is absent from the client_manager scoped-credential allowlist (the
// existing operator-gating pattern for write verbs this codebase already uses — see
// siteGenesis.ts's SITE_CLIENT_MANAGER_TOOLS and its own "operator-only" comment).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler as netlifyHandler } from "../../../netlify/functions/mcp.mjs";
import { routeControlPlaneRequest } from "../../../src/agent/mcp/http/controlPlaneRouter.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { SITE_CLIENT_MANAGER_TOOLS } from "../../../src/agent/capture/siteGenesis.js";

const TOKEN = "test-token";

const netlifyPost = async (body: unknown) => {
  const response = await netlifyHandler({ httpMethod: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const cloudRunPost = async (body: unknown) => {
  const response = await routeControlPlaneRequest({ method: "POST", path: "/mcp", query: {}, headers: { authorization: `Bearer ${TOKEN}`, host: "test.local" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const listNames = async (post: (body: unknown) => Promise<any>) =>
  (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((tool: { name: string }) => tool.name);
const call = async (post: (body: unknown) => Promise<any>, name: string, args: Record<string, unknown> = {}) =>
  post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(netlifyPost, name, args)).result.structuredContent.data;

describe("workflow.set_node_budget_override", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = TOKEN; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("is registered under its canonical name on BOTH control-plane adapters", async () => {
    const [netlifyNames, cloudRunNames] = await Promise.all([listNames(netlifyPost), listNames(cloudRunPost)]);
    expect(netlifyNames).toContain("workflow_set_node_budget_override");
    expect(cloudRunNames).toContain("workflow_set_node_budget_override");
  });

  it("is absent from SITE_CLIENT_MANAGER_TOOLS — a scoped client_manager credential cannot call it, same as workflow_retry_node/reset_run/set_operator_publish_decision", () => {
    expect(SITE_CLIENT_MANAGER_TOOLS).not.toContain("workflow_set_node_budget_override");
  });

  it("persists the override onto run.nodeBudgetOverrides, without retrying or otherwise touching the run's node states", async () => {
    const started = await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {} });
    const runId = started.run.runId;
    const nodesBefore = started.run.nodes;

    const result = await call(netlifyPost, "workflow.set_node_budget_override", { runId, nodeId: "artifact_plan", budgetUsd: 3.5 });
    expect(result.result.structuredContent.ok).toBe(true);
    expect(result.result.structuredContent.data.run.nodeBudgetOverrides).toEqual({ artifact_plan: 3.5 });

    const full = await data("workflow.get_run", { runId, detail: "full" });
    expect(full.run.nodeBudgetOverrides).toEqual({ artifact_plan: 3.5 });
    // No dispatch happened — this verb only records the override.
    expect(full.run.nodes).toEqual(nodesBefore);
  });

  it("a second override for a different node MERGES onto the map instead of replacing it", async () => {
    const runId = (await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {} })).run.runId;

    await call(netlifyPost, "workflow.set_node_budget_override", { runId, nodeId: "artifact_plan", budgetUsd: 3.5 });
    await call(netlifyPost, "workflow.set_node_budget_override", { runId, nodeId: "draft_writer", budgetUsd: 2 });

    const full = await data("workflow.get_run", { runId, detail: "full" });
    expect(full.run.nodeBudgetOverrides).toEqual({ artifact_plan: 3.5, draft_writer: 2 });
  });

  it("rejects a non-positive budgetUsd and a missing nodeId with validation_error, same envelope as every other typed tool", async () => {
    const runId = (await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {} })).run.runId;

    const zero = await call(netlifyPost, "workflow.set_node_budget_override", { runId, nodeId: "artifact_plan", budgetUsd: 0 });
    expect(zero.error?.data?.error?.code).toBe("validation_error");

    const missingNode = await call(netlifyPost, "workflow.set_node_budget_override", { runId, budgetUsd: 1 });
    expect(missingNode.error?.data?.error?.code).toBe("validation_error");

    // The rejected calls left no override behind.
    const full = await data("workflow.get_run", { runId, detail: "full" });
    expect(full.run.nodeBudgetOverrides ?? {}).toEqual({});
  });
});
