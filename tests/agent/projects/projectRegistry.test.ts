import { describe, expect, it } from "vitest";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { DR_LURIE_ALLOWED_TOOLS, DR_LURIE_ARTIFACT_TOOLS, DR_LURIE_RETIRED_LEGACY_TOOLS, DR_LURIE_SAFE_READ_ONLY_TOOLS, drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import { platformProjectConfig } from "../../../src/agent/projects/platform/definition.js";
import { defaultProjectConnections } from "../../../src/agent/projects/defaultProjects.js";
import { evaluateDrLurieCallToolPolicy } from "../../../src/agent/projects/drLurie/executablePolicy.js";
import { ProjectMcpAdapter, resolveProjectConnection } from "../../../src/agent/projects/projectMcpAdapter.js";
import { toProjectSummary, validateHandoff } from "../../../src/agent/projects/projectRegistry.js";
import type { McpTransport } from "../../../src/agent/projects/mcpClient.js";
import { effectiveToolPermission, type ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

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

// The client-shaped envelope the article_body node emits — validateHandoff now checks it against the
// node's OWN outputSchema (R-6/R-23 deleted the workspace-local {schema_version, nodes} monolith).
const validArticleBody = {
  artifact: "client_object.v1",
  summary: "Reader-facing body.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body: { slug: "example", title: "Title", nodes: [{ id: "n_x", kind: "content", public: { title: "Title", body: "Reader-facing body." } }] }
};

describe("project registry + Dr. Lurie definition", () => {
  it("memory project registry lists dr-lurie by default", async () => {
    const repository = new MemoryProjectRepository();
    const projects = await repository.list();

    expect(projects.map((project) => project.projectId)).toContain("dr-lurie");
    const drLurie = await repository.get("dr-lurie");
    expect(drLurie?.contentContract).toEqual({ contentContract: "content_source.v1" });
    expect(drLurie?.publishingPolicy).toMatchObject({ publishEnabled: true, requiresExplicitPublish: false });
  });

  it("dr-lurie allowedTools is the safe read-only tools plus the artifact/PDF capability", () => {
    expect(drLurieProjectConfig.allowedTools).toEqual([...DR_LURIE_ALLOWED_TOOLS]);
    expect(drLurieProjectConfig.allowedTools).toEqual([...DR_LURIE_SAFE_READ_ONLY_TOOLS, ...DR_LURIE_ARTIFACT_TOOLS]);
    // The read-only tools remain allowed, and the artifact/PDF tools are now callable.
    expect(drLurieProjectConfig.allowedTools).toEqual(expect.arrayContaining(["ping", "registry_get", "object_inventory", "object_contract"]));
    expect(drLurieProjectConfig.allowedTools).toContain("get_pdf_tool_storage_grant");
    expect(drLurieProjectConfig.allowedTools).toContain("create_artifact_from_url");
  });

  it("dr-lurie runs with full access: every non-retired tool is allowed by default", () => {
    expect(drLurieProjectConfig.defaultToolPolicy).toBe("allowed");
    // Publishing and commerce tools — not in allowedTools, but allowed via the default policy.
    for (const tool of ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin", "release_to_production", "trigger_netlify_build", "site_apply_theme", "product_set_price", "commerce_orders", "order_reissue"]) {
      expect(effectiveToolPermission(drLurieProjectConfig, tool)).toBe("allowed");
    }
  });

  // The ratified alignment doc froze the legacy pipeline and directed that save_json_blob_* is not to
  // be allowlisted for dr-lurie. Because this client's default policy is "allowed", "not allowlisted"
  // has to be spelled out as an explicit block — silence would mean allowed.
  it("dr-lurie blocks the retired legacy publish dialect and per-stage tools", () => {
    for (const tool of DR_LURIE_RETIRED_LEGACY_TOOLS) {
      expect(effectiveToolPermission(drLurieProjectConfig, tool), `${tool} must be blocked`).toBe("blocked");
    }
    expect(DR_LURIE_RETIRED_LEGACY_TOOLS).toEqual(expect.arrayContaining([
      "save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time", "save_json_blob_checkin_request",
      "reader_insight_update_output", "research_update_output", "angle_update_output", "draft_update_output", "final_article_update_output"
    ]));
    // And none of them may be reachable through the legacy allow-list either.
    for (const tool of DR_LURIE_RETIRED_LEGACY_TOOLS) expect(drLurieProjectConfig.allowedTools).not.toContain(tool);
  });

  // Defense in depth: even if a retired verb the blocklist does not name reached call_tool, the
  // executable policy refuses it by shape before any transport.
  it("the executable policy refuses retired-dialect tools by shape, including unenumerated variants", () => {
    for (const tool of ["save_json_blob_publish_by_time", "save_json_blob_some_new_verb", "final_article_mark_complete"]) {
      const findings = evaluateDrLurieCallToolPolicy({ tool, arguments: {} });
      expect(findings.some((finding) => finding.code === "blocked_retired_publish_dialect" && finding.severity === "error"), `${tool} must be refused`).toBe(true);
    }
    // The sanctioned object verbs are untouched.
    for (const tool of ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"]) {
      expect(evaluateDrLurieCallToolPolicy({ tool, arguments: {} })).toEqual([]);
    }
  });

  it("dr-lurie holds only wipe_blob_stores for approval as a safety valve", () => {
    expect(effectiveToolPermission(drLurieProjectConfig, "wipe_blob_stores")).toBe("needs_approval");
    expect(drLurieProjectConfig.toolPolicies).toMatchObject({ wipe_blob_stores: "needs_approval" });
    const heldForApproval = Object.entries(drLurieProjectConfig.toolPolicies ?? {}).filter(([, permission]) => permission === "needs_approval");
    expect(heldForApproval).toEqual([["wipe_blob_stores", "needs_approval"]]);
  });

  it("dr-lurie carries its per-site object-dialect parameters in config, not in the publish hook", () => {
    expect(drLurieProjectConfig.objectDialect).toEqual({
      siteObjectId: "site_drlurie",
      taxonomyRegistryObjectId: "tax_drlurie",
      objectIdSource: "request_id",
      requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$",
      // F1 (T-2, run_1785352838155_l544ye): object_contract's object_type argument, so the conductor
      // can prefetch and reduce the contract deterministically instead of the node discovering it.
      defaultObjectType: "content_item",
      // GUI rework Session B: object_get's object_id argument for the live editorial_voice singleton,
      // so the conductor can prefetch the client's voice deterministically instead of a node
      // discovering it (voicePrefetch.ts).
      voiceObjectId: "voice_drlurie"
    });
  });

  it("upgrades a persisted stale dr-lurie project config safely", async () => {
    const repository = new MemoryProjectRepository();
    await repository.save(staleDrLurieConfig());

    const upgraded = await repository.get("dr-lurie");

    expect(upgraded?.definitionVersion).toBe(drLurieProjectConfig.definitionVersion);
    expect(upgraded?.allowedTools).toEqual([...DR_LURIE_ALLOWED_TOOLS]);
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
    expect(summary.connection).toEqual({ endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN", endpointSource: "env" });
    expect(summary.publishingPolicy.publishEnabled).toBe(true);
  });

  it("resolves connection config from env and reports configured booleans", () => {
    expect(resolveProjectConnection(drLurieProjectConfig, env)).toMatchObject({ endpointConfigured: true, tokenConfigured: true });
    expect(resolveProjectConnection(drLurieProjectConfig, {} as NodeJS.ProcessEnv)).toMatchObject({ endpointConfigured: false, tokenConfigured: false, endpoint: undefined, token: undefined });
  });
});

// T-2 re-run (run_1785405350649_9u5mjz): platform was registered live via project.create (W-1) but,
// unlike dr-lurie/pdf-tool/monetizer, was never in defaultProjectConnections — a project not in that
// list is a guaranteed no-op for migrateDefaultProjectConfig, so it never once picked up the F1
// object-dialect parameters dr-lurie got in wave 14. contract_intelligence's conductor prefetch
// silently fell back to its own discovery for platform as a result, and cost went UP ($2.57 -> $3.79)
// instead of down.
describe("platform project definition", () => {
  it("memory project registry lists platform by default", async () => {
    const repository = new MemoryProjectRepository();
    const projects = await repository.list();

    expect(projects.map((project) => project.projectId)).toContain("platform");
    const platform = await repository.get("platform");
    expect(platform?.contentContract).toEqual({ contentContract: "content_source.v1" });
    expect(platform?.status).toBe("active");
  });

  it("carries its per-site object-dialect parameters in config, not in the publish hook", () => {
    expect(platformProjectConfig.objectDialect).toEqual({
      siteObjectId: "site_platform",
      taxonomyRegistryObjectId: "tax_platform",
      objectIdSource: "server_minted",
      requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$",
      defaultObjectType: "content_item"
    });
  });

  it("mirrors the live-tuned tool policy (full access, with the same approval carve-outs)", () => {
    expect(platformProjectConfig.defaultToolPolicy).toBe("allowed");
    for (const tool of ["object_contract", "registry_get", "object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin", "release_to_production", "deploy_status"]) {
      expect(effectiveToolPermission(platformProjectConfig, tool)).toBe("allowed");
    }
    for (const tool of ["object_retire", "object_review_decide", "site_apply_theme", "wipe_blob_stores"]) {
      expect(effectiveToolPermission(platformProjectConfig, tool)).toBe("needs_approval");
    }
  });

  it("upgrades a persisted live-only platform record (no definitionVersion) safely", async () => {
    const repository = new MemoryProjectRepository();
    // The live record predates this file: no definitionVersion, no objectDialect — exactly what
    // project.get(platform) showed before this fix.
    const { objectDialect: _drop, definitionVersion: _dropVersion, ...liveOnlyRecord } = structuredClone(platformProjectConfig);
    await repository.save(liveOnlyRecord as ProjectConnectionConfig);

    const upgraded = await repository.get("platform");

    expect(upgraded?.definitionVersion).toBe(platformProjectConfig.definitionVersion);
    expect(upgraded?.objectDialect).toEqual(platformProjectConfig.objectDialect);
  });

  // CHANGE-PLAN W-2 precedent: membership in defaultProjectConnections is what makes
  // project.delete refuse an id ("default_project_protected", because a seeded project is
  // re-created on the next read) — see projectAdminTools.test.ts for the guard itself.
  it("is now a code-defined default, and therefore protected from deletion", () => {
    expect(defaultProjectConnections.map((project) => project.projectId)).toContain("platform");
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

  it("callTool forwards publishing tools now that dr-lurie has full access", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true, published: true } }, calls);

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).callTool("object_publish", {});

    expect(result).toMatchObject({ ok: true, tool: "object_publish", permission: "allowed", result: { ok: true, published: true } });
    expect(calls.map((call) => call.method)).toEqual(["tools/call"]);
  });

  it("callTool holds a needs_approval tool before transport (requiresApproval, no call)", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true } }, calls);

    const result = await new ProjectMcpAdapter(drLurieProjectConfig, { env, transport }).callTool("wipe_blob_stores", {});

    expect(result).toMatchObject({ ok: false, tool: "wipe_blob_stores", permission: "needs_approval", requiresApproval: true });
    expect(result.error).toContain("requires approval");
    expect(calls).toHaveLength(0);
  });

  it("callTool blocks a tool explicitly set to blocked, before transport", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true } }, calls);
    const blockedConfig = { ...structuredClone(drLurieProjectConfig), toolPolicies: { object_publish: "blocked" as const } };

    const result = await new ProjectMcpAdapter(blockedConfig, { env, transport }).callTool("object_publish", {});

    expect(result).toMatchObject({ ok: false, tool: "object_publish", permission: "blocked", error: "Tool is not allowed for project: object_publish" });
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

  it("full access and the wipe_blob_stores safety valve are restored after a stale config is upgraded", async () => {
    const calls: RecordedCall[] = [];
    const transport = fakeTransport({ "tools/call": { ok: true } }, calls);
    const repository = new MemoryProjectRepository();
    await repository.save(staleDrLurieConfig());
    const upgraded = await repository.get("dr-lurie");

    expect(upgraded?.defaultToolPolicy).toBe("allowed");
    const publish = await new ProjectMcpAdapter(upgraded!, { env, transport }).callTool("object_publish", {});
    const wipe = await new ProjectMcpAdapter(upgraded!, { env, transport }).callTool("wipe_blob_stores", {});

    expect(publish.ok).toBe(true);
    expect(wipe).toMatchObject({ ok: false, requiresApproval: true, permission: "needs_approval" });
    // Only the allowed publish reached transport; the held wipe never did.
    expect(calls).toHaveLength(1);
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
    // #95 H2 fail-by-name, without leaking: the error carries the failure CLASS name (never a URL
    // or token) so DNS/TLS/timeout stop being one indistinguishable string.
    expect(result.error).toMatch(/^client_unreachable \(\w+\): failed to reach the project MCP endpoint/);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("project.validate_handoff structural checks", () => {
  it("accepts a well-formed content_source.v1 + client_object.v1 handoff", () => {
    const result = validateHandoff(drLurieProjectConfig, { contentSource: { artifact: "content_source.v1", summary: "Source summary." }, articleBody: validArticleBody });

    expect(result.valid).toBe(true);
    // canonicalBodyContract is derived from the article_body node's own produces const, never from
    // project config (the canonicalArticleBody field was removed by R-23).
    expect(result.contract).toEqual({ contentContract: "content_source.v1", canonicalBodyContract: "client_object.v1" });
    expect(result.checks.contentSource).toMatchObject({ present: true, valid: true });
    expect(result.checks.articleBody).toMatchObject({ present: true, valid: true });
  });

  it("rejects a malformed article_body handoff", () => {
    const result = validateHandoff(drLurieProjectConfig, { articleBody: { schema_version: "client_object.v1", nodes: [] } });

    expect(result.valid).toBe(false);
    expect(result.checks.articleBody.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("client_object.v1")]));
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
