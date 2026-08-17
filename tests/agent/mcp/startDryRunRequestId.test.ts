import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const call = async (name: string, args: Record<string, unknown> = {}) => (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
const errorOf = (response: any) => response.error?.data?.error ?? response.result?.structuredContent?.error ?? response.error;

// S1 (chat-path). Request ids are caller-supplied, never auto-generated — every client dialect that
// declares objectDialect.requestIdPattern says so. workflow.start_dry_run now enforces that at the
// front of the run: a LIVE run for a pattern-declaring project REFUSES without requestId
// (request_id_required) and any supplied malformed id is rejected (invalid_request_id), both naming
// the pattern; a project with no pattern, or a mock dry-run (never reaches the client), keeps the
// auto-minted join key.
describe("workflow.start_dry_run — caller-supplied requestId, pattern-validated", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("refuses a live run for a pattern-declaring project without requestId, naming the pattern", async () => {
    const response = await call("workflow.start_dry_run", { projectId: "dr-lurie", executionMode: "openai", input: {} });
    const error = errorOf(response);
    expect(error).toBeDefined();
    expect(JSON.stringify(error)).toContain("request_id_required");
    expect(JSON.stringify(error)).toContain("req_[a-z0-9_]+_");
  });

  it("rejects a requestId that does not match the project's pattern", async () => {
    const response = await call("workflow.start_dry_run", { projectId: "dr-lurie", executionMode: "mock", input: {}, requestId: "REQ-Not-Snake" });
    const error = errorOf(response);
    expect(JSON.stringify(error)).toContain("invalid_request_id");
    expect(JSON.stringify(error)).toContain("req_[a-z0-9_]+_");
  });

  it("accepts a conforming requestId and stamps it on the run", async () => {
    const response = await call("workflow.start_dry_run", { projectId: "dr-lurie", executionMode: "mock", input: {}, requestId: "req_article_retinol_20260817_01" });
    expect(response.error).toBeUndefined();
    const run = response.result.structuredContent.data.run;
    expect(run.requestId).toBe("req_article_retinol_20260817_01");
    const fetched = (await call("workflow.get_run", { runId: run.runId })).result.structuredContent.data.run;
    expect(fetched.requestId).toBe("req_article_retinol_20260817_01");
  });

  it("keeps the auto-minted requestId for a project without a pattern, and for a mock dry-run", async () => {
    for (const args of [{ projectId: "project-a", executionMode: "openai", input: { topic: "t" } }, { projectId: "dr-lurie", executionMode: "mock", input: {} }]) {
      const response = await call("workflow.start_dry_run", args);
      expect(response.error).toBeUndefined();
      const run = response.result.structuredContent.data.run;
      expect(typeof run.requestId).toBe("string");
      expect(run.requestId.length).toBeGreaterThan(0);
    }
  });

  it("advertises requestId in the tool schema", async () => {
    const tools: Array<{ name: string; inputSchema: any }> = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
    const schema = tools.find((tool) => tool.name === "workflow_start_dry_run")!.inputSchema;
    expect(schema.properties).toHaveProperty("requestId");
  });
});
