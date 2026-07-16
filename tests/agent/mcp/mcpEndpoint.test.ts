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

const validArticleBody = {
  schema_version: "article_body.v1",
  nodes: [
    {
      id: "n_Example",
      kind: "content",
      public: {
        title: "Example title",
        body: "Visible reader-facing body copy."
      }
    }
  ]
};

const validateArticleBody = (articleBody: unknown, id = 50) => call({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "article_body.validate", arguments: { articleBody } }
});

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

  it("calls workspace.get_nodes without treating Markdown as canonical", async () => {
    const response = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace.get_nodes", arguments: {} } });
    const articleBodyNode = response.json.result.structuredContent.data.nodes.find((node: { id: string }) => node.id === "article_body");

    expect(response.json.result.structuredContent.ok).toBe(true);
    expect(response.json.result.structuredContent.data.nodes).toHaveLength(18);
    expect(response.json.result.structuredContent.data.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining(["input_triage", "article_body", "publish_payload", "publication_controller"]));
    expect(articleBodyNode.prompt).toContain("article_body.v1");
    expect(articleBodyNode.prompt).toContain("Markdown is not canonical");
    expect(articleBodyNode.schema.required).toEqual(["schema_version", "nodes"]);
  });

  it("updates workspace node prompt", async () => {
    const response = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace.update_node_prompt", arguments: { id: "article_body", prompt: "New prompt" } } });
    expect(response.json.result.structuredContent.data.node.prompt).toBe("New prompt");
  });

  it("validates canonical article_body.v1 bodies", async () => {
    const response = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "article_body.validate", arguments: { articleBody: validArticleBody } } });
    expect(response.json.result.structuredContent.data.valid).toBe(true);
  });

  it.each(["n_A1b2C3", "n_test123"])("accepts valid node id %s", async (nodeId) => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: nodeId, kind: "content", public: { title: "Valid node" } }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(true);
  });

  it.each(["abc123", ""])("rejects invalid node id %s", async (nodeId) => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: nodeId, kind: "content", public: { title: "Invalid node" } }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("rejects article_body.v1 bodies with empty nodes", async () => {
    const response = await call({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "article_body.validate", arguments: { articleBody: { schema_version: "article_body.v1", nodes: [] } } } });
    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("rejects invalid node kind", async () => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_InvalidKind", kind: "section", public: { title: "Invalid kind" } }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("rejects empty public node content", async () => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_EmptyPublic", kind: "content", public: {} }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it.each([
    { ctaText: "Read more" },
    { ctaLink: "https://example.com/read-more" }
  ])("rejects incomplete CTA fields %#", async (publicFields) => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_Cta", kind: "action", public: publicFields }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("rejects empty media objects", async () => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_EmptyMedia", kind: "content", public: { media: {} } }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it.each(["internal", "hidden"])("rejects article bodies with only %s visibility nodes", async (visibility) => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_NotVisible", kind: "content", visibility, public: { title: "Not reader visible" } }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("rejects private node visibility", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: {
        name: "article_body.validate",
        arguments: {
          articleBody: {
            schema_version: "article_body.v1",
            nodes: [{ id: "n_Private", kind: "content", visibility: "private", public: { title: "Private title" } }]
          }
        }
      }
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("accepts internal visibility when another node is reader-visible", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 54,
      method: "tools/call",
      params: {
        name: "article_body.validate",
        arguments: {
          articleBody: {
            schema_version: "article_body.v1",
            nodes: [
              { id: "n_Internal", kind: "content", visibility: "internal", public: { title: "Internal planning title" } },
              { id: "n_Public", kind: "content", visibility: "public", public: { body: "Reader-facing body." } }
            ]
          }
        }
      }
    });

    expect(response.json.result.structuredContent.data.valid).toBe(true);
  });

  it("accepts supported public media with a materialized image src", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 55,
      method: "tools/call",
      params: {
        name: "article_body.validate",
        arguments: {
          articleBody: {
            schema_version: "article_body.v1",
            nodes: [{ id: "n_Media", kind: "content", public: { media: { type: "image", src: "/media/req_demo/image.jpg", alt: "Example image" } } }]
          }
        }
      }
    });

    expect(response.json.result.structuredContent.data.valid).toBe(true);
  });

  it.each([
    "https://example.com/image.jpg",
    "http://example.com/image.jpg",
    "//cdn.example.com/image.jpg",
    "data:image/png;base64,iVBORw0KGgo="
  ])("rejects a remote/data image src (%s) that is not materialized by the backend", async (src) => {
    const response = await validateArticleBody({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_Remote", kind: "content", public: { media: { type: "image", src, alt: "Remote image" } } }]
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("rejects unsupported public media types", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 56,
      method: "tools/call",
      params: {
        name: "article_body.validate",
        arguments: {
          articleBody: {
            schema_version: "article_body.v1",
            nodes: [{ id: "n_Media", kind: "content", public: { media: { type: "document", src: "https://example.com/file.pdf", alt: "Example document" } } }]
          }
        }
      }
    });

    expect(response.json.result.structuredContent.data.valid).toBe(false);
  });

  it("exposes JSON Schema constraints matching runtime article_body.v1 validation", async () => {
    const response = await call({ jsonrpc: "2.0", id: 57, method: "tools/call", params: { name: "article_body.get_schema", arguments: {} } });
    const schema = response.json.result.structuredContent.data.schema;
    const nodeSchema = schema.properties.nodes.items;
    const publicSchema = nodeSchema.properties.public;
    const mediaSchema = publicSchema.properties.media;

    expect(schema.properties.schema_version.const).toBe("article_body.v1");
    expect(nodeSchema.properties.id.pattern).toBe("^n_[A-Za-z0-9]+$");
    expect(nodeSchema.properties.visibility.enum).toEqual(["public", "internal", "hidden"]);
    expect(nodeSchema.properties.kind.enum).toEqual(["content", "action", "placement", "interactive"]);
    expect(publicSchema.anyOf).toEqual(expect.arrayContaining([{ required: ["title"] }, { required: ["body"] }, { required: ["media"] }]));
    expect(publicSchema.dependentRequired).toEqual({ ctaText: ["ctaLink"], ctaLink: ["ctaText"] });
    expect(mediaSchema.required).toEqual(["type"]);
    expect(mediaSchema.anyOf).toEqual([{ required: ["src"] }, { required: ["artifactReference"] }, { required: ["embed"] }]);
    expect(mediaSchema.properties.type.enum).toEqual(["image", "video", "audio", "embed"]);
  });

  it("rejects markdown-first article objects", async () => {
    const response = await call({ jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "article_body.validate", arguments: { article: { title: "T", bodyMarkdown: "Body", slug: "valid-slug" } } } });
    expect(response.json.error.code).toBe(-32603);
    expect(response.json.error.data.error.code).toBe("validation_error");
  });

  it("validates publish payloads against the full dry-run canonical article body payload schema", async () => {
    const built = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "publish.build_payload", arguments: { articleBody: validArticleBody, target: "preview" } } });
    const valid = await call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "publish.validate_payload", arguments: { payload: built.json.result.structuredContent.data.payload } } });
    const invalid = await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "publish.validate_payload", arguments: { payload: { article: { title: "T", bodyMarkdown: "Body", slug: "valid-slug" }, target: "preview", dryRun: true, builtAt: new Date().toISOString() } } } });

    expect(built.json.result.structuredContent.data.payload.articleBody).toEqual(validArticleBody);
    expect(valid.json.result.structuredContent.data.valid).toBe(true);
    expect(invalid.json.result.structuredContent.data.valid).toBe(false);
  });

  it("rejects invalid workspace imports before mutating the store", async () => {
    const importResponse = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workspace.import_workspace", arguments: { nodes: [{ id: "bad-node", name: "Bad", prompt: "Bad", schema: {}, updatedAt: "not-a-date" }] } } });
    const getResponse = await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "workspace.get_node", arguments: { id: "bad-node" } } });

    expect(importResponse.json.error.code).toBe(-32603);
    expect(importResponse.json.error.data.error.code).toBe("validation_error");
    expect(getResponse.json.result.structuredContent.data.node).toBeNull();
  });
});
