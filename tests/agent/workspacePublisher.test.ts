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
const blobMediaBody = { schema_version: "article_body.v1", nodes: [{ id: "n_img", kind: "content", visibility: "public", public: { title: "T", body: "B", media: { type: "image", src: "image/req_x/abc123.png", alt: "x" } } }] };
const REQUEST_ID = "req_publish_test_20260716_01";
const ENABLED_ENV = { [publishEnabledEnvVar(drLurieProjectConfig)]: "true" } as NodeJS.ProcessEnv;
// Satisfies Dr. Lurie's publish-readiness policy (GO) so the underlying gate logic can be exercised.
const READY = {
  taxonomy: { tags: ["science", "longevity"] },
  approval: { pinned: true, approvedBy: "editor@dr-lurie" },
  releaseBehavior: "publish_now",
  hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
};

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

  it("returns a dry-run plan and performs NO external calls when readiness is GO but gates are unmet", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, readiness: READY }, { ...ctx, env: {} as NodeJS.ProcessEnv, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "dry_run") {
      expect(result.plan.toolSequence).toEqual(["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time", "save_json_blob_checkin_request"]);
      expect(result.readiness?.status).toBe("go");
      expect(result.gates.gates.find((gate) => gate.name === "operator_enabled")?.passed).toBe(false);
    }
  });

  it("executes the sanctioned publish sequence in order only when readiness is GO and EVERY gate passes", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(true);
    expect(result.mode).toBe("live");
    expect(adapter.calls.map((call) => call.tool)).toEqual(["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time", "save_json_blob_checkin_request"]);
    const draft = adapter.calls[0].args as any;
    expect(draft.input.record_type).toBe("content_source");
    expect((adapter.calls[2].args as any).lock_token).toBe("lock_123");
    if (result.mode === "live") expect((result.result as any).statusCode).toBe(201);
  });

  it("blocks with a resumable state when the readiness policy is NO-GO (no readiness inputs)", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    // Every gate is set, but no readiness inputs were supplied → Dr. Lurie readiness is NO-GO.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.mode).toBe("blocked_for_publish_execution");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "blocked_for_publish_execution") {
      expect(result.readiness.status).toBe("no_go");
      expect(result.readiness.blockers).toEqual(expect.arrayContaining(["taxonomy", "pinned_approval", "release_behavior", "hard_artifact_protocol", "hard_legacy_fallbacks"]));
      expect(result.blocked).toMatchObject({ requestId: REQUEST_ID, nodeAwaitingApproval: "publication_controller", resumable: true });
      expect(typeof result.blocked.requiredAction).toBe("string");
    }
  });

  it("blocks unverified Blob-shaped media and names the artifact slot", async () => {
    const ctx = await seedRun(blobMediaBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.mode).toBe("blocked_for_publish_execution");
    if (result.mode === "blocked_for_publish_execution") {
      expect(result.readiness.blockers).toContain("media_artifacts_verified");
      expect(result.blocked.artifactSlot).toBe("node:n_img/public.media");
    }
    expect(adapter.calls).toHaveLength(0);
  });

  it("rejects an invalid request_id before any call", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: "my-article-1", approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("invalid_request_id");
    expect(adapter.calls).toHaveLength(0);
  });

  it("refuses to execute a body carrying media on this text-only path even when readiness is GO", async () => {
    const ctx = await seedRun(imageBody);
    const adapter = fakeCallTool();
    // imageBody's /media/... src is not Blob-shaped, so readiness passes; execution is still text-only.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("image_media_unsupported");
    expect(adapter.calls).toHaveLength(0);
  });

  it("errors when the run has no valid article_body", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    const learningRepository = manager.getLearningRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "no-body" }, executionRepository);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: run.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { executionRepository, projectRepository, learningRepository, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("no_valid_article_body");
    expect(adapter.calls).toHaveLength(0);
  });

  it("aborts and reports the failing step when a publish call fails, and when the lock token is missing", async () => {
    const ctx = await seedRun(textBody);
    const failing = fakeCallTool({ failOn: "save_json_blob_publish_by_time" });
    const failed = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: failing.fn });
    expect(failed.mode).toBe("error");
    if (failed.mode === "error") expect(failed.error).toContain("save_json_blob_publish_by_time");
    expect(failing.calls.map((call) => call.tool)).toEqual(["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time"]);

    const ctx2 = await seedRun(textBody);
    const noLock = fakeCallTool({ noLock: true });
    const missing = await publishRun({ runId: ctx2.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx2, env: ENABLED_ENV, callTool: noLock.fn });
    expect(missing.mode).toBe("error");
    if (missing.mode === "error") expect(missing.error).toContain("lock_token");
  });

  it("exposes a request_id validator that matches the Dr. Lurie contract", () => {
    expect(__test__.REQUEST_ID_PATTERN.test("req_publish_drlurie_20260702_01")).toBe(true);
    expect(__test__.REQUEST_ID_PATTERN.test("my-article-123")).toBe(false);
    expect(__test__.REQUEST_ID_PATTERN.test("req_publish_2026_01")).toBe(false);
  });
});

describe("workflow.publish_run / publish_readiness MCP tools (gated end-to-end)", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; delete process.env.DR_LURIE_PUBLISH_ENABLED; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; delete process.env.DR_LURIE_PUBLISH_ENABLED; resetRepositoryManager(); });

  it("advertises both tools; a GO readiness with no operator flag yields a dry-run plan", async () => {
    const listed = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = JSON.parse(listed.body ?? "{}").result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["workflow_publish_run", "workflow_publish_readiness"]));

    const runId = (await data("workflow.start_dry_run", { projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: textBody })).run.runId;
    const publish = (await data("workflow.publish_run", { runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY })).publish;
    expect(publish.mode).toBe("dry_run");
    expect(publish.readiness.status).toBe("go");
    expect(publish.gates.gates.find((gate: { name: string }) => gate.name === "operator_enabled").passed).toBe(false);
  });

  it("publish_readiness returns the GO/NO-GO checklist without publishing", async () => {
    const runId = (await data("workflow.start_dry_run", { projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: textBody })).run.runId;

    const go = (await data("workflow.publish_readiness", { projectId: "dr-lurie", runId, readiness: READY })).readiness;
    expect(go).toMatchObject({ available: true, articleBodyValid: true });
    expect(go.readiness.status).toBe("go");

    const noGo = (await data("workflow.publish_readiness", { projectId: "dr-lurie", runId })).readiness;
    expect(noGo.readiness.status).toBe("no_go");
    expect(noGo.readiness.state).toBe("blocked_for_publish_execution");
    expect(noGo.readiness.checklist.map((check: { key: string }) => check.key)).toContain("article_body_valid");
  });

  it("reports available:false for a project without a readiness policy (other projects stay unblocked)", async () => {
    await data("project.create", { project: { projectId: "acme-live", name: "Acme", mcpEndpointEnvVar: "ACME_LIVE_MCP_ENDPOINT", authMode: "none" } });
    const readiness = (await data("workflow.publish_readiness", { projectId: "acme-live", articleBody: textBody })).readiness;
    expect(readiness.available).toBe(false);
    expect(readiness.readiness).toBeNull();
    expect(readiness.articleBodyValid).toBe(true);
  });
});
