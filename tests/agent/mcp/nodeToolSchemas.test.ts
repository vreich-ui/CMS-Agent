import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const call = async (name: string, args: Record<string, unknown> = {}) => (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));

describe("node tool advertised schema == accepted input (executionMode mismatch)", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("advertises executionMode only on the tool that accepts it", async () => {
    const tools: Array<{ name: string; inputSchema: any }> = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
    const props = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema?.properties ?? {};

    // node.execute is the only node tool that runs the model, so it alone advertises executionMode.
    expect(props("node_execute")).toHaveProperty("executionMode");
    // The query / prepare / retry tools no longer advertise executionMode (their strict validation
    // rejects it), so a schema-following client is never rejected for a field it was told to send.
    for (const name of ["node_prepare_execution", "node_list_outputs", "node_list_executions", "node_get_latest_output", "node_retry", "node_cancel"]) {
      expect(props(name)).not.toHaveProperty("executionMode");
    }
    // node.retry/cancel advertise runId as required, matching their Zod schema.
    expect(tools.find((tool) => tool.name === "node_retry")?.inputSchema?.required).toContain("runId");
  });

  it("accepts a call that only uses advertised fields on each affected tool", async () => {
    // node.execute with the advertised executionMode succeeds (mock mode, no model call).
    const executed = await call("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    expect(executed.result.structuredContent.data.execution.status).toBe("completed");
    // A query tool works without executionMode (it never advertised it).
    const outputs = await call("node.list_outputs", { nodeId: "input_triage" });
    expect(outputs.result.structuredContent.ok).toBe(true);
    // Prepare works with only its advertised fields.
    const prepared = await call("node.prepare_execution", { nodeId: "input_triage", input: {} });
    expect(prepared.result.structuredContent.ok).toBe(true);
  });
});
