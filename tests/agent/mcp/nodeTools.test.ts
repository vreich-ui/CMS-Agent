import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

describe("node.* MCP tools", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; process.env.OPENAI_API_KEY = "secret-openai-key"; });

  it("lists and gets safe node details with redacted secrets", async () => {
    const list = await data("node.list");
    expect(list.nodes.map((node: { id: string }) => node.id)).toContain("input_triage");
    const detail = await data("node.get", { nodeId: "input_triage" });
    expect(detail.node.node.id).toBe("input_triage");
    expect(detail.node.dependencies).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain("secret-openai-key");
  });

  it("resolves effective prompt, skills, and tools", async () => {
    expect((await data("node.get_effective_prompt", { nodeId: "input_triage" })).prompt).toContain("Objective:");
    expect((await data("node.get_effective_skills", { nodeId: "input_triage" })).policy.nodeId).toBe("input_triage");
    expect((await data("node.get_effective_tools", { nodeId: "input_triage" })).tools.length).toBeGreaterThan(0);
  });

  it("validates input and output schemas", async () => {
    expect((await data("node.validate_input", { nodeId: "input_triage", value: {} })).validation.valid).toBe(true);
    expect((await data("node.validate_output", { nodeId: "input_triage", value: { artifact: "content_source.v1", summary: "ok" } })).validation.valid).toBe(true);
    expect((await data("node.validate_output", { nodeId: "input_triage", value: { artifact: "wrong" } })).validation.valid).toBe(false);
  });

  it("prepares missing dependency and ready states without model calls", async () => {
    expect((await data("node.prepare_execution", { nodeId: "topic_opportunity", input: {} })).preparation.readinessStatus).toBe("missing_inputs");
    expect((await data("node.prepare_execution", { nodeId: "topic_opportunity", input: {}, dependencyOutputs: { input_triage: { artifact: "content_source.v1", summary: "ok" } } })).preparation.readinessStatus).toBe("ready");
  });

  it("executes one node independently and retrieves outputs/history", async () => {
    const executed = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    expect(executed.execution.status).toBe("completed");
    const latest = await data("node.get_latest_output", { nodeId: "input_triage" });
    expect(latest.output.nodeId).toBe("input_triage");
    const history = await data("node.list_executions", { nodeId: "input_triage" });
    expect(history.executions.map((run: { runId: string }) => run.runId)).toContain(executed.execution.runId);
  });

  it("cancels and retries an execution record", async () => {
    const executed = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    expect((await data("node.cancel", { runId: executed.execution.runId })).execution.status).toBe("cancelled");
    expect((await data("node.retry", { runId: executed.execution.runId })).execution.status).toBe("completed");
  });

  it("creates a minimally-specified agent node without a dependsOn-iteration error", async () => {
    // An agent populating a fresh node may omit collection fields entirely. Previously this
    // persisted the node but returned "node.dependsOn is not iterable"; normalizeNode now defaults
    // every collection/scalar field so creation succeeds cleanly and the node is safe to iterate.
    const created = await call("workspace.create_node", { node: { id: "sample_agent", name: "Sample Agent", prompt: "Draft something." } });
    expect(created.result.structuredContent.ok).toBe(true);
    const node = created.result.structuredContent.data.node;
    expect(node).toMatchObject({ id: "sample_agent", dependsOn: [], allowedTools: [], requiredInputs: [], produces: [], riskLevel: "read", status: "draft" });

    // The graph and downstream derivations tolerate the new node (no iteration throw anywhere).
    expect((await data("workspace.get_graph")).nodes.some((n: { id: string }) => n.id === "sample_agent")).toBe(true);
    expect((await data("workspace.validate_graph")).validation.valid).toBe(true);
    expect((await data("node.prepare_execution", { nodeId: "sample_agent", input: {} })).preparation.resolvedNode.id).toBe("sample_agent");
  });

  it("records usage exactly once per independent execution (double-count regression)", async () => {
    // mock mode: exactly one estimated record from the runtime.
    const mock = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    const mockRecords = (await data("usage.list_records", { runId: mock.execution.runId })).records;
    expect(mockRecords).toHaveLength(1);
    expect(mockRecords[0].status).toBe("estimated");

    // openai mode: the runner owns usage recording; a failed run (no API key) must record ZERO
    // usage — previously the runtime fabricated an "actual" record even on failure.
    delete process.env.OPENAI_API_KEY;
    const openai = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "openai" });
    expect(openai.execution.status).toBe("failed");
    expect((await data("usage.list_records", { runId: openai.execution.runId })).records).toHaveLength(0);
  });
});
