import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import { buildRunContext } from "../../../src/agent/workspace/runContext.js";
import { getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { handler } from "../../../netlify/functions/mcp.mjs";

// S3 (2026-08-25) — THE SEEDED RUN THAT COULD NOT PUBLISH: run_1787656120374_18bobg, project dr-lurie.
//
// `workflow.start_dry_run` supports a late-stage entrypoint (`entrypoint: "article_body"` plus a
// supplied `articleBody`) that seeds the entry node and every ancestor as completed, so the run skips
// ideation/research/drafting. It is the cheap path for exercising publish mechanics without burning
// tokens. On that run the publication_controller said "go", operatorPublishDecision was "approved",
// and all five publisher gates passed — and publish_executor still refused:
//
//   publish_request_id_absent at request_id: no upstream output and no run context carries a publish
//   requestId (req_<flow>_<topic>_<yyyymmdd>_<nn>). The id is operator-supplied by contract and is
//   never minted here, so dr-lurie is not published; supply it on artifact_plan/publish_payload and
//   retry.
//
// The publish request id is authored by exactly ONE node, artifact_plan — and a late-stage entrypoint
// seeds artifact_plan as `{seeded:true, skipped:true, reason:"late_stage_entry"}` with no stage output
// at all. A seeded run was therefore structurally incapable of publishing.
//
// The fix is a supply channel, not a mint, AND it is installed at the run's one lift point rather than
// at the publisher. `publishRequestId` is supplied by the operator at start_dry_run, validated there
// against the project's declared pattern, stored on the run as its OWN field, and read by
// `buildRunContext` as the FALLBACK behind artifact_plan's authored id. Everything downstream —
// publish_payload's deterministic builder, publish_executor's engine path — already reads
// runContext.requestId, so both get the id with no publisher-specific special case anywhere.
//
// WHY THE SEAM MATTERS, and what an earlier attempt got wrong: resolving the fallback inside
// runEnginePublishExecution instead would have fixed publish_executor ALONE. runContext.requestId
// would have stayed empty, so publish_payload would have kept emitting a candidate with its optional
// `requestId` field missing — schema-valid, and wrong: the payload an operator reviews would not name
// the id the publish is actually made under. The `publish_payload` assertion in this suite is exactly
// the assertion that seam could not make.
//
// What this suite pins:
//   1. buildRunContext: authored id first, the run's stored one as fallback, never run.requestId;
//   2. a seeded run's publish_payload now CARRIES requestId (the new fact);
//   3. a seeded run's publish_executor reaches the publish sequence with that same id;
//   4. seeded run + NO id -> publish_request_id_absent still refuses, unchanged;
//   5. malformed id -> refused at start_dry_run, before any run is created;
//   6. the publish id is never run.requestId — the platform/workspace join key — in either direction.
const PUBLISH_REQUEST_ID = "req_article_seeded_20260825_01";

const seededArticleBody = () => ({
  artifact: "client_object.v1",
  summary: "Seeded client object for the S3 late-stage entrypoint run.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-25T08:00:00.000Z", fingerprint: "fp_s3" },
  body: { slug: "seeded-publish", title: "Seeded publish", nodes: [{ id: "n1", type: "paragraph", text: "Body." }] },
  blockers: []
});

// The same seeded body, with reader-facing prose long enough to clear the publisher's own readiness
// content floor — so the publish sequence below stops (if it stops) on something this change is about,
// not on a stub article.
const publishableArticleBody = () => ({
  ...seededArticleBody(),
  body: {
    slug: "seeded-publish",
    title: "Seeded publish",
    nodes: [{
      id: "n1",
      type: "paragraph",
      text: "This paragraph exists so the fixture reads as a real article rather than a stub: it states the claim, names the tradeoff, and gives the reader one concrete next step to take today. It is long enough to clear the readiness content floor the publisher applies before it will touch a live client object."
    }]
  }
});

describe("S3 — buildRunContext lifts the publish id: authored first, the run's stored one as the fallback", () => {
  it("uses the run's stored publishRequestId when artifact_plan authored none (the seeded run's shape)", () => {
    const context = buildRunContext({ clientProjectId: "platform", stageOutputs: {}, publishRequestId: PUBLISH_REQUEST_ID });
    expect(context.requestId).toBe(PUBLISH_REQUEST_ID);
  });

  it("keeps the AUTHORED id winning — a real artifact_plan outranks the operator's stored one", () => {
    const context = buildRunContext({
      clientProjectId: "platform",
      stageOutputs: { artifact_plan: { requestId: "req_article_authored_20260825_07" } },
      publishRequestId: PUBLISH_REQUEST_ID
    });
    expect(context.requestId).toBe("req_article_authored_20260825_07");
  });

  it("mints nothing: no authored id and no stored id leaves run context with no requestId at all", () => {
    expect(buildRunContext({ clientProjectId: "platform", stageOutputs: {} }).requestId).toBeUndefined();
    // An empty-ish stored value is not a value. Absent stays absent, and publish_executor's refusal
    // stands — which is the correct outcome for a run nobody gave an id to.
    expect(buildRunContext({ clientProjectId: "platform", publishRequestId: "   " }).requestId).toBeUndefined();
  });
});

describe("S3 — wired into a real seeded run: publish_payload now carries the requestId", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.PLATFORM_MCP_ENDPOINT = "https://platform.example/mcp";
    process.env.PLATFORM_MCP_TOKEN = "secret-token";
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      const result = request.method === "tools/call" ? { structuredContent: { valid: true, issues: [] } } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLATFORM_MCP_ENDPOINT;
    delete process.env.PLATFORM_MCP_TOKEN;
  });

  // A REAL late-stage entrypoint run: artifact_plan is genuinely seeded-and-skipped here, with no
  // stage output, so nothing in this run authored a publish id. "openai" mode with no provider
  // configured anywhere — the deterministic publish_payload route is what completes the node, so a
  // silent regression to the model path would fail this test rather than pass it quietly.
  const startSeededRun = async (store: ExecutionRepository, publishRequestId?: string) => {
    const started = await startDryRun({
      executionMode: "openai",
      projectId: "platform",
      input: "S3 seeded publish",
      budgetUsd: 100,
      entrypoint: { nodeId: "article_body", output: seededArticleBody() }
    }, store);
    if (publishRequestId) {
      const run = (await getRun(started.runId, store))!;
      run.publishRequestId = publishRequestId;
      await store.saveRun(run);
    }
    return started.runId;
  };

  it("confirms the run authors nothing: artifact_plan is completed-and-skipped with no requestId", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startSeededRun(store, PUBLISH_REQUEST_ID);
    const run = (await getRun(runId, store))!;

    const artifactPlan = run.nodes.find((node) => node.nodeId === "artifact_plan")!;
    expect(artifactPlan.status).toBe("completed");
    expect(artifactPlan.warnings).toContain("late_stage_entry_skipped");
    expect(artifactPlan.output).toMatchObject({ seeded: true, skipped: true, reason: "late_stage_entry" });
    expect((artifactPlan.output as Record<string, unknown>).requestId).toBeUndefined();
    expect(run.stageOutputs.artifact_plan).toBeUndefined();
  });

  // THE ASSERTION THE OLD SEAM COULD NOT MAKE. With the fallback resolved at the publisher, this run
  // context stayed empty and publish_payload emitted no `requestId` at all — schema-valid (the field
  // is optional on dry_run_publish_payload.v1) and wrong, because the candidate an operator reviews
  // would not name the id the publish is made under. Resolved at buildRunContext, it does.
  it("emits the operator's id on the publish candidate — and never the run's platform join key", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startSeededRun(store, PUBLISH_REQUEST_ID);

    const run = await runNextNode(runId, { executionRepository: store });
    const state = run!.nodes.find((node) => node.nodeId === "publish_payload")!;

    expect(state.status).toBe("completed");
    const output = state.output as { artifact: string; requestId?: string };
    expect(output.artifact).toBe("dry_run_publish_payload.v1");
    expect(output.requestId).toBe(PUBLISH_REQUEST_ID);
    expect(output.requestId).not.toBe(run!.requestId);
  });

  it("keeps emitting no requestId when the operator supplied none — absent is still absent", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startSeededRun(store);

    const run = await runNextNode(runId, { executionRepository: store });
    const state = run!.nodes.find((node) => node.nodeId === "publish_payload")!;

    expect(state.status).toBe("completed");
    // The join key exists on the run and is deliberately NOT borrowed to fill this field.
    expect(run!.requestId).toBeTruthy();
    expect(state.output as Record<string, unknown>).not.toHaveProperty("requestId");
  });
});

describe("S3 — wired into a real seeded run: publish_executor reaches the sequence with that id", () => {
  const CLIENT_RESULTS: Record<string, unknown> = {
    object_create: { object_id: "obj_platform_5511" },
    object_checkout: { lock_token: "lock_s3", record_version: 2 },
    object_validate: { valid: true, issues: [] },
    object_patch: { record_version: 3 },
    object_publish: { status: "published", commit_sha: "aa11bb22", content_revision: 3 },
    object_checkin: { released: true }
  };
  let remoteFetch: ReturnType<typeof vi.fn>;
  let calledTools: string[];

  beforeEach(() => {
    process.env.PLATFORM_MCP_ENDPOINT = "https://platform.example/mcp";
    process.env.PLATFORM_MCP_TOKEN = "secret-token";
    calledTools = [];
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string } };
      const name = request.params?.name;
      if (request.method === "tools/call" && name) calledTools.push(name);
      const result = request.method === "tools/call" ? { structuredContent: CLIENT_RESULTS[name ?? ""] ?? {} } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLATFORM_MCP_ENDPOINT;
    delete process.env.PLATFORM_MCP_TOKEN;
  });

  // The live run's exact shape: a late-stage entrypoint at article_body (so artifact_plan is a seeded,
  // output-less ancestor that authored no publish id), publish_payload and publication_controller
  // already completed, the controller saying "go" and the operator "approved" — and publish_executor
  // opted all the way in to the ENGINE execute path, the path that reads runContext.requestId at
  // executor.ts's runEnginePublishExecution call site.
  //
  // The seeded publish_payload output deliberately carries NO requestId of its own: that is what a
  // seeded run's payload looked like before this change, so the id on the receipts below can only have
  // come through run context.
  const startAtExecutor = async (publishRequestId?: string) => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspace: WorkspaceRepository = new RepositoryManager().getWorkspaceRepository();
    await workspace.updateNode("publish_executor", { metadata: { publishExecutorDeterministic: "execute" } }, { actor: "s3-test" });

    const started = await startDryRun({
      executionMode: "openai",
      projectId: "platform",
      input: "S3 seeded publish executor",
      budgetUsd: 100,
      entrypoint: { nodeId: "article_body", output: publishableArticleBody() }
    }, store, workspace);

    const run = (await getRun(started.runId, store))!;
    const complete = (nodeId: string, output: unknown) => {
      const state = run.nodes.find((node) => node.nodeId === nodeId)!;
      state.status = "completed";
      state.output = output;
      run.stageOutputs[nodeId] = output;
    };
    complete("publish_payload", {
      artifact: "dry_run_publish_payload.v1",
      summary: "Candidate from a seeded late-stage run.",
      clientProjectId: "platform",
      clientObjectType: "content_item",
      contractSource: { tool: "object_contract", fingerprint: "fp_s3" },
      dryRun: true,
      clientObject: publishableArticleBody().body,
      blockers: []
    });
    complete("publication_controller", { artifact: "publication_decision.v1", summary: "Ready.", decision: "go", blockers: [] });
    run.currentNodeId = "publish_executor";
    if (publishRequestId) run.publishRequestId = publishRequestId;
    await store.saveRun(run);
    await setOperatorPublishDecision(started.runId, "approved", store);
    return { runId: started.runId, store, workspace };
  };

  const executePublish = async (publishRequestId?: string) => {
    const { runId, store, workspace } = await startAtExecutor(publishRequestId);
    const run = await runNextNode(runId, { executionRepository: store, workspaceRepository: workspace, approved: true });
    const state = run!.nodes.find((node) => node.nodeId === "publish_executor")!;
    return { run: run!, output: state.output as { publishCommitted?: boolean; receipts?: { requestId?: string; toolSequence?: string[] }; blockers?: string[] } };
  };

  it("carries the operator's id onto the publish receipts and runs the whole client sequence", async () => {
    const { run, output } = await executePublish(PUBLISH_REQUEST_ID);

    expect(output.receipts?.requestId).toBe(PUBLISH_REQUEST_ID);
    // Never the platform/workspace join key: the identifier that reaches the client is the operator's.
    expect(output.receipts?.requestId).not.toBe(run.requestId);
    expect(JSON.stringify(output.blockers ?? [])).not.toContain("publish_request_id_absent");
    // The whole point: this run got past the request-id step and actually published. The remaining
    // blocker is publishRun's standing go_live_unconfirmed (board decision B2 — publishRun commits the
    // export and never releases), not anything about the id.
    expect(output.publishCommitted).toBe(true);
    expect(calledTools).toEqual(["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"]);
    expect(output.receipts?.toolSequence).toEqual(calledTools);
  });

  it("still refuses publish_request_id_absent, calling nothing, when the operator supplied none", async () => {
    const { output } = await executePublish();

    expect(JSON.stringify(output.blockers ?? [])).toContain("publish_request_id_absent");
    expect(output.receipts?.requestId).toBeUndefined();
    expect(calledTools).toEqual([]);
  });
});

describe("S3 — workflow.start_dry_run validates the publish id before a run exists", () => {
  const validArticleBody = {
    artifact: "client_object.v1",
    summary: "Supplied client-shaped body for a late-stage entrypoint run.",
    clientProjectId: "dr-lurie",
    clientObjectType: "content_item",
    contractSource: { tool: "object_contract", objectType: "content_item", fetchedAt: "2026-07-28T00:00:00.000Z" },
    body: { slug: "supplied-title", title: "Supplied Title", nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Supplied Title", body: "Supplied reader-facing body." } }] }
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  const post = async (body: unknown) => JSON.parse((await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) })).body ?? "{}");
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });

  it("refuses a malformed publish id up front — no run is created, the same as a malformed articleBody", async () => {
    const before = (await call("workflow.list_runs", {})).result.structuredContent.data.runs.length;
    const res = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: validArticleBody, publishRequestId: "REQ-Not-Snake" });

    const error = JSON.stringify(res.error ?? res.result?.structuredContent?.error ?? {});
    expect(error).toContain("invalid_publish_request_id");
    expect(error).toContain("req_[a-z0-9_]+_");
    const after = (await call("workflow.list_runs", {})).result.structuredContent.data.runs.length;
    expect(after).toBe(before);
  });

  it("accepts a conforming publish id and stamps it on the run alongside — never onto — requestId", async () => {
    const res = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: validArticleBody, requestId: "req_article_retinol_20260825_01", publishRequestId: PUBLISH_REQUEST_ID });
    expect(res.error).toBeUndefined();
    const run = res.result.structuredContent.data.run;
    expect(run.publishRequestId).toBe(PUBLISH_REQUEST_ID);
    expect(run.requestId).toBe("req_article_retinol_20260825_01");

    const fetched = (await call("workflow.get_run", { runId: run.runId })).result.structuredContent.data.run;
    expect(fetched.publishRequestId).toBe(PUBLISH_REQUEST_ID);
  });

  it("stays optional: omitting it creates the run exactly as before, with no publish id", async () => {
    const res = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: validArticleBody });
    expect(res.error).toBeUndefined();
    expect(res.result.structuredContent.data.run.publishRequestId).toBeUndefined();
  });

  it("survives workflow.reset_run — a reset retries the SAME publish request, it does not drop it", async () => {
    const started = (await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: validArticleBody, publishRequestId: PUBLISH_REQUEST_ID })).result.structuredContent.data.run;
    const afterReset = (await call("workflow.reset_run", { runId: started.runId })).result.structuredContent.data.run;

    expect(afterReset.publishRequestId).toBe(PUBLISH_REQUEST_ID);
    expect(afterReset.requestId).toBe(started.requestId);
    expect(afterReset.currentNodeId).toBe("publish_payload");
  });

  it("advertises publishRequestId on the wire, described as distinct from requestId", async () => {
    const tools: Array<{ name: string; inputSchema: any }> = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
    const schema = tools.find((tool) => tool.name === "workflow_start_dry_run")!.inputSchema;
    expect(schema.properties).toHaveProperty("publishRequestId");
    expect(schema.properties.publishRequestId.description).toContain("requestId");
    expect(schema.required).not.toContain("publishRequestId");
  });
});
