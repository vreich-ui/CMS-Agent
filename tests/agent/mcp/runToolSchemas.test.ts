import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const call = async (name: string, args: Record<string, unknown> = {}) => (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));

// R-19 — the run-advancing tools advertised the workspace-MUTATION schema: no runId property, required: [],
// additionalProperties: false. The advertised contract therefore omitted the argument these tools require
// and simultaneously forbade sending it, so any client that validates against tools/list before calling was
// locked out. This blocked T6.6.
const RUN_TOOLS = ["workflow_run_node", "workflow_run_until", "workflow_run_all", "workflow_retry_node", "workflow_run_next_node"];

describe("R-19 — run tools advertise the runId they require", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("declares runId as a required property on every run-advancing tool", async () => {
    const tools: Array<{ name: string; inputSchema: any }> = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;

    for (const name of RUN_TOOLS) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      expect(schema, `${name} is missing from tools/list`).toBeDefined();
      expect(schema.properties, `${name} must advertise runId`).toHaveProperty("runId");
      expect(schema.required, `${name} must mark runId required`).toContain("runId");
      // The combination that caused the lockout: a closed schema that omits a required argument.
      expect(schema.additionalProperties).toBe(false);
      // None of these are workspace mutations, so they must not advertise workspace-mutation fields.
      for (const leaked of ["patch", "orderedNodeIds", "positions", "create", "update", "delete", "newId"]) {
        expect(schema.properties, `${name} must not advertise workspace-mutation field ${leaked}`).not.toHaveProperty(leaked);
      }
    }

    // run_until genuinely requires its target as well; advertising it as optional would be the same defect
    // in the other direction.
    const runUntil = tools.find((tool) => tool.name === "workflow_run_until")!.inputSchema;
    expect(runUntil.required).toContain("nodeId");
  });

  it("accepts a call built only from the advertised schema", async () => {
    const tools: Array<{ name: string; inputSchema: any }> = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: { artifact: "content_source.v1", summary: "schema fixture" } });
    const runId: string = started.result.structuredContent.data.run.runId;

    // Build each argument object using ONLY advertised property names — the exact discipline a strict
    // client applies, and the one that used to fail.
    for (const name of ["workflow_run_all", "workflow_run_node", "workflow_retry_node"]) {
      const properties = tools.find((tool) => tool.name === name)!.inputSchema.properties;
      expect(Object.keys(properties)).toContain("runId");
      const response = await call(name, { runId });
      expect(response.error, `${name} rejected a schema-conformant call: ${JSON.stringify(response.error)}`).toBeUndefined();
      expect(response.result.structuredContent.ok).toBe(true);
    }

    const untilResponse = await call("workflow_run_until", { runId, nodeId: "reader_insight" });
    expect(untilResponse.error).toBeUndefined();
    expect(untilResponse.result.structuredContent.ok).toBe(true);
  });
});

describe("start_dry_run coerces a stringified input envelope", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  // Reproduced live: a client that serializes object arguments as JSON strings (see coerceJsonObjectInput
  // in toolKit.ts) had its content_source.v1 envelope stored in initialInput as a string. articleBody was
  // already coerced; input was not — and input is the T-3 publish path.
  it("stores an object, not the JSON string it arrived as", async () => {
    const envelope = { artifact: "content_source.v1", summary: "stringified envelope", notes: ["one"] };
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: JSON.stringify(envelope) });
    expect(started.result.structuredContent.data.run.initialInput).toEqual(envelope);
  });

  it("leaves a genuine string input alone", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: "just a headline" });
    expect(started.result.structuredContent.data.run.initialInput).toBe("just a headline");
  });
});
