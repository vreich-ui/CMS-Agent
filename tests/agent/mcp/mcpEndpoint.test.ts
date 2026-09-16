import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { handler } from "../../../netlify/functions/mcp.mjs";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import "../../../src/agent/operations/registerOperations.js";

const event = (body: unknown, token = "test-token") => ({
  httpMethod: "POST",
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body)
});

const call = async (body: unknown, token = "test-token") => {
  process.env.MCP_API_TOKEN = "test-token";
  const response = await handler(event(body, token));
  return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
};

// The client-shaped envelope the article_body node actually emits — its own outputSchema is the one
// remaining definition of "what a body is" (R-6 / R-23 deleted the workspace-local monolith).
const validArticleBody = {
  artifact: "client_object.v1",
  summary: "Reader-facing example body.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body: { slug: "example", title: "Example title", nodes: [{ id: "n_Example", kind: "content", public: { title: "Example title", body: "Visible reader-facing body copy." } }] }
};

// The deleted workspace-local monolith shape, kept only to assert it is refused everywhere.
const legacyArticleBody = {
  schema_version: "client_object.v1",
  nodes: [{ id: "n_Example", kind: "content", public: { title: "Example title", body: "Visible reader-facing body copy." } }]
};

describe("mcp endpoint", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    repositoryManager.getUsageRepository().clear();
  });

  it("rejects requests without bearer authorization", async () => {
    const response = await handler(event({ jsonrpc: "2.0", id: 1, method: "initialize" }, ""));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
  });

  it("rejects requests with an invalid bearer token", async () => {
    const response = await handler(event({ jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong-token"));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
  });

  it("returns 202 without a body for MCP notifications", async () => {
    const response = await handler(event({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
  });

  it("handles initialize requests", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json.result.serverInfo.name).toBe("publishing-workspace-mcp");
  });

  it("lists tools", async () => {
    const response = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    // tools/list serves canonical underscore names only (Anthropic tool-name pattern); the dotted
    // spellings remain accepted by tools/call for backward compatibility.
    expect(response.json.result.tools.map((tool: { name: string }) => tool.name)).toContain("workspace_get_nodes");
    expect(response.json.result.tools.map((tool: { name: string }) => tool.name)).toContain("usage_get_summary");
    expect(response.json.result.tools.map((tool: { name: string }) => tool.name)).toContain("repository_get_health");
  });

  it("MCP repository health tool returns safe diagnostics", async () => {
    const response = await call({ jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "repository.get_health", arguments: {} } });

    expect(response.json.result.structuredContent.data.health).toMatchObject({
      backend: "memory",
      storageHealth: "healthy",
      workspaceVersion: 0,
      workspace: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      execution: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      artifact: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      learning: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      usage: { backend: "memory", readable: true, writable: true, version: "memory.v1" }
    });
    expect(JSON.stringify(response.json.result.structuredContent.data.health)).not.toMatch(/token|secret|authorization|path/i);
  });

  it("MCP usage tools return structured JSON", async () => {
    const recorded = await call({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "usage.record", arguments: { runId: "run-mcp", projectId: "project-a", nodeId: "node-a", model: "gpt-5.5", provider: "openai", inputTokens: 10, outputTokens: 5, status: "estimated" } } });
    const summary = await call({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "usage.get_summary", arguments: { runId: "run-mcp" } } });
    const records = await call({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "usage.list_records", arguments: { runId: "run-mcp" } } });
    const budget = await call({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "usage.get_budget_status", arguments: { runId: "run-mcp", budgetUsd: 1 } } });

    expect(recorded.json.result.structuredContent).toMatchObject({ ok: true, data: { record: { totalTokens: 15, currency: "USD" } } });
    expect(summary.json.result.structuredContent.data.summary.recordCount).toBe(1);
    expect(records.json.result.structuredContent.data.records).toHaveLength(1);
    expect(budget.json.result.structuredContent.data.budgetStatus.status).toBe("ok");
  });

  // This used to assert the PRE-alignment article_body contract — a prompt naming "client_object.v1" and
  // "Markdown is not canonical", and a schema requiring {schema_version, nodes}. The contract-as-truth wave
  // generalized the node to a client-shaped envelope, and R-22's re-seed brought that generalization into
  // the canonical definitions. Asserting the old shape here would be a green test encoding the very defect
  // F-1/T6.3 named: a workspace-local article schema treated as authoritative.
  it("calls workspace.get_nodes and reports the client-shaped article_body contract", async () => {
    const response = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace.get_nodes", arguments: {} } });
    const articleBodyNode = response.json.result.structuredContent.data.nodes.find((node: { id: string }) => node.id === "article_body");

    expect(response.json.result.structuredContent.ok).toBe(true);
    // 24 publishing_conductor nodes (R-22 re-seed + §2.16 placement_resolver/monetization_strategy +
    // T15.6 release_executor) + 11 capture_conductor + 13 clone_conductor + C5's 2 visual_identity own
    // nodes + C3's 5 site_content_specialists own nodes, additively seeded into the store by T15.16
    // (#195) so they are governance-visible through workspace.get_nodes too. This file imports nothing
    // from workspaceStoreNodes.ts, so there is no in-file derivation to prefer over the literal
    // (workspaceStoreSeedNodes().length would just restate the module under test); left hardcoded.
    expect(response.json.result.structuredContent.data.nodes).toHaveLength(56);
    expect(response.json.result.structuredContent.data.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining(["input_triage", "contract_intelligence", "article_body", "artifact_plan", "publish_payload", "publication_controller", "publish_executor"]));
    // The client's fetched contract is the authority, and the envelope carries the provenance that proves
    // it was fetched rather than assumed.
    expect(articleBodyNode.prompt).toContain("the client's fetched contract is the ONLY authoritative content schema");
    expect(articleBodyNode.schema.required).toEqual(["artifact", "summary", "clientProjectId", "clientObjectType", "contractSource", "body"]);
    // No workspace-local article schema smuggled back in as a required field.
    expect(articleBodyNode.schema.required).not.toContain("schema_version");
  });

  it("updates workspace node prompt", async () => {
    const response = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace.update_node_prompt", arguments: { id: "article_body", prompt: "New prompt" } } });
    expect(response.json.result.structuredContent.data.node.prompt).toBe("New prompt");
  });

  // R-6: the article_body.* wire tools served the deleted workspace-local {schema_version, nodes}
  // monolith — a drifted local copy the article_body node itself rejects. They are retired outright,
  // not aliased: the node's own outputSchema is served by node.get_output_schema and enforced by
  // node.validate_output, and the client's own validator is the authority beyond it.
  it("no longer advertises or resolves the retired article_body.* tools", async () => {
    const listed = await call({ jsonrpc: "2.0", id: 50, method: "tools/list" });
    const names = listed.json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("article_body_validate");
    expect(names).not.toContain("article_body_get_schema");

    for (const name of ["article_body.validate", "article_body_validate", "article_body.get_schema", "article_body_get_schema"]) {
      const response = await call({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name, arguments: {} } });
      expect(response.json.error?.message ?? "").toMatch(/Unknown tool/);
    }
  });

  it("serves the article_body node's own outputSchema via node.get_output_schema, not a workspace-local article schema", async () => {
    const response = await call({ jsonrpc: "2.0", id: 57, method: "tools/call", params: { name: "node.get_output_schema", arguments: { nodeId: "article_body" } } });
    const schema = response.json.result.structuredContent.data.schema;
    expect(schema.required).toEqual(["artifact", "summary", "clientProjectId", "clientObjectType", "contractSource", "body"]);
    expect(schema.properties.artifact.const).toBe("client_object.v1");
    // The deleted monolith's discriminator must not resurface.
    expect(schema.properties).not.toHaveProperty("schema_version");
  });

  it("validates publish payloads against the article_body node's own outputSchema", async () => {
    const built = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "publish.build_payload", arguments: { articleBody: validArticleBody, target: "preview" } } });
    const valid = await call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "publish.validate_payload", arguments: { payload: built.json.result.structuredContent.data.payload } } });
    const invalid = await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "publish.validate_payload", arguments: { payload: { articleBody: legacyArticleBody, target: "preview", dryRun: true, builtAt: new Date().toISOString() } } } });

    expect(built.json.result.structuredContent.data.payload.articleBody).toEqual(validArticleBody);
    expect(valid.json.result.structuredContent.data.valid).toBe(true);
    // The deleted workspace-local monolith is exactly what no longer validates.
    expect(invalid.json.result.structuredContent.data.valid).toBe(false);
    expect(JSON.stringify(invalid.json.result.structuredContent.data.issues)).toContain("$.artifact is required");
  });

  it("refuses to build a publish payload from the deleted legacy body shape, naming the missing fields", async () => {
    const response = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "publish.build_payload", arguments: { articleBody: legacyArticleBody, target: "preview" } } });
    expect(response.json.error.code).toBe(-32603);
    expect(JSON.stringify(response.json.error.data)).toContain("invalid_article_body");
    expect(JSON.stringify(response.json.error.data)).toContain("$.artifact is required");
  });

  it("rejects invalid workspace imports before mutating the store", async () => {
    const importResponse = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workspace.import_workspace", arguments: { nodes: [{ id: "bad-node", name: "Bad", prompt: "Bad", schema: {}, updatedAt: "not-a-date" }] } } });
    const getResponse = await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "workspace.get_node", arguments: { id: "bad-node" } } });

    expect(importResponse.json.error.code).toBe(-32603);
    expect(importResponse.json.error.data.error.code).toBe("validation_error");
    expect(getResponse.json.result.structuredContent.data.node).toBeNull();
  });
});


// S-26 / K-M9 — a tenant's scoped bearer is pinned to its projects by the projectId/project_id
// argument, but run-addressed tools carry a runId and nothing else. Before this check a
// platform-scoped credential could read, approve and publish a dr-lurie run by naming its runId.
describe("scoped bearer tokens and run-addressed tools", () => {
  const SCOPED = "scoped-test-platform";
  const seedRun = async (runId: string, projectId: string) => {
    await repositoryManager.getExecutionRepository().createRun({
      runId,
      workflowId: "conductor",
      projectId,
      status: "running",
      startedAt: new Date().toISOString(),
      nodes: [],
      rev: 0
    } as unknown as WorkflowExecutionRecord);
  };

  const scopedCall = async (runId: string, name = "workflow_get_run") =>
    handler({
      httpMethod: "POST",
      headers: { authorization: `Bearer ${SCOPED}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { runId } } })
    });

  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    process.env.MCP_SCOPED_TOKENS_JSON = JSON.stringify({
      [SCOPED]: { projects: ["platform"], toolAllowlist: ["workflow_get_run"] }
    });
  });

  afterEach(() => {
    delete process.env.MCP_SCOPED_TOKENS_JSON;
  });

  it("refuses a run-addressed call for a run owned by a project outside the token's scope", async () => {
    await seedRun("run-foreign-1", "dr-lurie");
    const response = await scopedCall("run-foreign-1");
    expect(response.statusCode).toBe(401);
  });

  it("allows a run-addressed call for a run the token's own project owns", async () => {
    await seedRun("run-own-1", "platform");
    const response = await scopedCall("run-own-1");
    expect(response.statusCode).toBe(200);
  });

  // No existence oracle: an unknown run id is refused exactly like a foreign one, so the two cases
  // are indistinguishable to a caller probing for other tenants' run ids.
  it("refuses an unknown run id with the same response as a foreign run", async () => {
    await seedRun("run-foreign-2", "dr-lurie");
    const unknown = await scopedCall("run-does-not-exist");
    const foreign = await scopedCall("run-foreign-2");
    expect(unknown.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(foreign.statusCode);
    expect(unknown.body).toBe(foreign.body);
  });
});

// S-07 — feedback_list and learning_list_observations return the WHOLE workspace when no project is
// supplied, so unlike every other tool on a site bearer they cannot be bounded by the tool allowlist
// alone. mcpEndpoint.ts's PROJECT_REQUIRED_SCOPED_TOOLS makes a project mandatory for a scoped caller;
// the pre-existing membership check then refuses a foreign one.
describe("scoped bearer tokens and cross-project list tools", () => {
  const SCOPED = "scoped-test-drlurie";
  const seedRun = async (runId: string, projectId: string) => {
    await repositoryManager.getExecutionRepository().createRun({
      runId,
      workflowId: "conductor",
      projectId,
      status: "running",
      startedAt: new Date().toISOString(),
      nodes: [],
      rev: 0
    } as unknown as WorkflowExecutionRecord);
  };

  const post = async (token: string, args: Record<string, unknown>, name = "feedback_list") => {
    const response = await handler({
      httpMethod: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
    return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
  };
  const rowsOf = (response: { json?: any }): { projectId?: string; note?: string }[] =>
    response.json.result.structuredContent.data.records;

  beforeEach(async () => {
    process.env.MCP_API_TOKEN = "test-token";
    process.env.MCP_SCOPED_TOKENS_JSON = JSON.stringify({
      [SCOPED]: { projects: ["dr-lurie"], toolAllowlist: ["feedback_list", "learning_list_observations"] }
    });
    // One stamped row per project, plus an UNSTAMPED row whose run belongs to dr-lurie — the legacy
    // shape the filter has to rescue rather than drop.
    await seedRun("run-s07-drlurie", "dr-lurie");
    const evaluationRepository = repositoryManager.getEvaluationRepository();
    for (const record of [
      { feedbackId: "fb_s07_own", kind: "approve" as const, projectId: "dr-lurie", note: "own", createdAt: new Date().toISOString() },
      { feedbackId: "fb_s07_foreign", kind: "approve" as const, projectId: "fernwell", note: "foreign", createdAt: new Date().toISOString() },
      { feedbackId: "fb_s07_legacy", kind: "approve" as const, runId: "run-s07-drlurie", note: "legacy", createdAt: new Date().toISOString() }
    ]) await evaluationRepository.recordFeedback(record);
  });

  afterEach(() => {
    delete process.env.MCP_SCOPED_TOKENS_JSON;
  });

  it("refuses a scoped feedback_list that names no project at all — unfiltered, it returns every tenant", async () => {
    expect((await post(SCOPED, {})).statusCode).toBe(401);
  });

  it("refuses a scoped learning_list_observations that names no project at all", async () => {
    expect((await post(SCOPED, {}, "learning_list_observations")).statusCode).toBe(401);
  });

  it("refuses a scoped list naming a project outside the bearer's own scope", async () => {
    expect((await post(SCOPED, { projectId: "fernwell" })).statusCode).toBe(401);
  });

  it("allows the bearer's own project and returns only that project's rows", async () => {
    const response = await post(SCOPED, { projectId: "dr-lurie" });
    expect(response.statusCode).toBe(200);
    const notes = rowsOf(response).map((record) => record.note);
    expect(notes).toContain("own");
    expect(notes).toContain("legacy"); // unstamped, but its run belongs to dr-lurie
    expect(notes).not.toContain("foreign");
  });

  // A FULL bearer is unchanged: no project required, nothing filtered. The new refusal is a property
  // of the SCOPED path only.
  it("leaves a full bearer's unfiltered feedback_list exactly as it was", async () => {
    const response = await post("test-token", {});
    expect(response.statusCode).toBe(200);
    const notes = rowsOf(response).map((record) => record.note);
    expect(notes).toEqual(expect.arrayContaining(["own", "foreign", "legacy"]));
  });
});

// K-M11 (2026-09-13, owner-authorized fix) — operation.execute/operation.preflight scope entirely
// by `tenantId` (operationTools.ts), never `projectId`/`project_id`, and the pre-fix
// `requestedProject` (mcpEndpoint.ts) read only those two literal keys — so a scoped bearer for one
// tenant could name any OTHER tenant's `tenantId` and reach `operation_preflight` (already granted,
// #318) for it, unrefused. `requestedProject` now reads `tenantId`/`tenant_id` alongside
// `projectId`/`project_id` (same identifier space — see that function's own header and
// capabilityFactsLoader.ts), refusing any call where the recognized spellings disagree. This block
// used to PROVE THE GAP; it now proves the fix, for both tools that carry `tenantId`
// (`operation_execute`, `operation_preflight`), both spellings (`tenantId` and `tenant_id`), and
// keeps an own-tenant success path so "refuse everything" cannot pass silently. `mcpEndpoint.ts`'s
// auth order and the rest of its scoped-request checks are unchanged — only the set of argument keys
// `requestedProject` reads was widened.
describe("scoped bearer tokens and operation.execute/operation.preflight's tenantId (K-M11)", () => {
  const SCOPED_PLATFORM = "scoped-test-platform-opexec";
  const SCOPED_DRLURIE = "scoped-test-drlurie-opexec";

  beforeEach(() => {
    resetRepositoryManager();
    process.env.MCP_API_TOKEN = "test-token";
    process.env.MCP_SCOPED_TOKENS_JSON = JSON.stringify({
      [SCOPED_PLATFORM]: { projects: ["platform"], toolAllowlist: ["operation_execute", "operation_preflight"] },
      [SCOPED_DRLURIE]: { projects: ["dr-lurie"], toolAllowlist: ["operation_execute", "operation_preflight"] }
    });
  });

  afterEach(() => {
    delete process.env.MCP_SCOPED_TOKENS_JSON;
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  const scopedCall = async (token: string, name: string, args: Record<string, unknown>) => {
    const response = await handler({
      httpMethod: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
    return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
  };

  for (const tool of ["operation_execute", "operation_preflight"]) {
    it(`refuses a bearer scoped to "platform" naming a foreign tenantId ("dr-lurie") for ${tool}`, async () => {
      const response = await scopedCall(SCOPED_PLATFORM, tool, { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
      expect(response.statusCode).toBe(401);
    });

    it(`refuses the same foreign tenant spelled tenant_id (snake_case) for ${tool}`, async () => {
      const response = await scopedCall(SCOPED_PLATFORM, tool, { operationId: "site_inventory", tenant_id: "dr-lurie", input: { tenantId: "dr-lurie" } });
      expect(response.statusCode).toBe(401);
    });
  }

  // The widened check requires every recognized spelling present on a call to agree — a call naming
  // its OWN project but a FOREIGN tenantId is refused exactly like naming the foreign tenantId alone,
  // not "whichever key resolves first wins".
  it("refuses a call whose projectId and tenantId disagree, even when projectId names the bearer's own project", async () => {
    const response = await scopedCall(SCOPED_PLATFORM, "operation_preflight", { operationId: "site_inventory", projectId: "platform", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(response.statusCode).toBe(401);
  });

  // Positive control: the fix does not "refuse everything". A bearer scoped to dr-lurie naming its
  // OWN tenantId is let through to the tool.
  it("allows a bearer scoped to \"dr-lurie\" naming its own tenantId", async () => {
    const response = await scopedCall(SCOPED_DRLURIE, "operation_preflight", { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(response.statusCode).toBe(200);
    expect(response.json.result.structuredContent.data).toMatchObject({ operationId: "site_inventory", executable: true });
  });

  // Reachable by a scoped chat bearer for its OWN tenant, and A4's read-only gate still refuses a
  // non-read operation through this transport — the gate lives in the tool (checkOperationIsReadOnly)
  // and is not bypassed by reaching it via a scoped bearer instead of the full bearer.
  it("reached through a scoped bearer for its OWN tenant, a non-read operation is still refused — the read-only gate is not bypassed by this transport", async () => {
    const response = await scopedCall(SCOPED_DRLURIE, "operation_execute", { operationId: "document_render", tenantId: "dr-lurie", input: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json.result.structuredContent.data).toMatchObject({ executed: false, refusal: { code: "not_read_only" } });
  });

  // Reachable by a scoped chat bearer for its own tenant, executing a genuine read-only operation end
  // to end (mirrors operationExecuteTool.test.ts's full-bearer version of this same scenario, through
  // the scoped-bearer transport instead, now that the bearer's own tenant ("dr-lurie") matches the
  // tenantId it names).
  it("reached through a scoped bearer for its OWN tenant, site_inventory (read-only) executes end to end", async () => {
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    const remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method !== "tools/call") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }) } as unknown as Response;
      const toolName = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      const result =
        toolName === "object_inventory" && args.object_type === "visual_standard"
          ? { structuredContent: { items: [{ object_id: "vis_drlurie", object_type: "visual_standard", version: 3, content_revision: 2, status: "active", updated_at: "2026-09-01T00:00:00.000Z" }] } }
          : toolName === "object_contract" && args.object_type === "visual_standard"
            ? { structuredContent: { contract: { body_schema: { type: "object", required: [], properties: {} } } } }
            : toolName === "registry_get"
              ? { structuredContent: { items: [] } }
              : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);

    const response = await scopedCall(SCOPED_DRLURIE, "operation_execute", { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", objectType: "visual_standard" } });
    expect(response.statusCode).toBe(200);
    expect(response.json.result.structuredContent.data.executed).toBe(true);
    expect(response.json.result.structuredContent.data.refusal).toBeNull();
    expect(response.json.result.structuredContent.data.result.objects).toEqual([
      expect.objectContaining({ objectId: "vis_drlurie", objectType: "visual_standard", status: "active" })
    ]);
  });
});
