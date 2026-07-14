import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";

const SECRET = "dr-lurie-secret-token";
const ENDPOINT = "https://dr-lurie.example/mcp";

const call = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
};
const toolCall = (name: string, args: Record<string, unknown> = {}, id = 1) => call({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const structured = (response: Awaited<ReturnType<typeof call>>) => response.json.result.structuredContent;

const validArticleBody = { schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", public: { title: "Title", body: "Reader-facing body." } }] };

// Records the JSON-RPC methods a stubbed remote MCP server is asked for, so tests can assert that
// project tools only ever perform read-only primitives and never a publish call.
const remoteMethods: string[] = [];
const remoteFetch = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
  const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  remoteMethods.push(request.method);
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", serverInfo: { name: "dr-lurie-mcp", version: "1.0.0" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "ping", description: "Ping", inputSchema: {} }, { name: "publish_article" }, { name: "save_json_blob_article" }] }
      : request.method === "tools/call"
        ? { tool: request.params?.name, received: request.params?.arguments ?? {}, tokenEcho: undefined }
        : {};
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
});

describe("project.* MCP tools", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = SECRET;
    remoteMethods.length = 0;
    remoteFetch.mockClear();
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("advertises the project.* tools", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = response.json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["project_list", "project_get", "project_test_connection", "project_list_tools", "project_call_tool", "project_validate_handoff"]));
  });

  it("project.list returns dr-lurie with safe metadata and no secrets", async () => {
    const response = await toolCall("project.list");
    const { data } = structured(response);

    expect(data.projects.map((project: { projectId: string }) => project.projectId)).toContain("dr-lurie");
    expect(JSON.stringify(data)).not.toContain(SECRET);
    expect(JSON.stringify(data)).not.toContain(ENDPOINT);
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.get returns safe connection metadata (booleans + env var names only)", async () => {
    const response = await toolCall("project.get", { projectId: "dr-lurie" });
    const project = structured(response).data.project;

    expect(project.connection).toEqual({ endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN" });
    expect(JSON.stringify(project)).not.toContain(SECRET);
  });

  it("project.test_connection uses the adapter to run a primitive initialize", async () => {
    const response = await toolCall("project.test_connection", { projectId: "dr-lurie" });
    const connection = structured(response).data.connection;

    expect(connection.ok).toBe(true);
    expect(connection.server).toMatchObject({ name: "dr-lurie-mcp", protocolVersion: "2025-06-18" });
    expect(remoteMethods).toEqual(["initialize"]);
    expect(JSON.stringify(response.json)).not.toContain(SECRET);
  });

  it("project.list_tools returns safe remote tool names", async () => {
    const response = await toolCall("project.list_tools", { projectId: "dr-lurie" });
    const { data } = structured(response);

    expect(data.tools.map((tool: { name: string }) => tool.name)).toEqual(["ping", "publish_article", "save_json_blob_article"]);
    expect(remoteMethods).toEqual(["tools/list"]);
  });

  it("project.call_tool allows an approved read-only tool and returns structured JSON without tokens", async () => {
    const response = await toolCall("project.call_tool", { projectId: "dr-lurie", tool: "ping", arguments: { message: "hello" } });
    const { data } = structured(response);

    expect(data.call).toMatchObject({ ok: true, projectId: "dr-lurie", tool: "ping", result: { tool: "ping", received: { message: "hello" } } });
    expect(remoteMethods).toEqual(["tools/call"]);
    expect(JSON.stringify(response.json)).not.toContain(SECRET);
    expect(JSON.stringify(response.json)).not.toContain(ENDPOINT);
  });

  it("project.call_tool blocks disallowed publishing and mutation tools before remote calls", async () => {
    const publish = await toolCall("project.call_tool", { projectId: "dr-lurie", tool: "publish_article", arguments: {} });
    const saveBlob = await toolCall("project.call_tool", { projectId: "dr-lurie", tool: "save_json_blob_article", arguments: {} });

    expect(structured(publish).data.call).toMatchObject({ ok: false, tool: "publish_article", error: "Tool is not allowed for project: publish_article" });
    expect(structured(saveBlob).data.call).toMatchObject({ ok: false, tool: "save_json_blob_article", error: "Tool is not allowed for project: save_json_blob_article" });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.call_tool rejects an unknown project", async () => {
    const response = await toolCall("project.call_tool", { projectId: "does-not-exist", tool: "ping", arguments: {} });
    expect(response.json.error.code).toBe(-32603);
    expect(response.json.error.data.error.message).toContain("does-not-exist");
  });

  it("project.validate_handoff checks content_source.v1 / article_body.v1 structure locally", async () => {
    const valid = await toolCall("project.validate_handoff", { projectId: "dr-lurie", contentSource: { artifact: "content_source.v1", summary: "s" }, articleBody: validArticleBody });
    const invalid = await toolCall("project.validate_handoff", { projectId: "dr-lurie", articleBody: { schema_version: "article_body.v1", nodes: [] } });

    expect(structured(valid).data.validation.valid).toBe(true);
    expect(structured(invalid).data.validation.valid).toBe(false);
    // Local structural check performs no network calls at all.
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("performs no publish side effects across the project tools", async () => {
    await toolCall("project.test_connection", { projectId: "dr-lurie" });
    await toolCall("project.list_tools", { projectId: "dr-lurie" });
    await toolCall("project.validate_handoff", { projectId: "dr-lurie", articleBody: validArticleBody });

    // Existing project metadata/validation tools still perform only read-only discovery primitives.
    expect(new Set(remoteMethods)).toEqual(new Set(["initialize", "tools/list"]));
  });

  it("returns a tool error for an unknown project", async () => {
    const response = await toolCall("project.test_connection", { projectId: "does-not-exist" });
    expect(response.json.error.code).toBe(-32603);
    expect(response.json.error.data.error.message).toContain("does-not-exist");
  });
});
