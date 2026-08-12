import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDeterministicPublishPayload,
  collectUpstreamBlockers,
  readArticleBody,
  readTopLevelObjectId,
  resolveBlockers,
  runDeterministicPublishPayload,
  type PublishPayloadValidation
} from "../../../src/agent/workspace/publishPayload.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";

// W0 (determinism program, 2026-08-12): publish_payload cost $2.73 of the last $5.56 live run and
// emitted a clientObject byte-identical to article_body.body. This suite proves: (1) the builder alone
// produces schema-valid output and carries the client object BY REFERENCE (identity, not equality —
// a copy is an opportunity to differ); (2) the blocker math is union-minus-resolved, with resolution
// only ever claimed on the client validator's own pass; (3) wired into a real run it replaces the
// model call entirely, proven by zero usage records in "openai" mode with no model stub configured;
// (4) any failure falls through to the model path unchanged.

const sampleBody = () => ({ slug: "governed-content-lifecycle", title: "Governed content lifecycle", nodes: [{ id: "n1", type: "paragraph", text: "Body." }] });

const sampleArticleBody = (overrides: Record<string, unknown> = {}) => ({
  artifact: "client_object.v1",
  summary: "Client object built to the fetched contract.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-12T08:00:00.000Z", fingerprint: "fp_sample" },
  body: sampleBody(),
  artifactReferences: [{ key: "req_x/hero.webp", digest: "sha256:abc" }],
  blockers: [],
  ...overrides
});

const sampleArtifactPlan = (overrides: Record<string, unknown> = {}) => ({
  artifact: "artifact_plan.v1",
  summary: "Zero-media plan.",
  requestId: "req_sample_20260812_01",
  artifactProtocol: "pdf-tool agent artifact protocol",
  blockers: [],
  ...overrides
});

const validated = (overrides: Partial<PublishPayloadValidation> = {}): PublishPayloadValidation => ({
  attempted: true,
  tool: "object_validate",
  valid: true,
  issues: [],
  candidate_patch_summary: "2 ops: 1 set_article_meta + 1 upsert_node",
  ...overrides
});

describe("buildDeterministicPublishPayload — happy path", () => {
  it("produces output that validates against the real publish_payload node's own outputSchema", () => {
    const node = getWorkspaceNode("publish_payload")!;
    const built = buildDeterministicPublishPayload({ articleBody: sampleArticleBody(), artifactPlan: sampleArtifactPlan(), clientProjectId: "platform" }, validated());
    expect(built.ok).toBe(true);
    const result = validateOutput(built.ok ? built.payload : {}, node.outputSchema);
    expect(result.ok, JSON.stringify(result.ok ? [] : result.errors)).toBe(true);
  });

  it("carries clientObject BY REFERENCE from article_body.body — the whole $2.73 finding", () => {
    const articleBody = sampleArticleBody();
    const built = buildDeterministicPublishPayload({ articleBody, artifactPlan: sampleArtifactPlan(), clientProjectId: "platform" }, validated());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Identity, not deep equality: the object is not re-derived, re-keyed, or cloned.
    expect(built.payload.clientObject).toBe(articleBody.body);
  });

  it("carries the envelope and artifactReferences through verbatim and never invents a protocol or requestId", () => {
    const articleBody = sampleArticleBody();
    const plan = sampleArtifactPlan();
    const built = buildDeterministicPublishPayload({ articleBody, artifactPlan: plan, clientProjectId: "platform" }, validated());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.clientObjectType).toBe("content_item");
    expect(built.payload.contractSource).toBe(articleBody.contractSource);
    expect(built.payload.artifactReferences).toBe(articleBody.artifactReferences);
    expect(built.payload.artifactProtocol).toBe(plan.artifactProtocol);
    expect(built.payload.requestId).toBe(plan.requestId);
    expect(built.payload.dryRun).toBe(true);
    expect(built.payload.artifactHandling.legacyFallbacksUsed).toBe(false);
  });

  it("omits artifactProtocol/requestId entirely when the plan named none (a zero-media plan legitimately has neither)", () => {
    const built = buildDeterministicPublishPayload({ articleBody: sampleArticleBody(), artifactPlan: { artifact: "artifact_plan.v1", blockers: [] }, clientProjectId: "platform" }, validated());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload).not.toHaveProperty("artifactProtocol");
    expect(built.payload).not.toHaveProperty("requestId");
    // …and the omission still satisfies the node's own schema (both fields are minLength-1 when present).
    expect(validateOutput(built.payload, getWorkspaceNode("publish_payload")!.outputSchema).ok).toBe(true);
  });

  it("records a requires_existing_object deferral as a NORMAL outcome, not a blocker", () => {
    const built = buildDeterministicPublishPayload(
      { articleBody: sampleArticleBody(), artifactPlan: sampleArtifactPlan(), clientProjectId: "platform" },
      validated({ valid: false, deferred: "requires_existing_object", issues: ["object not found"] })
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.blockers).toEqual([]);
    expect(built.payload.validationAssumptions.some((a) => a.includes("NORMAL deferral"))).toBe(true);
  });
});

describe("blocker math: union(upstream) − resolved", () => {
  it("unions both upstream nodes' blockers and de-duplicates case/whitespace variants, keeping first-seen wording", () => {
    const upstream = collectUpstreamBlockers(
      { blockers: ["taxonomy_unresolved: term 'x' is unknown", "  Media Missing  "] },
      { blockers: ["media missing", "artifact_unverified: slot hero has no evidence"] }
    );
    expect(upstream).toEqual(["taxonomy_unresolved: term 'x' is unknown", "  Media Missing  ", "artifact_unverified: slot hero has no evidence"]);
  });

  it("subtracts client-validation blockers only when the client's own validator actually passed", () => {
    const upstream = ["clientValidation deferred: final_revalidation_not_completed_tool_call_limit_exceeded", "taxonomy_unresolved: term 'x'"];

    const passed = resolveBlockers(upstream, validated());
    expect(passed.resolved).toEqual(["clientValidation deferred: final_revalidation_not_completed_tool_call_limit_exceeded"]);
    expect(passed.blockers).toEqual(["taxonomy_unresolved: term 'x'"]);

    // The validator did not pass — nothing is resolved, including the validation blocker itself.
    const notPassed = resolveBlockers(upstream, validated({ valid: false, deferred: "requires_existing_object" }));
    expect(notPassed.resolved).toEqual([]);
    expect(notPassed.blockers).toEqual(upstream);
  });

  it("never resolves a non-validation blocker, however the validator answered", () => {
    const upstream = ["media_unverified: hero slot has no materialization evidence"];
    expect(resolveBlockers(upstream, validated()).blockers).toEqual(upstream);
  });

  it("end-to-end: carries surviving upstream blockers and adds its own when the validator rejects", () => {
    const built = buildDeterministicPublishPayload(
      {
        articleBody: sampleArticleBody({ blockers: ["clientValidation deferred: final_revalidation_not_completed", "taxonomy_unresolved: term 'x'"] }),
        artifactPlan: sampleArtifactPlan({ blockers: ["taxonomy_unresolved: term 'x'", "artifact_unverified: hero"] }),
        clientProjectId: "platform"
      },
      validated({ valid: false, issues: ["slug pattern violated"] })
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.blockers).toEqual([
      "clientValidation deferred: final_revalidation_not_completed",
      "taxonomy_unresolved: term 'x'",
      "artifact_unverified: hero",
      "client_validation_failed: the client's own validator rejected the candidate patch (slug pattern violated)."
    ]);
  });

  it("raises its own blocker and asserts nothing when the client could not be reached at all", () => {
    const built = buildDeterministicPublishPayload(
      { articleBody: sampleArticleBody(), artifactPlan: sampleArtifactPlan(), clientProjectId: "platform" },
      { attempted: false, tool: "object_validate", valid: false, issues: [], error: "connection refused" }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.blockers).toEqual([expect.stringContaining("client_validation_unavailable")]);
    expect(built.payload.clientValidation.valid).toBe(false);
  });
});

describe("refusals: the builder reports failure instead of assembling around missing facts", () => {
  it.each([
    ["article_body_absent", undefined],
    ["client_object_absent", { clientObjectType: "content_item", contractSource: {}, body: {} }],
    ["client_object_type_absent", { contractSource: {}, body: sampleBody() }],
    ["contract_source_absent", { clientObjectType: "content_item", body: sampleBody() }]
  ])("refuses with %s", (code, articleBody) => {
    const read = readArticleBody(articleBody);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe(code);
  });

  it("never hands the validator a child node's id as the object under validation", () => {
    // objectDialect.findObjectId searches DEEP for `id`; a body's nodes[] each carry one.
    expect(readTopLevelObjectId(sampleBody())).toBeUndefined();
    expect(readTopLevelObjectId({ ...sampleBody(), object_id: 4711 })).toBe(4711);
  });
});

describe("publish.build_payload — the runId projection (W0 complement)", () => {
  const buildPayloadTool = () => createWorkspaceTools({}).find((candidate) => candidate.name === "publish.build_payload")!;

  it("still wraps a supplied articleBody exactly as before (no behavior change on the legacy path)", async () => {
    const articleBody = sampleArticleBody();
    const result = await buildPayloadTool().execute({ articleBody, target: "preview" }) as { data: { payload: { articleBody: unknown; target: string; dryRun: boolean } } };
    expect(result.data.payload.articleBody).toEqual(articleBody);
    expect(result.data.payload.target).toBe("preview");
    expect(result.data.payload.dryRun).toBe(true);
  });

  it("refuses when neither or both of articleBody/runId are supplied", async () => {
    await expect(buildPayloadTool().execute({})).rejects.toThrow(/exactly one/);
    await expect(buildPayloadTool().execute({ articleBody: sampleArticleBody(), runId: "run_x" })).rejects.toThrow(/exactly one/);
  });

  it("names an unknown run rather than projecting from nothing", async () => {
    await expect(buildPayloadTool().execute({ runId: "run_does_not_exist" })).rejects.toThrow(/unknown_run/);
  });

  it("projects dry_run_publish_payload.v1 from a real run's own article_body stage output", async () => {
    const articleBody = sampleArticleBody();
    // Default (shared) execution repository, because that is the one the wire tool reads through.
    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "W0 projection", entrypoint: { nodeId: "article_body", output: articleBody } });

    const result = await buildPayloadTool().execute({ runId: started.runId }) as { data: { projection: { artifact: string; clientObject: unknown; dryRun: boolean }; schemaValid: boolean; dryRun: boolean } };
    expect(result.data.projection.artifact).toBe("dry_run_publish_payload.v1");
    expect(result.data.projection.dryRun).toBe(true);
    expect(result.data.projection.clientObject).toEqual(articleBody.body);
    expect(result.data.schemaValid).toBe(true);
    expect(result.data.dryRun).toBe(true);
  });
});

describe("wired into a real run: replaces the model call entirely", () => {
  const ENDPOINT = "https://platform.example/mcp";
  let remoteFetch: ReturnType<typeof vi.fn>;

  const seedArticleBody = () => ({
    artifact: "client_object.v1",
    summary: "Seeded client object for the W0 end-to-end test.",
    clientProjectId: "platform",
    clientObjectType: "content_item",
    contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-12T08:00:00.000Z", fingerprint: "fp_e2e" },
    body: sampleBody(),
    blockers: []
  });

  beforeEach(() => {
    process.env.PLATFORM_MCP_ENDPOINT = ENDPOINT;
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

  // Enter late-stage at article_body (which seeds its own output and completes every ancestor), then
  // satisfy publish_payload's OTHER dependency (artifact_plan) directly through the execution
  // repository, so publish_payload is the only node this run ever dispatches. "openai" mode with no
  // OpenAI network stub anywhere: if the deterministic bypass did NOT fire, the model runner would
  // attempt a real provider call and this test would throw. Succeeding IS the proof.
  const startAtPublishPayload = async (store: ExecutionRepository, articleBodyOutput: unknown) => {
    const started = await startDryRun({
      executionMode: "openai",
      projectId: "platform",
      input: "W0 e2e",
      budgetUsd: 100,
      entrypoint: { nodeId: "article_body", output: articleBodyOutput }
    }, store);
    const run = (await getRun(started.runId, store))!;
    const planState = run.nodes.find((node) => node.nodeId === "artifact_plan")!;
    const planOutput = { artifact: "artifact_plan.v1", summary: "No media slots declared.", slots: [], blockers: [] };
    planState.status = "completed";
    planState.output = planOutput;
    run.stageOutputs.artifact_plan = planOutput;
    await store.saveRun(run);
    return started.runId;
  };

  it("completes publish_payload in openai mode with zero model calls, one client read, and zero usage records", async () => {
    repositoryManager.getUsageRepository().clear();
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startAtPublishPayload(store, seedArticleBody());

    const run = await runNextNode(runId, { executionRepository: store });
    const state = run!.nodes.find((node) => node.nodeId === "publish_payload")!;

    expect(state.status).toBe("completed");
    const output = state.output as { artifact: string; summary: string; dryRun: boolean; clientObject: Record<string, unknown> };
    expect(output.artifact).toBe("dry_run_publish_payload.v1");
    expect(output.dryRun).toBe(true);
    expect(output.summary).toMatch(/No model call/);
    expect(output.clientObject).toEqual(sampleBody());

    // Exactly one client call: the single object_validate this node is allowed.
    expect(remoteFetch).toHaveBeenCalledTimes(1);
    const call = JSON.parse((remoteFetch.mock.calls[0]![1] as { body: string }).body) as { params: { name: string } };
    expect(call.params.name).toBe("object_validate");

    const usage = await repositoryManager.getUsageRepository().list({ runId, nodeId: "publish_payload" });
    expect(usage).toEqual([]);
  });

  it("falls back to the model path (and warns) when the deterministic build cannot be trusted", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    // article_body's seeded envelope is schema-valid but carries a body the builder refuses to
    // assemble around — clientObjectType present, contractSource absent is impossible past the
    // entrypoint validator, so the reachable failure is an empty client object.
    const runId = await startAtPublishPayload(store, { ...seedArticleBody(), body: { placeholder: "" } });
    const run = (await getRun(runId, store))!;
    // Make the builder's own output schema-invalid by removing the field the payload's envelope
    // copies verbatim, via the one route the entrypoint validator cannot police: the stage output.
    run.stageOutputs.article_body = { ...(run.stageOutputs.article_body as Record<string, unknown>), contractSource: undefined };
    await store.saveRun(run);

    const advanced = await runNextNode(runId, { executionRepository: store }).catch((error: Error) => error);
    const latest = (await getRun(runId, store))!;
    const state = latest.nodes.find((node) => node.nodeId === "publish_payload")!;

    // The deterministic path refused and said so by name; execution then went to the normal model
    // path, which in this environment has no provider configured — i.e. the fallback really happened
    // rather than a deterministic output being shipped from missing data.
    expect(state.warnings ?? []).toContainEqual(expect.stringContaining("publish_payload_deterministic_unavailable:contract_source_absent"));
    expect(state.status).not.toBe("completed");
    expect(advanced).toBeDefined();
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});
