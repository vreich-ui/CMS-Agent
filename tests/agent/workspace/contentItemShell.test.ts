import { afterEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import type { CallToolResult } from "../../../src/agent/projects/projectMcpAdapter.js";
import { ensureContentItemShell, readContentItemShell } from "../../../src/agent/workspace/contentItemShell.js";
import { publishEnabledEnvVar, publishRun } from "../../../src/agent/workspace/publisher.js";
import { getRun, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";

// S3 item 8 — the content-item shell: created once, idempotently, under the run's request id before
// artifact_plan runs on an object-substrate client; the publisher then patches it instead of creating.

const REQUEST_ID = "req_agent_shell_probe_20260818_01";
const ENABLED_ENV = { [publishEnabledEnvVar(drLurieProjectConfig)]: "true", DR_LURIE_MCP_ENDPOINT: "https://dr-lurie.example/mcp" } as NodeJS.ProcessEnv;
const PARAGRAPH = "This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today. ".repeat(2);

const fakeCreate = (behaviour: "created" | "exists" | "reject_idempotency" | "boom" = "created") => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn = async (_config: unknown, tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    calls.push({ tool, args });
    const base = { projectId: "dr-lurie", connection: {} as never, tool };
    if (behaviour === "boom") return { ...base, ok: false, error: "client_unreachable (TypeError)" };
    if (behaviour === "exists") return { ...base, ok: false, error: "conflict: an object already exists for this request id" };
    if (behaviour === "reject_idempotency" && "idempotency_key" in args) return { ...base, ok: false, error: "invalid_value at [\"idempotency_key\"]: unrecognized key" };
    return { ...base, ok: true, result: { structuredContent: { object_id: String(args.requested_id), created: true } } };
  };
  return { fn, calls };
};

const run = (overrides: Record<string, unknown> = {}) => ({ runId: "run_shell_1", projectId: "dr-lurie", requestId: REQUEST_ID, executionMode: "openai" as const, ...overrides });

describe("ensureContentItemShell", () => {
  it("creates the shell under the run's request id with the site and an idempotency key, once", async () => {
    const adapter = fakeCreate();
    const result = await ensureContentItemShell({ run: run() }, { projectRepository: new MemoryProjectRepository(), env: ENABLED_ENV, callTool: adapter.fn });
    expect(result).toEqual({ ok: true, shell: { objectId: REQUEST_ID, created: true, objectType: "content_item", requestId: REQUEST_ID } });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.tool).toBe("object_create");
    expect(adapter.calls[0]!.args).toMatchObject({ object_type: "content_item", site: drLurieProjectConfig.objectDialect!.siteObjectId, requested_id: REQUEST_ID, idempotency_key: "run_shell_1" });
    // T2 — the shell can no longer be created EMPTY: this substrate validates the body before it
    // persists anything, and content_item requires slug/title/nodes. The shell therefore carries the
    // minimum body that is legal to WRITE and illegal to PUBLISH — a slug/title derived from the
    // request id and NO nodes (article_visible_nodes is blocks_publish, not blocks_write), so it can
    // never be mistaken for a publishable article while the artifact bridge indexes against it.
    expect(adapter.calls[0]!.args.body).toEqual({ slug: "req-agent-shell-probe-20260818-01", title: REQUEST_ID, nodes: [] });
  });

  it("T2 — a REFUSED create is a named failure, never a shell the publisher will trust", async () => {
    // The old reader stopped at the adapter's transport-level `ok`, so a refusal became
    // { objectId: requestId, created: true }: the publisher then skipped its own object_create and
    // died at object_checkout on an object that had never been made.
    const refuse = async (_config: unknown, tool: string): Promise<CallToolResult> => ({
      projectId: "dr-lurie", connection: {} as never, tool, ok: true,
      result: { isError: true, content: [{ type: "text", text: "Invalid arguments" }], structuredContent: { statusCode: 400, error_code: "invalid_arguments", issues: [{ path: ["body"], message: "Required" }] } }
    });
    const result = await ensureContentItemShell({ run: run() }, { projectRepository: new MemoryProjectRepository(), env: ENABLED_ENV, callTool: refuse });
    expect(result).toMatchObject({ ok: false, skipped: false, code: "client_refused" });
    expect(result.ok === false ? result.message : "").toContain("status 400");
  });

  it("T2 — reads created/existing under structuredContent, and treats replayed_from_idempotency_key as an existing object", async () => {
    // Both facts live one level down on this substrate, and a REPLAY is signalled by a VALUE (the
    // key echoed back), not a boolean — a boolean-only reader at the raw top level saw neither and
    // reported every replay as a fresh create.
    const answer = (structuredContent: Record<string, unknown>) => async (_config: unknown, tool: string): Promise<CallToolResult> =>
      ({ projectId: "dr-lurie", connection: {} as never, tool, ok: true, result: { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent } });
    const deps = { projectRepository: new MemoryProjectRepository(), env: ENABLED_ENV };

    const replayed = await ensureContentItemShell({ run: run() }, { ...deps, callTool: answer({ record: { object_id: REQUEST_ID }, replayed_from_idempotency_key: "run_shell_1" }) });
    expect(replayed).toEqual({ ok: true, shell: { objectId: REQUEST_ID, created: false, objectType: "content_item", requestId: REQUEST_ID } });

    const existing = await ensureContentItemShell({ run: run() }, { ...deps, callTool: answer({ record: { object_id: REQUEST_ID }, created: false }) });
    expect(existing.ok === true ? existing.shell.created : true).toBe(false);

    const fresh = await ensureContentItemShell({ run: run() }, { ...deps, callTool: answer({ record: { object_id: REQUEST_ID }, created: true }) });
    expect(fresh.ok === true ? fresh.shell.created : false).toBe(true);
  });

  it("T2 — an id-less success is a named failure, not a shell silently named after the request id", async () => {
    // objectId = requestId was the old fallback. On a request_id dialect the two are equal WHEN the
    // create really happened, so the fallback could only ever mask a create that did not.
    const idless = async (_config: unknown, tool: string): Promise<CallToolResult> =>
      ({ projectId: "dr-lurie", connection: {} as never, tool, ok: true, result: { structuredContent: { ok: true } } });
    const result = await ensureContentItemShell({ run: run() }, { projectRepository: new MemoryProjectRepository(), env: ENABLED_ENV, callTool: idless });
    expect(result).toMatchObject({ ok: false, skipped: false, code: "create_missing_object_id" });
  });

  it("retries once without idempotency_key when the client rejects that key; an existing object is created:false, not a failure", async () => {
    const strict = fakeCreate("reject_idempotency");
    const retried = await ensureContentItemShell({ run: run() }, { projectRepository: new MemoryProjectRepository(), env: ENABLED_ENV, callTool: strict.fn });
    expect(retried.ok).toBe(true);
    expect(strict.calls.map((call) => "idempotency_key" in call.args)).toEqual([true, false]);
    const exists = await ensureContentItemShell({ run: run() }, { projectRepository: new MemoryProjectRepository(), env: ENABLED_ENV, callTool: fakeCreate("exists").fn });
    expect(exists).toEqual({ ok: true, shell: { objectId: REQUEST_ID, created: false, objectType: "content_item", requestId: REQUEST_ID } });
  });

  it("skips (not fails) when preconditions are unmet, and fails by name when the client is unreachable", async () => {
    const repo = new MemoryProjectRepository();
    expect(await ensureContentItemShell({ run: run({ executionMode: "mock" }) }, { projectRepository: repo, env: ENABLED_ENV, callTool: fakeCreate().fn })).toMatchObject({ ok: false, skipped: true, code: "not_live" });
    expect(await ensureContentItemShell({ run: run() }, { projectRepository: repo, env: { [publishEnabledEnvVar(drLurieProjectConfig)]: "false" } as NodeJS.ProcessEnv, callTool: fakeCreate().fn })).toMatchObject({ ok: false, skipped: true, code: "publish_disabled" });
    expect(await ensureContentItemShell({ run: run({ requestId: "not-a-request-id" }) }, { projectRepository: repo, env: ENABLED_ENV, callTool: fakeCreate().fn })).toMatchObject({ ok: false, skipped: true, code: "request_id_not_pattern_valid" });
    expect(await ensureContentItemShell({ run: run() }, { projectRepository: repo, env: ENABLED_ENV, callTool: fakeCreate("boom").fn })).toMatchObject({ ok: false, skipped: false, code: "create_failed" });
  });
});

describe("the publisher patches the shell instead of creating a second object", () => {
  const envelope = (body: unknown) => ({ artifact: "client_object.v1", summary: "Body.", clientProjectId: "dr-lurie", clientObjectType: "content_item", contractSource: { tool: "get_content_schema", fetchedAt: "2026-07-16T00:00:00.000Z" }, body });
  const textBody = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "Live Title", body: PARAGRAPH } }] });
  const READY = { taxonomy: { tags: ["science"] }, approval: { pinned: true, approvedBy: "editor" }, releaseBehavior: "publish_now", hardConstraints: { contentPath: "client_object.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false } };
  const publishFake = () => {
    const calls: string[] = [];
    const fn = async (tool: string): Promise<CallToolResult> => {
      calls.push(tool);
      const base = { ok: true, projectId: "dr-lurie", connection: {} as never, tool };
      if (tool === "object_checkout") return { ...base, result: { structuredContent: { lock_token: "lock_1", record_version: 2 } } };
      if (tool === "object_validate") return { ...base, result: { structuredContent: { valid: true, issues: [] } } };
      if (tool === "object_publish") return { ...base, result: { ok: true, commit: "abc123" } };
      return { ...base, result: { ok: true } };
    };
    return { fn, calls };
  };
  afterEach(() => { /* per-test repositories; nothing global */ });

  it("skips object_create when artifact_plan's input carries the shell for this request", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const started = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "publish", requestId: REQUEST_ID, entrypoint: { nodeId: "article_body", output: textBody } }, executionRepository);
    const record = (await getRun(started.runId, executionRepository))!;
    record.stageOutputs.publication_controller = { artifact: "publication_decision.v1", summary: "go", decision: "go", blockers: [] };
    const artifactPlan = record.nodes.find((node) => node.nodeId === "artifact_plan")!;
    artifactPlan.input = { ...(artifactPlan.input as Record<string, unknown> ?? {}), contentItemShell: { objectId: REQUEST_ID, created: true, objectType: "content_item", requestId: REQUEST_ID } };
    await executionRepository.saveRun(record);
    expect(readContentItemShell(record)?.objectId).toBe(REQUEST_ID);
    // T15.5 (ADR-2026-08-25-publish-autonomy §2.4) — publishRun's gate now requires a resolved
    // publish authority (operator explicit approval, or an autonomous project policy); this project
    // is operator-gated by default, so an explicit approval stands in for what the removed caller
    // `approved:true` flag used to buy on its own.
    await setOperatorPublishDecision(started.runId, "approved", executionRepository);

    const adapter = publishFake();
    const result = await publishRun({ runId: started.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { executionRepository, projectRepository: manager.getProjectRepository(), learningRepository: manager.getLearningRepository(), env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("live");
    expect(adapter.calls).toEqual(["object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"]);
    expect(result.mode === "live" ? result.objectId : undefined).toBe(REQUEST_ID);
  });
});
