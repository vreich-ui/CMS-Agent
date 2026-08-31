import { describe, expect, it, beforeEach } from "vitest";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { handler } from "../../../netlify/functions/mcp.mjs";

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
    // T15.6 release_executor) + 11 capture_conductor + 9 clone_conductor own nodes, additively seeded
    // into the store by T15.16 (#195) so they are governance-visible through workspace.get_nodes too.
    expect(response.json.result.structuredContent.data.nodes).toHaveLength(49);
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
