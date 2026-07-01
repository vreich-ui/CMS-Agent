import { describe, expect, it, beforeEach } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";

const event = (body: unknown, token = "test-token") => ({
  httpMethod: "POST",
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body)
});

const call = async (body: unknown, token = "test-token") => {
  process.env.MCP_API_TOKEN = "test-token";
  const response = await handler(event(body, token));
  return { ...response, json: JSON.parse(response.body) };
};

describe("mcp endpoint", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
  });

  it("rejects unauthorized requests", async () => {
    const response = await handler(event({ jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong-token"));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
  });

  it("handles initialize requests", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json.result.serverInfo.name).toBe("publishing-workspace-mcp");
  });

  it("lists tools", async () => {
    const response = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(response.json.result.tools.map((tool: { name: string }) => tool.name)).toContain("workspace.get_nodes");
  });

  it("calls workspace.get_nodes", async () => {
    const response = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace.get_nodes", arguments: {} } });
    expect(response.json.result.structuredContent.ok).toBe(true);
    expect(response.json.result.structuredContent.data.nodes.length).toBeGreaterThan(0);
  });

  it("updates workspace node prompt", async () => {
    const response = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace.update_node_prompt", arguments: { id: "article_body", prompt: "New prompt" } } });
    expect(response.json.result.structuredContent.data.node.prompt).toBe("New prompt");
  });

  it("validates article bodies", async () => {
    const response = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "article_body.validate", arguments: { article: { title: "T", bodyMarkdown: "Body", slug: "valid-slug" } } } });
    expect(response.json.result.structuredContent.data.valid).toBe(true);
  });
});
