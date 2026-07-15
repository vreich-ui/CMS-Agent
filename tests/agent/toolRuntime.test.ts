import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { executeTool, getToolExecution } from "../../src/agent/tools/toolExecutor.js";
import { resolveEffectiveToolsForNode } from "../../src/agent/tools/toolResolver.js";
import { repositoryManager } from "../../src/agent/runtime/repositories.js";

const ctx = { runId: "run-tools", nodeId: "input_triage", maxRiskLevel: "read" as const };

beforeEach(() => {
  process.env.TOOL_BLOB_PREFIXES = "agent-tools/";
});
afterEach(() => vi.restoreAllMocks());

describe("controlled tool runtime", () => {
  it("executes allowed read tools and writes an audit record", async () => {
    const result = await executeTool("workspace.get_node", { id: "input_triage" }, ctx);
    expect(result.ok).toBe(true);
    const record = getToolExecution(result.toolExecutionId!);
    expect(record).toMatchObject({ runId: "run-tools", nodeId: "input_triage", toolId: "workspace.get_node", status: "success", approvalStatus: "not_required" });
  });

  it("returns structured denial reasons for node policy failures", async () => {
    const result = await executeTool("web.fetch", { url: "https://example.com" }, ctx);
    expect(result.ok).toBe(false);
    expect((result as any).denied.reasons).toContain("node_tool_not_allowed");
  });

  it("enforces risk and approval for write tools", async () => {
    const denied = await executeTool("stage.save_output", { stage: "draft", value: {} }, { ...ctx, maxRiskLevel: "read" });
    expect(denied.ok).toBe(false);
    expect((denied as any).denied.reasons).toEqual(expect.arrayContaining(["risk_level_exceeds_authorization", "approval_required"]));
  });

  it("reports skill/node tool intersection through effective resolver", async () => {
    const tools = await resolveEffectiveToolsForNode("input_triage", { runId: "run-tools" });
    const webFetch = tools.find((tool) => tool.toolId === "web.fetch");
    expect(webFetch?.allowed).toBe(false);
    expect(webFetch?.denialReasons).toContain("node_tool_not_allowed");
  });

  it("blocks localhost and private URLs", async () => {
    const local = await executeTool("web.fetch", { url: "http://localhost:3000" }, { ...ctx, nodeId: "external_test", runAuthorizedTools: ["web.fetch"] });
    expect((local as any).error.code).toBe("tool_error");
    expect((local as any).error.message).toBe("private_url_blocked");
    const privateUrl = await executeTool("web.fetch", { url: "http://192.168.1.5" }, { ...ctx, nodeId: "external_test", runAuthorizedTools: ["web.fetch"] });
    expect((privateUrl as any).error.message).toBe("private_url_blocked");
  });

  it("rejects file path traversal", async () => {
    const result = await executeTool("file.read_text", { path: "../secret.txt" }, { ...ctx, nodeId: "external_test", runAuthorizedTools: ["file.read_text"] });
    expect(result.ok).toBe(false);
    expect((result as any).error.code).toBe("validation_error");
  });

  it("restricts blob keys to configured prefixes", async () => {
    const result = await executeTool("blob.get_json", { key: "forbidden/key.json" }, { ...ctx, nodeId: "external_test", runAuthorizedTools: ["blob.get_json"] });
    expect(result.ok).toBe(false);
    expect((result as any).error.message).toBe("blob_prefix_not_allowed");
  });

  it("enforces project MCP tool permissions (needs_approval is held)", async () => {
    // dr-lurie is full-access, but wipe_blob_stores is held for approval and must not run.
    const result = await executeTool("project.call_tool", { projectId: "dr-lurie", tool: "wipe_blob_stores", arguments: {} }, { runId: "run-tools", nodeId: "external_test", projectId: "dr-lurie", maxRiskLevel: "write", approvedToolIds: ["project.call_tool"], runAuthorizedTools: ["project.call_tool"] });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("requires approval");
  });

  it("records timeout behavior", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    const result = await executeTool("web.fetch", { url: "https://example.com" }, { ...ctx, nodeId: "external_test", runAuthorizedTools: ["web.fetch"] });
    expect(result.ok).toBe(false);
    expect((result as any).error.code).toBe("tool_timeout");
  }, 10000);

  it("redacts secrets from audit summaries", async () => {
    const result = await executeTool("workspace.get_node", { id: "input_triage", authorization: "Bearer secret-token", apiKey: "secret" }, ctx);
    const record = getToolExecution(result.toolExecutionId!);
    expect(JSON.stringify(record)).not.toContain("secret-token");
    expect(JSON.stringify(record)).not.toContain('"apiKey":"secret"');
  });
});
