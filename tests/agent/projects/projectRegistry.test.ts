import { describe, expect, it } from "vitest";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { DR_LURIE_SAFE_READ_ONLY_TOOLS, drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import { ProjectMcpAdapter, resolveProjectConnection } from "../../../src/agent/projects/drLurie/adapter.js";
import { toProjectSummary, validateHandoff } from "../../../src/agent/projects/projectRegistry.js";
import type { McpTransport } from "../../../src/agent/projects/mcpClient.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

const env = { DR_LURIE_MCP_ENDPOINT: "https://dr-lurie.example/mcp", DR_LURIE_MCP_TOKEN: "super-secret-token" } as unknown as NodeJS.ProcessEnv;
const SECRET = "super-secret-token";

type RecordedCall = { method: string; hasAuth: boolean; body: string };

const fakeTransport = (byMethod: Record<string, unknown>, calls: RecordedCall[] = []): McpTransport =>
  async (_endpoint, init) => {
    const request = JSON.parse(init.body) as { method: string };
    calls.push({ method: request.method, hasAuth: "authorization" in init.headers, body: init.body });
    const result = byMethod[request.method];
    const payload = result === undefined
      ? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }
      : { jsonrpc: "2.0", id: 1, result };
    return { ok: true, status: 200, json: async () => payload };
  };

const staleDrLurieConfig = (): ProjectConnectionConfig => ({
  ...structuredClone(drLurieProjectConfig),
  definitionVersion: 1,
  allowedTools: ["ping"]
});

const validArticleBody = { schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", public: { title: "Title", body: "Reader-facing body." } }] };

describe("project registry + Dr. Lurie definition", () => {
  it("memory project registry lists dr-lurie by default", async () => {
    const repository = new MemoryProjectRepository();
    const projects = await repository.list();

    expect(projects.map((project) => project.projectId)).toContain("dr-lurie");
    const drLurie = await repository.get("dr-lurie");
    expect(drLurie?.contentContract).toEqual({ contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" });
    expect(drLurie?.publishingPolicy).toMatchObject({ publishEnabled: false, requiresExplicitPublish: true });
  });

  it("dr-lurie allowedTools includes exactly the safe read-only tools", () => {
    expect(drLurieProjectConfig.allowedTools).toEqual([...DR_LURIE_SAFE_READ_ONLY_TOOLS]);
    expect(drLurieProjectConfig.allowedTools).toEqual(["ping", "registry_get", "object_inventory", "object_contract"]);
  });

  it("upgrades a persisted stale dr-lurie project config safely", async () => {
    const repository = new MemoryProjectRepository();
    await repository.save(staleDrLurieConfig());

    const upgraded = await repository.get("dr-lurie");

    expect(upgraded?.definitionVersion).toBe(drLurieProjectConfig.definitionVersion);
    expect(upgraded?.allowedTools).toEqual(["ping", "registry_get", "object_inventory", "object_contract"]);
  });

  it("does not wipe user-added project configs during default migrations", async () => {
    const repository = new MemoryProjectRepository();
    await repository.save({ ...staleDrLurieConfig(), projectId: "custom-project", name: "Custom Project", allowedTools: ["custom_read"] });

    const projects = await repository.list();

    expect(projects.find((project) => project.projectId === "custom-project")?.allowedTools).toEqual(["custom_read"]);
  });

  it("project summary exposes only safe metadata, never the endpoint value or token", () => {
    const summary = toProjectSummary(drLurieProjectConfig, env);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("https://dr-lurie.example/mcp");
    expect(summary.connection).toEqual({ endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN" });
    expect(summary.publishingPolicy.publishEnabled).toBe(false);
  });

  it("resolves connection config from env and reports configured booleans", () => {
    expect(resolveProjectConnection(drLurieProjectConfig, env)).toMatchObject({ endpointConfigured: true, tokenConfigured: true });
    expect(resolveProjectConnection(drLurieProjectConfig, {} as NodeJS.ProcessEnv)).toMatchObject({ endpointConfigured: false, tokenConfigured: false, endpoint: undefined, token: undefined });
  });
});

describe("Dr. Lurie MCP adapter primitives", () => {
  it("test_connection performs a primitive initialize and returns only safe server info", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ initialize: { protocolVersion: "2025-06-18", serverInfo: { name: "dr-lurie-mcp", version: "1.0.0" } } }, calls);

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).testConnection();

    expect(result.ok).toBe(true);
    expect(result.server).toEqual({ name: "dr-lurie-mcp", version: "1.0.0", protocolVersion: "2025-06-18" });
    expect(calls.map((call) => call.method)).toEqual(["initialize"]);
    expect(calls[0].hasAuth).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("test_connection reports not-configured without attempting a request", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({}, calls);

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env: {} as NodeJS.ProcessEnv, transport }).testConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("DR_LURIE_MCP_ENDPOINT");
    expect(calls).toHaveLength(0);
  });

  it("list_tools returns safe remote tool names/descriptions only", async () => {
    const transport = fakeTransport({ "tools/list": { tools: [{ name: "content.get_schema", description: "Get schema", inputSchema: { secretField: true } }, { name: "content.validate" }] } });

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).listTools();

    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "content.get_schema", description: "Get schema" }, { name: "content.validate", description: undefined }]);
    expect(JSON.stringify(result.tools)).not.toContain("secretField");
  });

  it("callTool allows configured read-only tools and does not expose tokens", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true, pong: true } }, calls);

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).callTool("ping", { hello: "world" });

    expect(result).toMatchObject({ ok: true, projectId: "dr-lurie", tool: "ping", result: { ok: true, pong: true } });
    expect(calls.map((call) => call.method)).toEqual(["tools/call"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("callTool blocks publishing tools before transport", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true } }, calls);

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).callTool("publish_article", {});

    expect(result).toMatchObject({ ok: false, tool: "publish_article", error: "Tool is not allowed for project: publish_article" });
    expect(calls).toHaveLength(0);
  });

  it("callTool allows registry_get after a stale registry config is upgraded", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true, value: { slug: "home" } } }, calls);
    const repository = new MemoryProjectRepository();
    await repository.save(staleDrLurieConfig());
    const upgraded = await repository.get("dr-lurie");

    const result = await new ProjectMcpAdapter(upgraded!, { env, transport }).callTool("registry_get", { key: "home" });

    expect(result).toMatchObject({ ok: true, projectId: "dr-lurie", tool: "registry_get", result: { ok: true, value: { slug: "home" } } });
    expect(calls.map((call) => call.method)).toEqual(["tools/call"]);
  });

  it("publishing and write tools remain blocked after a stale registry config is upgraded", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true } }, calls);
    const repository = new MemoryProjectRepository();
    await repository.save(staleDrLurieConfig());
    const upgraded = await repository.get("dr-lurie");

    const publish = await new ProjectMcpAdapter(upgraded!, { env, transport }).callTool("publish_article", {});
    const write = await new ProjectMcpAdapter(upgraded!, { env, transport }).callTool("save_json_blob_article", {});

    expect(publish.ok).toBe(false);
    expect(write.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("discovers contract/schema surfaces when the remote exposes them", async () => {
    const transport = fakeTransport({ "tools/list": { tools: [{ name: "content.get_schema" }, { name: "other.tool" }] }, "resources/list": { resources: [{ uri: "contract://content_source.v1" }] } });

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).discoverContract();

    expect(result.available).toBe(true);
    expect(result.schemaTools).toEqual(["content.get_schema"]);
    expect(result.resources).toEqual(["contract://content_source.v1"]);
  });

  it("dry validation calls a remote validate tool with dryRun when available", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/list": { tools: [{ name: "content.validate" }] }, "tools/call": { ok: true, valid: true } }, calls);

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).dryValidate({ articleBody: validArticleBody });

    expect(result).toMatchObject({ ok: true, available: true, toolName: "content.validate" });
    const toolCall = JSON.parse(calls.find((call) => call.method === "tools/call")!.body);
    expect(toolCall.params.arguments.dryRun).toBe(true);
  });

  it("dry validation reports unavailable when the remote has no validate tool", async () => {
    const transport = fakeTransport({ "tools/list": { tools: [{ name: "content.get_schema" }] } });
    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).dryValidate({ articleBody: validArticleBody });
    expect(result).toEqual({ ok: true, available: false });
  });

  it("surfaces a generic message when the remote returns a JSON-RPC error (no remote text)", async () => {
    const transport = fakeTransport({}); // initialize is unhandled -> remote JSON-RPC error
    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).testConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("The project MCP server returned an error.");
  });

  it("never leaks the endpoint or token in transport errors", async () => {
    const transport: McpTransport = async () => { throw new Error(`connect ECONNREFUSED https://dr-lurie.example/mcp token=${SECRET}`); };

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).testConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Failed to reach the project MCP endpoint.");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("project.validate_handoff structural checks", () => {
  it("accepts a well-formed content_source.v1 + article_body.v1 handoff", () => {
    const result = validateHandoff(drLurieProjectConfig, { contentSource: { artifact: "content_source.v1", summary: "Source summary." }, articleBody: validArticleBody });

    expect(result.valid).toBe(true);
    expect(result.contract).toEqual({ contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" });
    expect(result.checks.contentSource).toMatchObject({ present: true, valid: true });
    expect(result.checks.articleBody).toMatchObject({ present: true, valid: true });
  });

  it("rejects a malformed article_body handoff", () => {
    const result = validateHandoff(drLurieProjectConfig, { articleBody: { schema_version: "article_body.v1", nodes: [] } });

    expect(result.valid).toBe(false);
    expect(result.checks.articleBody.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("article_body.v1")]));
  });

  it("rejects a content_source without the required artifact tag", () => {
    const result = validateHandoff(drLurieProjectConfig, { contentSource: { summary: "Missing artifact tag." } });

    expect(result.valid).toBe(false);
    expect(result.checks.contentSource.valid).toBe(false);
  });

  it("requires at least one of contentSource/articleBody", () => {
    const result = validateHandoff(drLurieProjectConfig, {});

    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatch(/Provide contentSource/);
  });
});
