import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { startDryRun, setOperatorPublishDecision } from "../../src/agent/workspace/executor.js";
import { listWorkspaceNodes } from "../../src/agent/workspace/nodes.js";
import { publishRun, publishEnabledEnvVar, isProjectPublishEnabled, __test__ } from "../../src/agent/workspace/publisher.js";
import { drLurieProjectConfig } from "../../src/agent/projects/drLurie/definition.js";
import type { CallToolResult } from "../../src/agent/projects/projectMcpAdapter.js";
import type { ProjectConnectionConfig } from "../../src/agent/projects/projectTypes.js";
import { handler } from "../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../src/agent/runtime/repositories.js";
// S3 item 7: readiness now requires reader-visible content (article_has_content, >= 200 visible
// chars), so the fixtures carry a realistic paragraph rather than a stub.
const PAD = " This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today.".repeat(2);


// R-23 — article_body emits the CLIENT-shaped envelope ({artifact, summary, clientProjectId,
// clientObjectType, contractSource, body}), and the client's own object lives under `.body`. The
// publisher validates the whole envelope against the article_body node's own outputSchema and reads
// the content blocks (and their media) one level deeper, at `body.nodes[].public.media`.
// Dr. Lurie's client object here is the {schema_version, nodes} content_item its readiness policy
// parses, so these fixtures keep that shape INSIDE `body` rather than at the top level.
const envelope = (body: unknown) => ({
  artifact: "client_object.v1",
  summary: "Reader-facing body assembled for the publish gate tests.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "get_content_schema", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body
});
const textBody = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "Live Title", body: "Reader-facing body." + PAD } }] });
const imageBody = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "T", body: "B" + PAD, media: { type: "image", src: "/media/req/x.png", alt: "x" } } }] });
const blobMediaBody = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_img", kind: "content", visibility: "public", public: { title: "T", body: "B" + PAD, media: { type: "image", src: "image/req_x/abc123.png", alt: "x" } } }] });
const REQUEST_ID = "req_publish_test_20260716_01";
const ENABLED_ENV = { [publishEnabledEnvVar(drLurieProjectConfig)]: "true" } as NodeJS.ProcessEnv;
// P0 §2.1 — publishRun now refuses unless the run carries an EXPLICIT affirmative
// publication_controller decision (decision: "go"). This is the affirmative shape; the fixtures
// below seed it so the underlying gate/sequence logic can be exercised. publishDecisionGate.test.ts
// owns the refusal cases (absent record, prose-only summary, no_go, veto).
const GO_DECISION = { artifact: "publication_decision.v1", summary: "Controller explicitly authorizes this publish.", decision: "go", blockers: [] };
const seedControllerDecision = async (executionRepository: { getRun: (id: string) => Promise<any>; saveRun: (run: any) => Promise<any> }, runId: string, decision: unknown = GO_DECISION) => {
  const run = await executionRepository.getRun(runId);
  run.stageOutputs.publication_controller = decision;
  await executionRepository.saveRun(run);
};
// Satisfies Dr. Lurie's publish-readiness policy (GO) so the underlying gate logic can be exercised.
const READY = {
  taxonomy: { tags: ["science", "longevity"] },
  approval: { pinned: true, approvedBy: "editor@dr-lurie" },
  releaseBehavior: "publish_now",
  hardConstraints: { contentPath: "client_object.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
};

// A minimal registration for the object-native `platform` client (client 0). It is not a seeded
// default project, so the tests register it in the project repository themselves.
const platformProjectConfig: ProjectConnectionConfig = {
  projectId: "platform",
  name: "Platform (client 0)",
  mcpEndpointEnvVar: "PLATFORM_MCP_ENDPOINT",
  authMode: "none",
  allowedTools: [],
  contentContract: { contentContract: "content_source.v1" },
  publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "test registration" },
  status: "active"
};
// A registered project with NO hooks at all (and therefore no executePublish) — the publisher must
// refuse to publish for it rather than borrow another client's dialect.
const hooklessProjectConfig: ProjectConnectionConfig = { ...platformProjectConfig, projectId: "acme-live", name: "Acme Live", mcpEndpointEnvVar: "ACME_LIVE_MCP_ENDPOINT" };

const seedRun = async (articleBody: unknown, projectId = "dr-lurie") => {
  const manager = new RepositoryManager();
  const executionRepository = manager.getExecutionRepository();
  const projectRepository = manager.getProjectRepository();
  if (projectId === "platform") await projectRepository.save(platformProjectConfig);
  if (projectId === "acme-live") await projectRepository.save(hooklessProjectConfig);
  const run = await startDryRun({ executionMode: "openai", projectId, input: "publish", entrypoint: { nodeId: "article_body", output: articleBody } }, executionRepository);
  await seedControllerDecision(executionRepository, run.runId);
  // T15.5 (ADR-2026-08-25-publish-autonomy §2.4) — publishRun's authority gate now requires a
  // resolved publish authority; these fixture projects are operator-gated by default (no
  // autonomyMode declared), so seedRun stands in an explicit operator approval for what the old
  // `approved:true` caller flag used to buy on its own. Tests that specifically exercise the
  // authority gate closing seed their own run WITHOUT this call.
  await setOperatorPublishDecision(run.runId, "approved", executionRepository);
  const learningRepository = manager.getLearningRepository();
  return { runId: run.runId, executionRepository, projectRepository, learningRepository };
};

// Dr. Lurie speaks the OBJECT-NATIVE dialect (the legacy save_json_blob_* pipeline is retired), so
// this fake answers the object verbs. Its content_item keeps the request-id shape as its object id.
const DR_LURIE_PUBLISH_SEQUENCE = ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"];
const fakeCallTool = (opts: { failOn?: string; noLock?: boolean; validate?: { valid: boolean; issues: unknown[] } } = {}) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    calls.push({ tool, args });
    if (opts.failOn === tool) return { ok: false, projectId: "dr-lurie", connection: {} as any, tool, error: `${tool} boom` };
    if (tool === "object_create") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { structuredContent: { object_id: REQUEST_ID } } };
    if (tool === "object_checkout") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: opts.noLock ? { structuredContent: { record_version: 2 } } : { structuredContent: { lock_token: "lock_123", record_version: 2 } } };
    if (tool === "object_validate") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { structuredContent: opts.validate ?? { valid: true, issues: [] } } };
    if (tool === "object_publish") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { ok: true, statusCode: 201, commit: "abc123def", path: "src/data/site/articles/live-title.json", warnings: [] } };
    return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { ok: true } };
  };
  return { fn, calls };
};

// Object-native platform fixtures. The envelope shape is the same client_object.v1 contract; the
// client object under `body` carries top-level meta fields plus `nodes` (the content blocks).
const platformEnvelope = (body: unknown) => ({
  artifact: "client_object.v1",
  summary: "Reader-facing body assembled for the platform publish tests.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "get_content_schema", fetchedAt: "2026-07-28T00:00:00.000Z" },
  body
});
const platformTextBody = platformEnvelope({
  slug: "live-title",
  title: "Live Title",
  deck: "A deck line.",
  nodes: [
    { id: "n_1", kind: "content", visibility: "public", public: { title: "Live Title", body: "Reader-facing body." + PAD } },
    { id: "n_2", kind: "content", visibility: "public", public: { title: "Second", body: "More reader-facing body." + PAD } }
  ]
});
const PLATFORM_ENABLED_ENV = { PLATFORM_PUBLISH_ENABLED: "true" } as NodeJS.ProcessEnv;
// Satisfies platform's publish-readiness policy (GO).
const PLATFORM_READY = {
  taxonomy: { tags: ["science"] },
  approval: { pinned: true, approvedBy: "editor@platform" },
  releaseBehavior: "publish_only",
  hardConstraints: { contentPath: "client_object.v1", artifactProtocol: "pdf_tool_platform_blob.v1", legacyFallbacksUsed: false }
};

const fakePlatformCallTool = (opts: { validate?: { valid: boolean; issues: unknown[] } } = {}) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    calls.push({ tool, args });
    if (tool === "object_create") return { ok: true, projectId: "platform", connection: {} as any, tool, result: { structuredContent: { object_id: "obj_srv_991" } } };
    if (tool === "object_checkout") return { ok: true, projectId: "platform", connection: {} as any, tool, result: { structuredContent: { lock_token: "lock_p1", record_version: 3 } } };
    if (tool === "object_validate") return { ok: true, projectId: "platform", connection: {} as any, tool, result: { structuredContent: opts.validate ?? { valid: true, issues: [] } } };
    if (tool === "object_publish") return { ok: true, projectId: "platform", connection: {} as any, tool, result: { ok: true, object_id: "obj_srv_991", published: true } };
    return { ok: true, projectId: "platform", connection: {} as any, tool, result: { ok: true } };
  };
  return { fn, calls };
};

describe("live publish gates", () => {
  it("derives the per-project operator env flag name; policy-enabled by default with an env kill-switch", () => {
    expect(publishEnabledEnvVar(drLurieProjectConfig)).toBe("DR_LURIE_PUBLISH_ENABLED");
    // Go-live 2026-07-31: publishingPolicy.publishEnabled is true by default, so no env flag is needed.
    expect(isProjectPublishEnabled(drLurieProjectConfig, {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isProjectPublishEnabled(drLurieProjectConfig, { DR_LURIE_PUBLISH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    // The env flag is now a kill-switch: an explicit "false" forces the project off.
    expect(isProjectPublishEnabled(drLurieProjectConfig, { DR_LURIE_PUBLISH_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    // A policy-disabled config with no env flag stays off.
    expect(isProjectPublishEnabled({ ...drLurieProjectConfig, publishingPolicy: { ...drLurieProjectConfig.publishingPolicy, publishEnabled: false } }, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("returns a dry-run plan and performs NO external calls when readiness is GO but gates are unmet", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    // Gates default open at go-live; the env kill-switch is now the way a gate is unmet.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, readiness: READY }, { ...ctx, env: { DR_LURIE_PUBLISH_ENABLED: "false" } as NodeJS.ProcessEnv, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "dry_run") {
      expect(result.plan.toolSequence).toEqual(DR_LURIE_PUBLISH_SEQUENCE);
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
    expect(adapter.calls.map((call) => call.tool)).toEqual(DR_LURIE_PUBLISH_SEQUENCE);
    // Per-site parameters come from the project config's objectDialect, never from literals in the
    // hook: the owning site object id travels on create, and this client's content_item keeps the
    // caller-supplied request id as its object id (unlike platform, which mints server-side).
    const create = adapter.calls[0].args as any;
    expect(create.object_type).toBe("content_item");
    expect(create.site).toBe(drLurieProjectConfig.objectDialect?.siteObjectId);
    expect(create.requested_id).toBe(REQUEST_ID);
    // Validation runs BEFORE any patch (board B1), and every write is pinned to the checked-out lock
    // and record version.
    const patch = adapter.calls.find((call) => call.tool === "object_patch")!.args as any;
    expect(patch).toMatchObject({ object_id: REQUEST_ID, lock_token: "lock_123", expected_record_version: 2 });
    expect(patch.patch[0]).toMatchObject({ op: "set_article_meta" });
    expect(patch.patch.slice(1).every((op: any) => op.op === "upsert_node")).toBe(true);
    if (result.mode === "live") {
      expect((result.result as any).statusCode).toBe(201);
      expect(result.clientValidation).toMatchObject({ tool: "object_validate", valid: true, issues: [] });
    }
  });

  it("drops client_object.v1's schema_version so the client's strict content_item body accepts the patch", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    const patch = adapter.calls.find((call) => call.tool === "object_patch")!.args as any;
    const meta = patch.patch[0].fields as Record<string, unknown>;
    expect(meta).not.toHaveProperty("schema_version");
    expect(meta).not.toHaveProperty("nodes");
    expect(JSON.stringify(patch.patch[0])).not.toContain("client_object.v1");
  });

  it("aborts before object_patch/object_publish when the client validator rejects, and names the taxonomy registry on a taxonomy blocker", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool({ validate: { valid: false, issues: ["taxonomy.tags[0] 'longevity' is not an active term"] } });
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.mode).toBe("error");
    if (result.mode === "error") {
      expect(result.error).toContain("object_validate_rejected");
      expect(result.error).toContain(drLurieProjectConfig.objectDialect!.taxonomyRegistryObjectId);
    }
    expect(adapter.calls.map((call) => call.tool)).toEqual(["object_create", "object_checkout", "object_validate"]);
  });

  it("refuses to publish when the project declares no per-site object dialect — no literals stand in", async () => {
    const manager = new RepositoryManager();
    const projectRepository = manager.getProjectRepository();
    // Same client, same hooks, but a persisted config whose objectDialect has been stripped.
    const { objectDialect, ...withoutDialect } = drLurieProjectConfig;
    await projectRepository.save({ ...withoutDialect, definitionVersion: drLurieProjectConfig.definitionVersion });
    const executionRepository = manager.getExecutionRepository();
    const learningRepository = manager.getLearningRepository();
    const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "publish", entrypoint: { nodeId: "article_body", output: textBody } }, executionRepository);
    await seedControllerDecision(executionRepository, run.runId);
    await setOperatorPublishDecision(run.runId, "approved", executionRepository);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: run.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { executionRepository, projectRepository, learningRepository, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("missing_object_dialect");
    expect(adapter.calls).toHaveLength(0);
  });

  it("blocks with a resumable state when the readiness policy is NO-GO (approval explicitly withheld)", async () => {
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    // Go-live: missing readiness inputs auto-default, so a NO-GO now takes an explicit contradiction —
    // here the caller explicitly withholds approval.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: { approval: { pinned: false } } }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.mode).toBe("blocked_for_publish_execution");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "blocked_for_publish_execution") {
      expect(result.readiness.status).toBe("no_go");
      expect(result.readiness.blockers).toEqual(["pinned_approval"]);
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
    // S3 item 7: readiness now verifies EVERY media reference (public paths included), so the caller
    // confirms imageBody's /media/... src as materialized; execution is still text-only and refuses.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: { ...READY, verifiedMediaRefs: ["/media/req/x.png"] } }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("image_media_unsupported");
    expect(adapter.calls).toHaveLength(0);
  });

  it("errors when the run has no valid article_body", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    const learningRepository = manager.getLearningRepository();
    const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "no-body" }, executionRepository);
    await setOperatorPublishDecision(run.runId, "approved", executionRepository);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: run.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { executionRepository, projectRepository, learningRepository, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("no_valid_article_body");
    expect(adapter.calls).toHaveLength(0);
  });

  it("aborts and reports the failing step when a publish call fails, and when the lock token is missing", async () => {
    const ctx = await seedRun(textBody);
    const failing = fakeCallTool({ failOn: "object_publish" });
    const failed = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: failing.fn });
    expect(failed.mode).toBe("error");
    if (failed.mode === "error") expect(failed.error).toContain("object_publish");
    expect(failing.calls.map((call) => call.tool)).toEqual(["object_create", "object_checkout", "object_validate", "object_patch", "object_publish"]);

    const ctx2 = await seedRun(textBody);
    const noLock = fakeCallTool({ noLock: true });
    const missing = await publishRun({ runId: ctx2.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx2, env: ENABLED_ENV, callTool: noLock.fn });
    expect(missing.mode).toBe("error");
    if (missing.mode === "error") expect(missing.error).toContain("lock_token");
  });

  // The grant paired with the capability increase on the publish-risk nodes. publish_executor and
  // publication_controller now hold project.call_tool — without it a publisher cannot reach the
  // client at all — and this asserts that the grant buys exactly nothing at the publish gate: the
  // node can hold the tool and the run still refuses to publish, with zero external calls, because
  // the gates are inputs to publishRun and have nothing to do with a node's tool list.
  it("a node holding the client call_tool grant still cannot publish without the gates — dry-run plan, zero external calls", async () => {
    const executor = listWorkspaceNodes().find((node) => node.id === "publish_executor");
    const controller = listWorkspaceNodes().find((node) => node.id === "publication_controller");
    expect(executor?.allowedTools).toContain("project.call_tool");
    expect(controller?.allowedTools).toContain("project.call_tool");

    // T15.5: unlike seedRun (which now seeds an explicit operator approval for the "happy path"
    // tests), this test needs the authority gate itself CLOSED, so it builds its own run without
    // that call — every one of the three caller/operator gates stays closed on its own account.
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    const learningRepository = manager.getLearningRepository();
    const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "publish", entrypoint: { nodeId: "article_body", output: textBody } }, executionRepository);
    await seedControllerDecision(executionRepository, run.runId);
    const ctx = { runId: run.runId, executionRepository, projectRepository, learningRepository };
    const adapter = fakeCallTool();
    // Readiness GO, grant in place, and every publish gate explicitly closed: the env kill-switch,
    // no operator approval and no autonomous policy (publish_authorized), and live:false.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, live: false, readiness: READY }, { ...ctx, env: { DR_LURIE_PUBLISH_ENABLED: "false" } as NodeJS.ProcessEnv, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "dry_run") {
      expect(result.gates.allPassed).toBe(false);
      expect(result.gates.gates.filter((gate) => !gate.passed).map((gate) => gate.name)).toEqual(["operator_enabled", "publish_authorized", "explicit_live"]);
      expect(result.readiness?.status).toBe("go");
    }
  });

  // Each gate is closed on its own account. Opening two of three still publishes nothing, so no
  // single flag — and certainly no tool grant — is load-bearing by itself.
  it("keeps each publish gate independent: any one closed gate is enough to refuse", async () => {
    // T15.5: seedRun now seeds an explicit operator approval (needed for the "happy path" tests),
    // so the "publish_authorized" case here builds its own unapproved run instead, to demonstrate
    // that gate closing entirely on its own — no other combination touches operator approval at all.
    const unapprovedCtx = async () => {
      const manager = new RepositoryManager();
      const executionRepository = manager.getExecutionRepository();
      const projectRepository = manager.getProjectRepository();
      const learningRepository = manager.getLearningRepository();
      const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "publish", entrypoint: { nodeId: "article_body", output: textBody } }, executionRepository);
      await seedControllerDecision(executionRepository, run.runId);
      return { runId: run.runId, executionRepository, projectRepository, learningRepository };
    };
    const combinations: Array<{ name: string; ctx: () => Promise<{ runId: string; executionRepository: any; projectRepository: any; learningRepository: any }>; input: Record<string, unknown>; env: NodeJS.ProcessEnv }> = [
      { name: "operator_enabled", ctx: () => seedRun(textBody), input: { live: true }, env: { DR_LURIE_PUBLISH_ENABLED: "false" } as NodeJS.ProcessEnv },
      { name: "publish_authorized", ctx: unapprovedCtx, input: { live: true }, env: ENABLED_ENV },
      { name: "explicit_live", ctx: () => seedRun(textBody), input: { live: false }, env: ENABLED_ENV }
    ];
    for (const combination of combinations) {
      const ctx = await combination.ctx();
      const adapter = fakeCallTool();
      const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, readiness: READY, ...combination.input }, { ...ctx, env: combination.env, callTool: adapter.fn });
      expect(result.mode, `${combination.name} closed must refuse`).toBe("dry_run");
      expect(adapter.calls, `${combination.name} closed must make no external call`).toHaveLength(0);
    }
  });

  it("keeps the publish gate set closed and named — nothing else may satisfy a gate", () => {
    // P0 2026-08-10: two new gates join the closed set — the operator veto (§2.2) and the
    // refuse-by-default controller decision (§2.1). T15.5: "explicit_approval" is renamed
    // "publish_authorized" — it now reads resolvePublishAuthority, not a bare caller flag.
    expect(__test__.PUBLISH_GATE_NAMES).toEqual(["operator_enabled", "publish_authorized", "explicit_live", "operator_not_withheld", "controller_decision_go"]);
    // T15.5: dr-lurie declares no autonomyMode (operator-gated by default), so the authority gate
    // needs an explicit operator approval on the fixture run itself — the deprecated `approved`
    // caller flag no longer buys it.
    const goRun = { stageOutputs: { publication_controller: GO_DECISION }, nodes: [], operatorPublishDecision: "approved" } as any;
    // Go-live: every operator/caller gate defaults open (with an explicit go decision AND an
    // explicit operator approval on the run)…
    const open = __test__.evaluateGates(drLurieProjectConfig, { runId: "r", requestId: REQUEST_ID }, {} as NodeJS.ProcessEnv, goRun);
    expect(open.allPassed).toBe(true);
    // …and each still closes on its own explicit input, nothing else.
    const gates = __test__.evaluateGates(drLurieProjectConfig, { runId: "r", requestId: REQUEST_ID, live: true }, { DR_LURIE_PUBLISH_ENABLED: "false" } as NodeJS.ProcessEnv, goRun);
    expect(gates.allPassed).toBe(false);
    expect(gates.operatorEnabled).toBe(false);
    // The operator veto closes its own gate regardless of every other input — including its own
    // prior "approved", which withheld now supersedes.
    const withheld = __test__.evaluateGates(drLurieProjectConfig, { runId: "r", requestId: REQUEST_ID, live: true }, {} as NodeJS.ProcessEnv, { ...goRun, operatorPublishDecision: "withheld" });
    expect(withheld.allPassed).toBe(false);
    expect(withheld.gates.find((gate) => gate.name === "operator_not_withheld")?.passed).toBe(false);
    // Prose-only controller output ("Looks fine.") is NOT an authorization — refuse-by-default.
    const hedged = __test__.evaluateGates(drLurieProjectConfig, { runId: "r", requestId: REQUEST_ID, approved: true, live: true }, {} as NodeJS.ProcessEnv, { stageOutputs: { publication_controller: { artifact: "publication_decision.v1", summary: "Looks fine." } }, nodes: [] } as any);
    expect(hedged.allPassed).toBe(false);
    expect(hedged.gates.find((gate) => gate.name === "controller_decision_go")?.passed).toBe(false);
  });

  it("exposes a request_id validator that matches the Dr. Lurie contract", () => {
    expect(__test__.REQUEST_ID_PATTERN.test("req_publish_drlurie_20260702_01")).toBe(true);
    expect(__test__.REQUEST_ID_PATTERN.test("my-article-123")).toBe(false);
    expect(__test__.REQUEST_ID_PATTERN.test("req_publish_2026_01")).toBe(false);
  });
});

// A-2 — publish execution is a per-project hook. Both tenants of the object substrate now publish in
// the object-native dialect (dr-lurie's legacy save_json_blob_* pipeline is retired), each with its
// OWN per-site parameters, and a project with no executor is refused rather than borrowed for.
describe("per-project publish execution hooks", () => {
  it("executes platform's object-native sequence in order when readiness is GO and every gate passes", async () => {
    const ctx = await seedRun(platformTextBody, "platform");
    const adapter = fakePlatformCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(true);
    expect(result.mode).toBe("live");
    expect(adapter.calls.map((call) => call.tool)).toEqual(["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"]);
    if (result.mode === "live") {
      expect(result.plan.toolSequence).toEqual(["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"]);
      expect((result.result as any).published).toBe(true);
      // The client validator's verdict travels as evidence on the publish result.
      expect(result.clientValidation).toMatchObject({ tool: "object_validate", valid: true, issues: [] });
      expect(result.clientValidation?.candidate_patch_summary).toBe("3 ops: 1 set_article_meta + 2 upsert_node");
    }
  });

  it("T20.6b — forwards complete, captured client-object producer context on object_publish only", async () => {
    const ctx = await seedRun(platformTextBody, "platform");
    const adapter = fakePlatformCallTool();
    const producerContext = {
      run_id: ctx.runId,
      node_id: "article_body",
      prompt_version: "workspace-revision-314",
      model: "gpt-5.5"
    };

    const result = await publishRun(
      { runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY },
      { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: adapter.fn, producerContext }
    );

    expect(result.mode).toBe("live");
    const publish = adapter.calls.find((call) => call.tool === "object_publish")!;
    expect(publish.args.producer).toEqual(producerContext);
    expect(adapter.calls.filter((call) => call.tool !== "object_publish").every((call) => !("producer" in call.args))).toBe(true);
  });

  it("T20.6b — omits producer unless all four bounded fields belong to this run's real client-object producer", async () => {
    const cases: Array<{ name: string; context?: Record<string, unknown> }> = [
      { name: "absent" },
      { name: "partial", context: { run_id: "filled-per-run", node_id: "article_body", model: "gpt-5.5" } },
      { name: "extra key", context: { run_id: "filled-per-run", node_id: "article_body", prompt_version: "rev-1", model: "gpt-5.5", guessed: true } },
      { name: "different run", context: { run_id: "run_other", node_id: "article_body", prompt_version: "rev-1", model: "gpt-5.5" } },
      { name: "non-producer node", context: { run_id: "filled-per-run", node_id: "publication_controller", prompt_version: "rev-1", model: "gpt-5.5" } },
      { name: "oversized", context: { run_id: "filled-per-run", node_id: "article_body", prompt_version: "x".repeat(129), model: "gpt-5.5" } }
    ];

    for (const testCase of cases) {
      const ctx = await seedRun(platformTextBody, "platform");
      const adapter = fakePlatformCallTool();
      const context = testCase.context
        ? Object.fromEntries(Object.entries(testCase.context).map(([key, value]) => [key, value === "filled-per-run" ? ctx.runId : value]))
        : undefined;
      const result = await publishRun(
        { runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY },
        { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: adapter.fn, ...(context ? { producerContext: context as any } : {}) }
      );
      expect(result.mode, testCase.name).toBe("live");
      expect(adapter.calls.find((call) => call.tool === "object_publish")!.args, testCase.name).not.toHaveProperty("producer");
    }
  });

  it("T20.6b — identical pass-through output without a client_object.v1 artifact is not producer provenance", async () => {
    const ctx = await seedRun(platformTextBody, "platform");
    const persisted = await ctx.executionRepository.getRun(ctx.runId);
    if (!persisted) throw new Error("seeded run missing");
    persisted.nodes.push({ nodeId: "pass_through", status: "completed", output: platformTextBody });
    persisted.stageOutputs.pass_through = platformTextBody;
    // Deliberately no client_object.v1 artifact for pass_through: it copied the value but did not
    // produce it. The existing article_body artifact remains the only real provenance record.
    await ctx.executionRepository.saveRun(persisted);
    const adapter = fakePlatformCallTool();

    const result = await publishRun(
      { runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY },
      {
        ...ctx,
        env: PLATFORM_ENABLED_ENV,
        callTool: adapter.fn,
        producerContext: { run_id: ctx.runId, node_id: "pass_through", prompt_version: "rev-pass-through", model: "gpt-5.5" }
      }
    );

    expect(result.mode).toBe("live");
    expect(adapter.calls.find((call) => call.tool === "object_publish")!.args).not.toHaveProperty("producer");
  });

  it("validates BEFORE any patch (board B1) and never sends requested_id on create (board D2c)", async () => {
    const ctx = await seedRun(platformTextBody, "platform");
    const adapter = fakePlatformCallTool();
    await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: adapter.fn });

    const tools = adapter.calls.map((call) => call.tool);
    expect(tools.indexOf("object_validate")).toBeGreaterThanOrEqual(0);
    expect(tools.indexOf("object_validate")).toBeLessThan(tools.indexOf("object_patch"));
    const create = adapter.calls.find((call) => call.tool === "object_create")!;
    expect("requested_id" in create.args).toBe(false);
    // The server-minted id (not the request id) drives every subsequent call.
    expect((adapter.calls.find((call) => call.tool === "object_checkout")!.args as any).object_id).toBe("obj_srv_991");
    const patch = adapter.calls.find((call) => call.tool === "object_patch")!.args as any;
    expect(patch).toMatchObject({ object_id: "obj_srv_991", lock_token: "lock_p1", expected_record_version: 3 });
    // `fields` is the contract-required key (live arg_schema via the alignment board, platform#014);
    // `meta` would be refused as invalid_op with `fields` missing.
    expect(patch.patch[0]).toMatchObject({ op: "set_article_meta", fields: { slug: "live-title", title: "Live Title", deck: "A deck line." } });
    expect(patch.patch[0].fields.nodes).toBeUndefined();
    expect(patch.patch.slice(1).map((op: any) => op.op)).toEqual(["upsert_node", "upsert_node"]);
  });

  it("passes clientObjectType through to object_create verbatim", async () => {
    const ctx = await seedRun(platformTextBody, "platform");
    const adapter = fakePlatformCallTool();
    await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: adapter.fn });
    expect((adapter.calls.find((call) => call.tool === "object_create")!.args as any).object_type).toBe("content_item");
  });

  it("T5 — a mock run is refused before any gate is even considered; mock is never publishable", async () => {
    // This was already TRUE, but only as a CONSEQUENCE: MockNodeRunner emits a dryRun:true hint,
    // publication_controller carries it, publishDecision turns it into controller_decision_placeholder.
    // Every link there is a model-shaped output a prompt edit or a seeded controller output could stop
    // producing — and at that point a run whose entire body is placeholder text has nothing left
    // standing between it and a tenant's live site. executionMode is a property of the run RECORD.
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "publish", entrypoint: { nodeId: "article_body", output: textBody } }, executionRepository);
    await seedControllerDecision(executionRepository, run.runId);
    await setOperatorPublishDecision(run.runId, "approved", executionRepository);

    const adapter = fakeCallTool();
    const result = await publishRun({ runId: run.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { executionRepository, projectRepository: manager.getProjectRepository(), learningRepository: manager.getLearningRepository(), env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("mock_run_not_publishable");
    // Every gate passed and the controller said go — the refusal is the MODE, on its own.
    expect(adapter.calls).toHaveLength(0);
  });

  it("never calls release_to_production in any path — publishRun never releases (board B2)", async () => {
    const platformCtx = await seedRun(platformTextBody, "platform");
    const platformAdapter = fakePlatformCallTool();
    const platformResult = await publishRun({ runId: platformCtx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...platformCtx, env: PLATFORM_ENABLED_ENV, callTool: platformAdapter.fn });
    expect(platformResult.published).toBe(true);
    expect(platformAdapter.calls.map((call) => call.tool)).not.toContain("release_to_production");

    const drLurieCtx = await seedRun(textBody);
    const drLurieAdapter = fakeCallTool();
    const drLurieResult = await publishRun({ runId: drLurieCtx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...drLurieCtx, env: ENABLED_ENV, callTool: drLurieAdapter.fn });
    expect(drLurieResult.published).toBe(true);
    expect(drLurieAdapter.calls.map((call) => call.tool)).not.toContain("release_to_production");
  });

  it("keeps the two tenants' per-site parameters apart — neither hook carries the other's identifiers", async () => {
    const drLurieCtx = await seedRun(textBody);
    const drLurieAdapter = fakeCallTool();
    await publishRun({ runId: drLurieCtx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...drLurieCtx, env: ENABLED_ENV, callTool: drLurieAdapter.fn });

    const platformCtx = await seedRun(platformTextBody, "platform");
    const platformAdapter = fakePlatformCallTool();
    await publishRun({ runId: platformCtx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...platformCtx, env: PLATFORM_ENABLED_ENV, callTool: platformAdapter.fn });

    // Each tenant creates under ITS OWN site, and only dr-lurie supplies the object id.
    //
    // T1: this assertion used to read `expect(platformCreate.site).toBeUndefined()` — it LOCKED IN
    // the defect. `site` is REQUIRED by the live object_create schema (object_type + site + body;
    // object_contract(content_item).auxiliary_inputs names it "the owning site object id"), so
    // omitting it 400'd every publish platform ever attempted. Board D2c is about `requested_id`,
    // which is still absent below — sending `site` does not touch it.
    const drLurieCreate = drLurieAdapter.calls.find((call) => call.tool === "object_create")!.args as any;
    const platformCreate = platformAdapter.calls.find((call) => call.tool === "object_create")!.args as any;
    expect(drLurieCreate.site).toBe("site_drlurie");
    expect(platformCreate.site).toBe("site_platform");
    expect(drLurieCreate.requested_id).toBe(REQUEST_ID);
    expect("requested_id" in platformCreate).toBe(false);
    expect(JSON.stringify(platformAdapter.calls)).not.toContain("drlurie");
  });

  it("T1 — creates WITH the body: the platform validates a create body before persisting, so an empty create can never make an object", async () => {
    const drLurieCtx = await seedRun(textBody);
    const drLurieAdapter = fakeCallTool();
    await publishRun({ runId: drLurieCtx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...drLurieCtx, env: ENABLED_ENV, callTool: drLurieAdapter.fn });

    const platformCtx = await seedRun(platformTextBody, "platform");
    const platformAdapter = fakePlatformCallTool();
    await publishRun({ runId: platformCtx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...platformCtx, env: PLATFORM_ENABLED_ENV, callTool: platformAdapter.fn });

    const createBodyOf = (adapter: { calls: Array<{ tool: string; args: Record<string, unknown> }> }) =>
      (adapter.calls.find((call) => call.tool === "object_create")!.args as any).body;

    for (const adapter of [drLurieAdapter, platformAdapter]) {
      const body = createBodyOf(adapter);
      // The create carries the SAME stripped body the patch does — never the judgement substrate,
      // never client_object.v1's own `schema_version` label (the content_item body is zod .strict(),
      // so a stray key is a 422 at create exactly as it is at patch). dr-lurie's fixture envelope
      // carries schema_version, so its absence here is the stripping actually running.
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(body.nodes.length).toBeGreaterThan(0);
      for (const key of ["scores", "claims", "sources", "compliance", "emotional_strategy", "lineage", "schema_version"]) {
        expect(key in body).toBe(false);
      }
    }
    // content_item requires slug/title/nodes and the client validates the body BEFORE persisting, so
    // the meta the envelope carries has to travel on the create, not wait for the patch.
    expect(createBodyOf(platformAdapter)).toMatchObject({ slug: "live-title", title: "Live Title", deck: "A deck line." });
    // The patch step is unchanged: it still runs, which is what keeps re-entry over an
    // already-created object idempotent.
    expect(platformAdapter.calls.map((call) => call.tool)).toContain("object_patch");
  });

  it("T1 — reads the object id out of the platform's REAL create envelope ({content:[{text}], structuredContent:{record:{object_id}}})", async () => {
    // No test exercised this shape before: every fake answered {structuredContent:{object_id}}, a
    // flatter envelope than the one the live server actually sends. findObjectId walks both, and
    // this is the one that matters in production.
    const ctx = await seedRun(platformTextBody, "platform");
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const realEnvelopeCreate = {
      content: [{ type: "text", text: JSON.stringify({ record: { object_id: "obj_srv_777", record_version: 1 }, created: true }) }],
      structuredContent: { record: { object_id: "obj_srv_777", record_version: 1 }, created: true }
    };
    const fn = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      calls.push({ tool, args });
      const base = { ok: true as const, projectId: "platform", connection: {} as any, tool };
      if (tool === "object_create") return { ...base, result: realEnvelopeCreate };
      if (tool === "object_checkout") return { ...base, result: { structuredContent: { record: { lock_token: "lock_p9", record_version: 1 } } } };
      if (tool === "object_validate") return { ...base, result: { structuredContent: { valid: true, issues: [] } } };
      return { ...base, result: { structuredContent: { record: { object_id: "obj_srv_777" } } } };
    };
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: fn });

    expect(result.mode).toBe("live");
    expect(result.mode === "live" ? result.objectId : undefined).toBe("obj_srv_777");
    // Every later step addresses the SERVER-MINTED id, never the request id.
    expect((calls.find((call) => call.tool === "object_checkout")!.args as any).object_id).toBe("obj_srv_777");
    expect((calls.find((call) => call.tool === "object_publish")!.args as any).object_id).toBe("obj_srv_777");
  });

  it("T1 — a REFUSED object_create is reported as the client's own refusal, not as create_missing_object_id", async () => {
    // The 2026-08-25 failure (run_1787656120374_18bobg): the client refused object_create outright
    // and said why; the hook read only the missing id and filed a refusal as an unfamiliar SHAPE.
    const ctx = await seedRun(platformTextBody, "platform");
    const fn = async (tool: string): Promise<CallToolResult> => ({
      ok: true, projectId: "platform", connection: {} as any, tool,
      result: tool === "object_create"
        ? { isError: true, content: [{ type: "text", text: "Invalid arguments" }], structuredContent: { statusCode: 400, error_code: "invalid_arguments", issues: [{ path: ["site"], message: "Required" }, { path: ["body"], message: "Required" }] } }
        : { structuredContent: { ok: true } }
    });
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: fn });

    expect(result.mode).toBe("error");
    if (result.mode === "error") {
      expect(result.error).toContain("object_create_refused");
      expect(result.error).toContain("site: Required");
      expect(result.error).not.toContain("create_missing_object_id");
    }
  });

  it("aborts before object_patch/object_publish when the client validator rejects the candidate patch", async () => {
    const ctx = await seedRun(platformTextBody, "platform");
    const adapter = fakePlatformCallTool({ validate: { valid: false, issues: ["nodes[1].public.title too long", "meta.deck missing"] } });
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: adapter.fn });

    expect(result.mode).toBe("error");
    if (result.mode === "error") {
      expect(result.error).toContain("object_validate_rejected");
      expect(result.error).toContain("nodes[1].public.title too long");
    }
    const tools = adapter.calls.map((call) => call.tool);
    expect(tools).toEqual(["object_create", "object_checkout", "object_validate"]);
    expect(tools).not.toContain("object_patch");
    expect(tools).not.toContain("object_publish");
  });

  it("refuses to publish for a project with no publish execution hook — zero external calls", async () => {
    const ctx = await seedRun(platformEnvelope({ slug: "s", title: "T", nodes: [] }), "acme-live");
    const adapter = fakePlatformCallTool();
    // No hooks registered for acme-live at all: no readiness policy, so every generic gate passes.
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true }, { ...ctx, env: { ACME_LIVE_PUBLISH_ENABLED: "true" } as NodeJS.ProcessEnv, callTool: adapter.fn });

    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("no_publish_executor");
    expect(adapter.calls).toHaveLength(0);
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

  it("advertises both tools; a GO readiness with the operator kill-switch set yields a dry-run plan", async () => {
    const listed = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = JSON.parse(listed.body ?? "{}").result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["workflow_publish_run", "workflow_publish_readiness"]));

    const runId = (await data("workflow.start_dry_run", { executionMode: "openai", projectId: "dr-lurie", requestId: REQUEST_ID, input: {}, entrypoint: "article_body", articleBody: textBody })).run.runId;
    // Go-live: publishing defaults on, so the dry-run posture takes the env kill-switch.
    process.env.DR_LURIE_PUBLISH_ENABLED = "false";
    const publish = (await data("workflow.publish_run", { runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY })).publish;
    expect(publish.mode).toBe("dry_run");
    expect(publish.readiness.status).toBe("go");
    expect(publish.gates.gates.find((gate: { name: string }) => gate.name === "operator_enabled").passed).toBe(false);
  });

  it("publish_readiness returns the GO/NO-GO checklist without publishing", async () => {
    const runId = (await data("workflow.start_dry_run", { executionMode: "openai", projectId: "dr-lurie", requestId: REQUEST_ID, input: {}, entrypoint: "article_body", articleBody: textBody })).run.runId;

    const go = (await data("workflow.publish_readiness", { projectId: "dr-lurie", runId, readiness: READY })).readiness;
    expect(go).toMatchObject({ available: true, articleBodyValid: true });
    expect(go.readiness.status).toBe("go");

    // Go-live: absent inputs auto-default, so NO-GO takes an explicit contradiction.
    const noGo = (await data("workflow.publish_readiness", { projectId: "dr-lurie", runId, readiness: { approval: { pinned: false } } })).readiness;
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

// D7 (Wolf, alignment board 2026-07-28): all judgements stay workspace-side. The platform client's
// schema declares scores/claims/sources/compliance/emotional_strategy/lineage as real body properties
// and set_article_meta's fields map is open — so the generic key-copy in the platform hook is exactly
// the door a judgement could leak through. This asserts the door is shut: a body carrying every
// judgement-substrate key publishes cleanly, and NONE of those keys reaches the candidate patch.
describe("D7 — the engine never writes judgements into a client object", () => {
  it("strips all six judgement-substrate keys from set_article_meta while keeping real meta", async () => {
    const judged = platformEnvelope({
      slug: "judged-title",
      title: "Judged Title",
      deck: "A deck line.",
      scores: [{ scored_by: "judge", score: 5 }],
      claims: { c1: "claim" },
      sources: { s1: "source" },
      compliance: { ok: true },
      emotional_strategy: { arc: "calm" },
      lineage: { parent_content_id: "req_prior" },
      nodes: [{ id: "n_1", kind: "content", visibility: "public", public: { title: "Judged Title", body: "Reader-facing body." + PAD } }]
    });
    const ctx = await seedRun(judged, "platform");
    const adapter = fakePlatformCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: PLATFORM_READY }, { ...ctx, env: PLATFORM_ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(true);
    const patchCall = adapter.calls.find((call) => call.tool === "object_patch")!;
    const ops = patchCall.args.patch as Array<Record<string, unknown>>;
    const meta = ops.find((op) => op.op === "set_article_meta")!.fields as Record<string, unknown>;
    for (const key of ["scores", "claims", "sources", "compliance", "emotional_strategy", "lineage"]) {
      expect(meta, `judgement key ${key} must never reach the client`).not.toHaveProperty(key);
    }
    // The exclusion is surgical: genuine meta still travels.
    expect(meta).toHaveProperty("slug");
    expect(meta).toHaveProperty("title");
    // And nothing judgement-shaped hides anywhere else in the patch.
    expect(JSON.stringify(ops)).not.toContain("scored_by");
  });
});

// T15.29 (2026-08-25, #205; ADR-2026-08-25-structure-studio §2.2) — enforcement point 3, wired end
// to end: this DTC publish path (publisher.ts's `call` closure, driven by a project's own
// executePublish hook) IS the emission transport for publishing_conductor's governed writes. A hook
// that somehow ended up asked to object_create a recipe type — a misconfigured contract, a future
// dialect bug — must be refused HERE, before any wire call, not merely at publish_payload's
// allowlist (which only ever sees an object that already exists). Unit coverage for the guard itself
// lives in publishableTypeCharter.test.ts; this proves the wiring.
describe("structure authority boundary — the runtime write guard, wired into the DTC publish path (T15.29/#205)", () => {
  it("refuses BEFORE any wire call when the run's clientObjectType is a recipe type, naming the workflow, the verb, and the type", async () => {
    const recipeTypedBody = { ...textBody, clientObjectType: "section_template" };
    const ctx = await seedRun(recipeTypedBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("error");
    if (result.mode === "error") {
      expect(result.error).toContain("recipe_authorship_refused");
      expect(result.error).toContain("publishing_conductor");
      expect(result.error).toContain("object_create");
      expect(result.error).toContain("section_template");
      expect(result.error).toContain("ADR-2026-08-25-structure-studio");
    }
    // Reject, never coerce: the transport is never reached at all — no created/checked-out/patched
    // recipe object, no stranded lock, no half-write to clean up.
    expect(adapter.calls).toHaveLength(0);
  });

  it("a theme/site recipe type is refused the same way", async () => {
    const themeTypedBody = { ...textBody, clientObjectType: "theme" };
    const ctx = await seedRun(themeTypedBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("error");
    if (result.mode === "error") expect(result.error).toContain("recipe_authorship_refused");
    expect(adapter.calls).toHaveLength(0);
  });

  it("does not disturb the ordinary content-object publish path — the CI baseline of this whole file", async () => {
    // textBody's own clientObjectType ("content_item") is untouched; this is the same assertion the
    // "executes the sanctioned publish sequence" test above already makes, restated here so a reader
    // auditing the guard's blast radius finds proof of "consumption survives" right next to the
    // refusal tests, not three hundred lines away.
    const ctx = await seedRun(textBody);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.published).toBe(true);
    expect(adapter.calls.map((call) => call.tool)).toEqual(DR_LURIE_PUBLISH_SEQUENCE);
  });
});
