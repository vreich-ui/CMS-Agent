import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { CAPTURE_CONDUCTOR_WORKFLOW_ID } from "../../../src/agent/workspace/captureConductorWorkflow.js";
import { CLONE_CONDUCTOR_WORKFLOW_ID } from "../../../src/agent/workspace/cloneConductorWorkflow.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { maybeChainCloneAfterCapture, SITE_DUPLICATION_REQUEST_STAGE_KEY } from "../../../src/agent/workspace/siteDuplicationChain.js";
import { HALTED_EXECUTION_STATUSES, type WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";

// T15.9 (#188) — proves the run maybeChainCloneAfterCapture actually starts is not a lookalike: it is
// dispatched by the SAME deterministic route (cloneConductorRoutes.runCloneStage) every other
// clone_conductor run uses, composing the SAME shared publish segment (ADR-2026-08-25-publish-
// autonomy §6.1) clonePublishTail.test.ts already proves end to end. This file ties the two together
// on the run the CHAIN itself produced — captureRunId and all — rather than re-deriving the tail's
// own correctness from scratch (that is #189/T15.10's already-covered territory).

const TARGET = "zilberman-chain-clone-publish";
const TARGET_ENDPOINT = "https://zilberman-chain-clone-publish.example/mcp";
const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

const createTargetProject = async (autonomyMode?: "autonomous" | "operator-gated") => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "Zilberman chain-clone publish fixture", mcpEndpointEnvVar: "ZILBERMAN_CHAIN_CLONE_PUBLISH_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "allowed" })
  );
  if (autonomyMode) await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode }));
};

// A completed, site.duplicate-originated capture run — the chain's own starting point. No real crawl
// is re-run here (siteDuplicateOneCall.test.ts already proves that half); this fixture stands in for
// "a capture run that finished", exactly as buildCaptureRun does in siteDuplicateChainClone.test.ts.
const buildCompletedCaptureRun = async (): Promise<WorkflowExecutionRecord> => {
  const store = repositoryManager.getExecutionRepository();
  const started = await startDryRun({ projectId: TARGET, workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID, executionMode: "mock", input: { sourceUrl: SOURCE_URL, targetProjectId: TARGET } }, store);
  const request = { artifact: "site_duplication.v1" as const, requestedAt: started.startedAt, sourceUrl: SOURCE_URL, targetProjectId: TARGET, statusTool: "site.duplicate_status" as const, humanChecklist: [] };
  return store.saveRun({ ...started, status: "completed", stageOutputs: { ...started.stageOutputs, [SITE_DUPLICATION_REQUEST_STAGE_KEY]: request }, updatedAt: new Date().toISOString() });
};

// The SAME fixture envelope shapes clonePublishTail.test.ts uses for recipe_mint/theme_bind/
// layout_restamp/clone_intake — one recipe minted cleanly (publishable), one page restamped (real
// write, but not chartered for publish per structure-studio ADR §2.1), nothing quarantined.
const intakeEnvelope = () => ({ artifact: "clone_intake.v1", target: TARGET, site: { objectId: "site_zilberman" }, theme: { objectId: "theme_captured" } });
const mintEnvelope = () => ({
  artifact: "clone_recipe_mint.v1",
  applied: [{ objectType: "section_template", objectId: "tmpl_hero", requestedId: "req_hero", name: "Hero", draftVerified: true }],
  rejected: [],
  reused: [],
  substitutions: []
});
const themeBindEnvelope = () => ({ artifact: "clone_theme_bind.v1", siteId: "site_zilberman", themeId: "theme_captured", applied: { colors: {}, fonts: {} }, dropped: [], substitutions: [] });
const restampEnvelope = () => ({ artifact: "clone_restamp.v1", restamped: [{ objectId: "page_home", ops: [] }], skipped: [], quarantined: [] });

// Splices the four upstream envelopes onto a run and drives it through publish_payload ->
// publication_controller -> publish_executor via the SAME deterministic dispatch the executor itself
// calls (executor.ts:2141, runCloneStage) — not a reimplementation.
const driveThroughPublishTail = async (run: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> => {
  let current: WorkflowExecutionRecord = {
    ...run,
    stageOutputs: { ...run.stageOutputs, clone_intake: intakeEnvelope(), recipe_mint: mintEnvelope(), theme_bind: themeBindEnvelope(), layout_restamp: restampEnvelope() }
  };
  const nodes = listCloneConductorNodes();
  for (const stage of ["publish_payload", "publication_controller", "publish_executor"] as const) {
    const node = nodes.find((candidate) => candidate.id === stage)!;
    const outcome = await runCloneStage({ run: current, node, stage });
    expect(outcome.kind, `${stage} refused: ${outcome.kind === "refused" ? outcome.message : ""}`).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    current = { ...current, stageOutputs: { ...current.stageOutputs, [stage]: outcome.output } };
  }
  return current;
};

describe("the chained clone publishes through the shared segment", () => {
  let calledVerbs: string[];

  beforeEach(() => {
    resetRepositoryManager();
    calledVerbs = [];
    process.env.ZILBERMAN_CHAIN_CLONE_PUBLISH_MCP_ENDPOINT = TARGET_ENDPOINT;
  });
  afterEach(() => {
    delete process.env.ZILBERMAN_CHAIN_CLONE_PUBLISH_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const stubFetch = () =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (!String(url).startsWith(TARGET_ENDPOINT)) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push(name);
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}` });
      if (name === "object_publish") return respond(request.id, { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } });
      if (name === "object_checkin") return respond(request.id, { released: true });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

  it("a chained clone run (real captureRunId provenance, real publishingPolicySnapshot) publishes the minted recipe through publish_payload/publication_controller/publish_executor — the SAME shared segment every workflow composes, no bespoke path", async () => {
    await createTargetProject("autonomous");
    stubFetch();
    const capture = await buildCompletedCaptureRun();

    const chainOutcome = await maybeChainCloneAfterCapture(capture, {
      executionRepository: repositoryManager.getExecutionRepository(),
      workspaceRepository: repositoryManager.getWorkspaceRepository(),
      usageRepository: repositoryManager.getUsageRepository()
    });
    expect(chainOutcome.action).toBe("chained");
    if (chainOutcome.action !== "chained") throw new Error("unreachable");

    // Provenance travels with the run the chain produced — this IS the run under test below.
    expect((chainOutcome.cloneRun.initialInput as Record<string, unknown>).captureRunId).toBe(capture.runId);
    expect(chainOutcome.cloneRun.publishingPolicySnapshot?.autonomyMode).toBe("autonomous");
    expect(chainOutcome.cloneRun.publishingPolicySnapshot?.publishableTypes).toEqual(resolvePublishableTypeCharter(CLONE_CONDUCTOR_WORKFLOW_ID).publishableTypes);

    const final = await driveThroughPublishTail(chainOutcome.cloneRun);

    const publishExecution = final.stageOutputs.publish_executor as Record<string, unknown>;
    expect(publishExecution.publishCommitted).toBe(true);
    expect((publishExecution.objectPublish as { published: Array<{ objectId: string }> }).published.map((entry) => entry.objectId)).toEqual(["tmpl_hero"]);
    expect((publishExecution.publishAuthority as { source: string | null }).source).toBe("policy_autonomous");
    expect(calledVerbs).toContain("object_publish");
    // No bespoke publish path: nothing here ever calls release_to_production directly (Board decision
    // B2) or any capture/clone-local publish verb — only the object-scoped checkout/publish/checkin
    // triad the shared publish_executor route itself performs.
    expect(calledVerbs.every((verb) => ["object_checkout", "object_publish", "object_checkin"].includes(verb))).toBe(true);
  });
});

describe("an operator's withheld decision halts the chained clone", () => {
  beforeEach(() => {
    resetRepositoryManager();
    process.env.ZILBERMAN_CHAIN_CLONE_PUBLISH_MCP_ENDPOINT = TARGET_ENDPOINT;
  });
  afterEach(() => {
    delete process.env.ZILBERMAN_CHAIN_CLONE_PUBLISH_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("withheld set on the freshly chained clone run halts it at the REAL executor's dispatch gate — no object_publish, no release call, ever", async () => {
    await createTargetProject("autonomous");
    const capture = await buildCompletedCaptureRun();

    const chainOutcome = await maybeChainCloneAfterCapture(capture, {
      executionRepository: repositoryManager.getExecutionRepository(),
      workspaceRepository: repositoryManager.getWorkspaceRepository(),
      usageRepository: repositoryManager.getUsageRepository()
    });
    expect(chainOutcome.action).toBe("chained");
    if (chainOutcome.action !== "chained") throw new Error("unreachable");

    // The chain deliberately does NOT drive the clone run itself (siteDuplicationChain.ts's own
    // header explains why): it is left "queued" for the run-continuation tick's normal selector to
    // pick up. That is exactly the window a real operator has to act — set BEFORE anything downstream
    // of clone_intake ever dispatches.
    expect(chainOutcome.cloneRun.status).toBe("queued");
    const withheld = await setOperatorPublishDecision(chainOutcome.cloneRunId, "withheld", repositoryManager.getExecutionRepository());
    expect(withheld?.operatorPublishDecision).toBe("withheld");

    // Drive the ACTUAL chained run through the REAL executor (runNextNode — the same entry point
    // workflow_run_all/the continuation tick use), with no publish-side network stub at all: every
    // deterministic clone stage upstream of the tail correctly refuses against this run's absent
    // capture snapshot and falls through to a schema-valid mock placeholder (this file's OTHER test
    // proves the SAME shared segment publishes for real, against a real minted recipe — this test
    // proves withheld halts it regardless of what upstream produced).
    let run = (await getRun(chainOutcome.cloneRunId, repositoryManager.getExecutionRepository()))!;
    for (let i = 0; i < 30 && !HALTED_EXECUTION_STATUSES.has(run.status); i += 1) {
      run = await runNextNode(chainOutcome.cloneRunId, { executionRepository: repositoryManager.getExecutionRepository() });
    }

    // ADR-2026-08-25-publish-autonomy §2.4 rule 1: withheld halts in every mode, unconditionally,
    // reached through the SAME publish-risk dispatch guard every tail-composing workflow shares
    // (executor.ts's markPendingPublishApproval / isPublishRisk) — nothing this chain adds or skips.
    expect(run.status).toBe("blocked");
    expect(run.stageOutputs.publish_executor).toBeUndefined();
    expect(run.stageOutputs.release_executor).toBeUndefined();
    expect(run.approvalsRequired.some((entry) => entry.reason.includes("withheld"))).toBe(true);
  });
});
