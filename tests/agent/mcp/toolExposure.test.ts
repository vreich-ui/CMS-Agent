import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleMcpJsonRpc, isToolExposed } from "../../../src/agent/mcp/workspace/server.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const rpc = async (method: string, params?: Record<string, unknown>) =>
  (await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method, params })) as { result?: any; error?: { code: number; message: string } };

const listedNames = async (): Promise<string[]> => (await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name);

describe("MCP_EXPOSED_TOOL_PREFIXES catalog scoping", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => delete process.env.MCP_EXPOSED_TOOL_PREFIXES);

  it("exposes the full catalog when unset or empty", async () => {
    delete process.env.MCP_EXPOSED_TOOL_PREFIXES;
    expect((await listedNames()).length).toBeGreaterThan(100);
    process.env.MCP_EXPOSED_TOOL_PREFIXES = "  ";
    expect((await listedNames()).length).toBeGreaterThan(100);
  });

  it("filters tools/list to the allow-listed namespaces", async () => {
    process.env.MCP_EXPOSED_TOOL_PREFIXES = "workspace,project";
    const names = await listedNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("workspace_") || name.startsWith("project_"))).toBe(true);
    expect(names).toContain("workspace_get_nodes");
    expect(names).toContain("project_list");
    expect(names).not.toContain("node_list");
    expect(names).not.toContain("usage_get_summary");
  });

  it("refuses tools/call for unexposed tools under either spelling", async () => {
    process.env.MCP_EXPOSED_TOOL_PREFIXES = "workspace";
    const canonical = await rpc("tools/call", { name: "usage_get_summary", arguments: {} });
    const dotted = await rpc("tools/call", { name: "usage.get_summary", arguments: {} });
    expect(canonical.error?.code).toBe(-32602);
    expect(dotted.error?.code).toBe(-32602);

    // Exposed namespaces stay callable under both spellings.
    const exposed = await rpc("tools/call", { name: "workspace.get_nodes", arguments: {} });
    expect(exposed.result.structuredContent.ok).toBe(true);
  });

  it("matches the tool namespace, not a raw string prefix", () => {
    process.env.MCP_EXPOSED_TOOL_PREFIXES = "node";
    expect(isToolExposed("node.list")).toBe(true);
    // "node" must not accidentally expose other namespaces or partial matches.
    expect(isToolExposed("workspace.get_node")).toBe(false);
    process.env.MCP_EXPOSED_TOOL_PREFIXES = "work";
    expect(isToolExposed("workspace.get_nodes")).toBe(false);
  });
});
