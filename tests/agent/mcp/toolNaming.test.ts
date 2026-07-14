import { beforeEach, describe, expect, it } from "vitest";
import { handleMcpJsonRpc } from "../../../src/agent/mcp/workspace/server.js";
import { ANTHROPIC_TOOL_NAME_PATTERN, canonicalToolName } from "../../../src/agent/mcp/workspace/toolKit.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const rpc = async (method: string, params?: Record<string, unknown>) =>
  (await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method, params })) as {
    result?: any;
    error?: { code: number; message: string };
  };

describe("wire-facing tool naming", () => {
  beforeEach(() => resetRepositoryManager());

  it("serves only names matching the Anthropic tool-name pattern (remote connectors forward them verbatim)", async () => {
    const { result } = await rpc("tools/list");
    const names: string[] = result.tools.map((tool: { name: string }) => tool.name);
    expect(names.length).toBeGreaterThan(90);
    const invalid = names.filter((name) => !ANTHROPIC_TOOL_NAME_PATTERN.test(name));
    // This exact failure broke the claude.ai connector: tools[92] ("changes.get") violated the
    // pattern because every dotted name does. The served list must stay clean forever.
    expect(invalid).toEqual([]);
  });

  it("serves unique names after normalization", async () => {
    const { result } = await rpc("tools/list");
    const names: string[] = result.tools.map((tool: { name: string }) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("executes tools by their canonical underscore name", async () => {
    const { result } = await rpc("tools/call", { name: "workspace_get_nodes", arguments: {} });
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data.nodes.length).toBeGreaterThan(0);
  });

  it("still executes tools by their legacy dotted name (UI and scripts)", async () => {
    const { result } = await rpc("tools/call", { name: "workspace.get_nodes", arguments: {} });
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data.nodes.length).toBeGreaterThan(0);
  });

  it("rejects unknown tools under either spelling", async () => {
    const dotted = await rpc("tools/call", { name: "workspace.not_a_tool", arguments: {} });
    const canonical = await rpc("tools/call", { name: "workspace_not_a_tool", arguments: {} });
    expect(dotted.error?.code).toBe(-32602);
    expect(canonical.error?.code).toBe(-32602);
  });

  it("canonicalToolName only rewrites dots", () => {
    expect(canonicalToolName("workspace.get_nodes")).toBe("workspace_get_nodes");
    expect(canonicalToolName("already_flat")).toBe("already_flat");
  });
});

describe("protocol liveness", () => {
  it("answers ping with an empty result (spec-required keepalive)", async () => {
    const response = await rpc("ping");
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({});
  });
});
