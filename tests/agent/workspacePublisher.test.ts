import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { startDryRun } from "../../src/agent/workspace/executor.js";
import { publishRun, publishEnabledEnvVar, isProjectPublishEnabled, __test__ } from "../../src/agent/workspace/publisher.js";
import { drLurieProjectConfig } from "../../src/agent/projects/drLurie/definition.js";
import type { CallToolResult } from "../../src/agent/projects/projectMcpAdapter.js";
import { handler } from "../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

const textBody = { schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "Live Title", body: "Reader-facing body." } }] };
const imageBody = { schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "T", body: "B", media: { type: "image", src: "/media/req/x.png", alt: "x" } } }] };
const REQUEST_ID = "req_publish_test_20260716_01";
const ENABLED_ENV = { [publishEnabledEnvVar(drLurieProjectConfig)]: "true" } as NodeJS.ProcessEnv;

const seedRun = async (articleBody: unknown) => {
  const manager = new RepositoryManager();
  const executionRepository = manager.getExecutionRepository();
  const projectRepository = manager.getProjectRepository();
  const run = await startDryRun({ projectId: "dr-lurie", input: "publish", entrypoint: { nodeId: "article_body", output: articleBody } }, executionRepository);
  const learningRepository = manager.getLearningRepository();
  return { runId: run.runId, executionRepository, projectRepository, learningRepository };
};

const fakeCallTool = (opts: { failOn?: string; noLock?: boolean } = {}) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    calls.push({ tool, args });
    if (opts.failOn === tool) return { ok: false, projectId: "dr-lurie", connection: {} as any, tool, error: `${tool} boom` };
    if (tool === "save_json_blob_checkout_request") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: opts.noLock ? {} : { structuredContent: { lock_token: "lock_123" } } };
    if (tool === "save_json_blob_publish_by_time") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { ok: true, statusCode: 201, commit: "abc123def", path: "src/pages/post/live-title.md", warnings: [] } };
    return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { ok: true } };
  };
  return { fn, calls };
};

describe("live publish gates", () => {
  it("derives the per-project operator env flag name and reads it", () => {
    expect(publishEnabledEnvVar(drLurieProjectConfig)).toBe("DR_LURIE_PUBLISH_ENABLED");
    expect(isProjectPublishEnabled(drLurieProjectConfig, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isProjectPublishEnabled(drLurieProjectConfig, { DR_LURIE_PUBLISH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("returns a dry-run plan and performs NO external calls when gates are unmet", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    // Operator not enabled, no approval, not live.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID }, { ...ctx, env: {} as NodeJS.ProcessEnv, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "dry_run") {
      expect(result.plan.toolSequence).toEqual(["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time", "save_json_blob_checkin_request"]);
      expect(result.plan.nodeCount).toBe(1);
      expect(result.gates.gates.find((gate) => gate.name === "operator_enabled")?.passed).toBe(false);
    }
  });

  it("still returns a dry-run plan when approval+live are set but the operator has NOT enabled publishing", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true }, { ...ctx, env: {} as NodeJS.ProcessEnv, callTool: adapter.fn });
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
  });

  it("executes the sanctioned publish sequence in order only when EVERY gate passes", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(true);
    expect(result.mode).toBe("live");
    expect(adapter.calls.map((call) => call.tool)).toEqual(["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time", "save_json_blob_checkin_request"]);
    // The draft carries the canonical content_source envelope with the article body.
    const draft = adapter.calls[0].args as any;
    expect(draft.request_id).toBe(REQUEST_ID);
    expect(draft.input.record_type).toBe("content_source");
    expect(draft.input.content.article_body.nodes).toHaveLength(1);
    // publish_by_time carries the lock token resolved from checkout.
    expect((adapter.calls[2].args as any).lock_token).toBe("lock_123");
    if (result.mode === "live") expect((result.result as any).statusCode).toBe(201);
  });

  it("rejects an invalid request_id before any call", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: "my-article-1", approved: true, live: true }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("invalid_request_id");
    expect(adapter.calls).toHaveLength(0);
  });

  it("refuses to publish a body carrying image media on this path", async () => {
    const ctx = await seedRun(imageBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("image_media_unsupported");
    expect(adapter.calls).toHaveLength(0);
  });

  it("errors when the run has no valid article_body", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    const learningRepository = manager.getLearningRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "no-body" }, executionRepository); // full run, article_body not produced
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: run.runId, requestId: REQUEST_ID, approved: true, live: true }, { executionRepository, projectRepository, learningRepository, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("no_valid_article_body");
    expect(adapter.calls).toHaveLength(0);
  });

  it("aborts and reports the failing step when a publish call fails, and when the lock token is missing", async () => {
    const ctx = await seedRun(textBody);
    const failing = fakeCallTool({ failOn: "save_json_blob_publish_by_time" });
    const failed = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true }, { ...ctx, env: ENABLED_ENV, callTool: failing.fn });
    expect(failed.mode).toBe("error");
    if (failed.mode === "error") expect(failed.error).toContain("save_json_blob_publish_by_time");
    // create + checkout + publish attempted; checkin not reached.
    expect(failing.calls.map((call) => call.tool)).toEqual(["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time"]);

    const ctx2 = await seedRun(textBody);
    const noLock = fakeCallTool({ noLock: true });
    const missing = await publishRun({ runId: ctx2.runId, requestId: REQUEST_ID, approved: true, live: true }, { ...ctx2, env: ENABLED_ENV, callTool: noLock.fn });
    expect(missing.mode).toBe("error");
    if (missing.mode === "error") expect(missing.error).toContain("lock_token");
  });

  it("exposes a request_id validator that matches the Dr. Lurie contract", () => {
    expect(__test__.REQUEST_ID_PATTERN.test("req_publish_drlurie_20260702_01")).toBe(true);
    expect(__test__.REQUEST_ID_PATTERN.test("req_repair_skincare_20260702_99")).toBe(true);
    expect(__test__.REQUEST_ID_PATTERN.test("my-article-123")).toBe(false);
    expect(__test__.REQUEST_ID_PATTERN.test("req_publish_2026_01")).toBe(false);
  });
});

describe("workflow.publish_run MCP tool (gated end-to-end)", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; delete process.env.DR_LURIE_PUBLISH_ENABLED; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; delete process.env.DR_LURIE_PUBLISH_ENABLED; resetRepositoryManager(); });

  it("advertises workflow_publish_run and returns a gated dry-run plan with no operator flag set", async () => {
    const listed = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = JSON.parse(listed.body ?? "{}").result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("workflow_publish_run");

    const started = await call("workflow.start_dry_run", { projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: textBody });
    const runId = started.result.structuredContent.data.run.runId;

    // Even with approved+live, the operator env flag is unset, so it stays a dry-run plan.
    const res = await call("workflow.publish_run", { runId, requestId: REQUEST_ID, approved: true, live: true });
    const publish = res.result.structuredContent.data.publish;
    expect(publish.published).toBe(false);
    expect(publish.mode).toBe("dry_run");
    expect(publish.gates.gates.find((gate: { name: string }) => gate.name === "operator_enabled").passed).toBe(false);
  });
});
