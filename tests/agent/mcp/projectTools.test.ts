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

// The client-shaped envelope the article_body node emits — validate_handoff checks it against the
// node's OWN outputSchema (R-6/R-23 deleted the workspace-local {schema_version, nodes} monolith).
const validArticleBody = {
  artifact: "client_object.v1",
  summary: "Reader-facing body.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body: { slug: "example", title: "Title", nodes: [{ id: "n_x", kind: "content", public: { title: "Title", body: "Reader-facing body." } }] }
};

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

    expect(project.connection).toEqual({ endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN", endpointSource: "env" });
    expect(JSON.stringify(project)).not.toContain(SECRET);
  });

  it("project.list and project.get expose the platform capture policy without connection secrets", async () => {
    const listed = structured(await toolCall("project.list")).data.projects.find((project: { projectId: string }) => project.projectId === "platform");
    const fetched = structured(await toolCall("project.get", { projectId: "platform" })).data.project;

    expect(listed.capturePolicy).toEqual(fetched.capturePolicy);
    expect(fetched.capturePolicy).toMatchObject({
      maxPages: 20,
      allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
      sameOriginOnly: true,
      respectRobots: true,
      concurrency: 1,
      delayMs: 1500,
      authenticatedAccess: "prohibited"
    });
    expect(fetched.capturePolicy.designReferences).toEqual([expect.objectContaining({ origin: "https://prconsulting.net", crawlAllowed: false, contentReuse: "prohibited", mediaReuse: "prohibited" })]);
    expect(JSON.stringify(fetched)).not.toContain(SECRET);
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

  it("project.call_tool blocks legacy artifact fallback tools before any remote call", async () => {
    // dr-lurie's config advertises these as allowed, but the executable policy blocks them so no
    // transport happens — artifacts must go through the sanctioned materialization flow.
    for (const tool of ["save_artifact", "create_artifact_from_url", "create_artifact_upload_intent"]) {
      const response = await toolCall("project.call_tool", { projectId: "dr-lurie", tool, arguments: {} });
      expect(structured(response).data.call).toMatchObject({ ok: false, tool, permission: "blocked", blockedByPolicy: true });
      expect(structured(response).data.call.policyFindings.map((finding: { code: string }) => finding.code)).toContain("blocked_legacy_artifact_tool");
    }
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.call_tool blocks fallback artifact-source arguments on an otherwise-allowed tool", async () => {
    // get_artifact_metadata is allowed, but a public remote image URL argument is a fallback source
    // and must be blocked before transport.
    const response = await toolCall("project.call_tool", { projectId: "dr-lurie", tool: "get_artifact_metadata", arguments: { source: "https://cdn.example.com/hero.png" } });
    expect(structured(response).data.call).toMatchObject({ ok: false, tool: "get_artifact_metadata", permission: "blocked", blockedByPolicy: true });
    expect(structured(response).data.call.policyFindings.map((finding: { code: string }) => finding.code)).toContain("blocked_remote_image_url");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.call_tool holds a needs_approval tool before any remote call", async () => {
    // dr-lurie runs with full access, but wipe_blob_stores is held for approval — it must not reach
    // the remote server until a human allows it.
    const wipe = await toolCall("project.call_tool", { projectId: "dr-lurie", tool: "wipe_blob_stores", arguments: {} });

    expect(structured(wipe).data.call).toMatchObject({ ok: false, tool: "wipe_blob_stores", permission: "needs_approval", requiresApproval: true });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.call_tool rejects an unknown project", async () => {
    const response = await toolCall("project.call_tool", { projectId: "does-not-exist", tool: "ping", arguments: {} });
    expect(response.json.error.code).toBe(-32603);
    expect(response.json.error.data.error.message).toContain("does-not-exist");
  });

  // project.call_read_tool — the read-only split of project.call_tool. T-2 proved contract_intelligence
  // could not fetch a client contract because project.call_tool's requiresApproval:true dropped it
  // from the node runner's effective tools whenever a run carried no approval context. This wire tool
  // gives the same read-only affordance an operator/script can call directly, gated by a fixed,
  // server-side allowlist rather than approval.
  it("advertises project.call_read_tool", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = response.json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("project_call_read_tool");
  });

  it("project.call_read_tool allows a permitted read op without approval and returns structured JSON without tokens", async () => {
    const response = await toolCall("project.call_read_tool", { projectId: "dr-lurie", tool: "object_contract", arguments: { object_type: "content_item" } });
    const { data } = structured(response);

    expect(data.call).toMatchObject({ ok: true, projectId: "dr-lurie", tool: "object_contract", result: { tool: "object_contract", received: { object_type: "content_item" } } });
    expect(remoteMethods).toEqual(["tools/call"]);
    expect(JSON.stringify(response.json)).not.toContain(SECRET);
    expect(JSON.stringify(response.json)).not.toContain(ENDPOINT);
  });

  // B1 (T-2, run_1785340011864_qpyjr0): reproduced live via tool_test with EXACTLY this shape —
  // toolId project.call_read_tool, a real-looking projectId/tool/arguments envelope — and it came
  // back { ok:false, error:{ code:"validation_error", message:"validation_error" } }. tool.test's
  // `input` field advertises no JSON-schema type, so an MCP client with no signal to send a nested
  // object sends the JSON text instead; executeTool's own inputSchema.parse then saw a string where
  // it expected {projectId, tool, arguments} and rejected it. The fix coerces a JSON-stringified
  // input back into an object at the execution gateway, so the exact call that used to fail —
  // routed through tool.test end to end, not called directly — now actually reaches the contract.
  it("tool.test forwarding a JSON-stringified input still reaches the contract call, not a validation_error", async () => {
    const response = await toolCall("tool.test", { toolId: "project.call_read_tool", nodeId: "external_test", input: JSON.stringify({ projectId: "dr-lurie", tool: "object_contract", arguments: { object_type: "content_item" } }) });
    const { data } = structured(response);

    expect(data.ok).toBe(true);
    expect(data.error).toBeUndefined();
    expect(data.output.data.call).toMatchObject({ ok: true, projectId: "dr-lurie", tool: "object_contract", result: { tool: "object_contract", received: { object_type: "content_item" } } });
    expect(remoteMethods).toEqual(["tools/call"]);
  });

  it("project.call_read_tool refuses an operation outside the fixed allowlist, before any transport, naming the attempted operation", async () => {
    for (const tool of ["object_create", "object_patch", "object_publish", "release_to_production"]) {
      const response = await toolCall("project.call_read_tool", { projectId: "dr-lurie", tool, arguments: {} });
      const { data } = structured(response);
      expect(data.call).toMatchObject({ ok: false, tool, code: "read_tool_operation_not_permitted" });
      expect(data.call.error).toContain(tool);
    }
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.call_read_tool still honors the executable policy's fallback-source blocks on an allowlisted op", async () => {
    // object_get is on the read allowlist; the remote-image-URL argument is what must be blocked.
    const response = await toolCall("project.call_read_tool", { projectId: "dr-lurie", tool: "object_get", arguments: { src: "https://cdn.example.com/hero.png" } });
    expect(structured(response).data.call).toMatchObject({ ok: false, tool: "object_get", permission: "blocked", blockedByPolicy: true });
    expect(structured(response).data.call.policyFindings.map((finding: { code: string }) => finding.code)).toContain("blocked_remote_image_url");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.call_read_tool still honors a project's own toolPolicies block on an allowlisted operation", async () => {
    // A fresh project can still hold object_contract back even though it is on the fixed allowlist —
    // the allowlist bounds what CAN be reached through this tool, never what a project must allow.
    const created = await toolCall("project.create", { project: { projectId: "read-tool-block-test", name: "Read Tool Block Test", mcpEndpointEnvVar: "READ_TOOL_BLOCK_TEST_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "blocked", toolPolicies: { object_contract: "blocked" } } });
    expect(structured(created).data.project.projectId).toBe("read-tool-block-test");

    const response = await toolCall("project.call_read_tool", { projectId: "read-tool-block-test", tool: "object_contract", arguments: {} });
    expect(structured(response).data.call).toMatchObject({ ok: false, tool: "object_contract", permission: "blocked" });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.call_read_tool rejects an unknown project", async () => {
    const response = await toolCall("project.call_read_tool", { projectId: "does-not-exist", tool: "object_contract", arguments: {} });
    expect(response.json.error.code).toBe(-32603);
    expect(response.json.error.data.error.message).toContain("does-not-exist");
  });

  it("project.call_tool remains exactly as it was — still write, still requiresApproval, unaffected by the read split", async () => {
    const wipe = await toolCall("project.call_tool", { projectId: "dr-lurie", tool: "wipe_blob_stores", arguments: {} });
    expect(structured(wipe).data.call).toMatchObject({ ok: false, tool: "wipe_blob_stores", permission: "needs_approval", requiresApproval: true });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("project.validate_handoff checks content_source.v1 / client_object.v1 structure locally", async () => {
    const valid = await toolCall("project.validate_handoff", { projectId: "dr-lurie", contentSource: { artifact: "content_source.v1", summary: "s" }, articleBody: validArticleBody });
    const invalid = await toolCall("project.validate_handoff", { projectId: "dr-lurie", articleBody: { schema_version: "client_object.v1", nodes: [] } });

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
