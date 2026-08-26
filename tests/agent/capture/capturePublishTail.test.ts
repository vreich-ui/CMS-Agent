import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { readCaptureStage, runCaptureStage, CAPTURE_STAGES } from "../../../src/agent/workspace/captureConductorRoutes.js";
import { listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { publishingPublishSegmentIds } from "../../../src/agent/workspace/publishingTail.js";
import { buildObjectPublishPlan, type ObjectPublishSourceReport } from "../../../src/agent/workspace/objectPublishExecution.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { publishEnabledEnvVar } from "../../../src/agent/workspace/publisher.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T15.7 (ADR-2026-08-25-publish-autonomy §6, §9) — capture_conductor no longer reaches production
// through a capture-local side path (T14.5's engine/publish.mjs, deleted this change). It composes the
// shared publishing tail's PUBLISH segment (composeWorkflowNodes) exactly as publishing_conductor
// does, and inherits that tail's OWN publish-risk safety machinery (executor.ts's
// resolvePublishAuthority gate) rather than re-implementing an operator check locally. These tests
// prove: (1) the composition is real — the same tail node ids, wired in, capture_publish is gone; (2)
// an object the emission quarantined is named withheld and never reaches a publish call; (3) an
// autonomous project's run reaches release with no operator ever touching it; (4) an operator's
// "withheld" halts the run before any publish call, in every mode.

const TARGET = "zilberman-publish-tail";
const TARGET_ENDPOINT = "https://zilberman-publish-tail.example/mcp";

const AUTHORIZED_CAPTURE_POLICY = {
  maxPages: 20,
  allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
  allowedPathPrefixes: ["/"],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 0,
  authenticatedAccess: "prohibited",
  rights: { content: "retain_allowed_origin_content", media: "prohibited" },
  designReferences: [],
  fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
};

// One publishable page (page_home) and one the emission quarantined (page_new) — the exact shape
// buildObjectPublishPlan (workspace/objectPublishExecution.ts) reads.
const emissionReport = (): ObjectPublishSourceReport => ({
  target: TARGET,
  createdObjects: [{ objectType: "page", objectId: "page_new", mode: "created" }],
  reusedObjects: [{ objectType: "page", objectId: "page_home", mode: "patched" }],
  quarantines: [{ objectId: "page_new", reason: "copy_regeneration_missing" }],
  validationStates: [
    { phase: "postcreate", objectId: "page_new", valid: true, reason: null },
    { phase: "postpatch", objectId: "page_home", valid: true, reason: null }
  ]
});

const liveEmissionEnvelope = () => ({ artifact: "capture_emission_run.v1", live: true, report: emissionReport() });
const fidelityEnvelope = () => ({ artifact: "capture_fidelity.v1", summary: "fixture", rubric: {} });

const PUBLISH_ENDPOINT_ENV_VAR = "ZILBERMAN_PUBLISH_TAIL_MCP_ENDPOINT";

// createProject always seeds publishingPolicy {publishEnabled:true, requiresExplicitPublish:false}
// (server-controlled, per projectAdmin.ts) — autonomyMode is the ONE field an admin call may steer
// (projectUpdateSchema), and publishEnabled's only override is the per-project env kill-switch
// (publisher.ts publishEnabledEnvVar) — never a create/update field. This mirrors both real controls
// exactly rather than a fixture-only shortcut.
const createTargetProject = async (autonomyMode?: "autonomous" | "operator-gated") => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: TARGET,
      name: "Zilberman publish tail fixture",
      mcpEndpointEnvVar: PUBLISH_ENDPOINT_ENV_VAR,
      authMode: "none",
      defaultToolPolicy: "allowed",
      capturePolicy: AUTHORIZED_CAPTURE_POLICY
    })
  );
  if (autonomyMode) {
    await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode }));
  }
};

describe("capture_conductor composes the shared publishing tail", () => {
  it("no longer has a capture_publish node; it carries the SAME tail node ids publishing_conductor uses", () => {
    const nodes = listCaptureConductorNodes();
    expect(nodes.some((node) => node.id === "capture_publish")).toBe(false);
    expect(CAPTURE_STAGES).not.toContain("publish");
    expect(CAPTURE_STAGES).toContain("publish_payload");
    expect(CAPTURE_STAGES).toContain("publication_controller");
    expect(CAPTURE_STAGES).toContain("publish_executor");

    for (const tailId of publishingPublishSegmentIds) {
      expect(nodes.some((node) => node.id === tailId)).toBe(true);
    }

    // The two nodes able to reach object_publish/release_to_production carry the tail's OWN
    // riskLevel — the safety machinery that could never see capture_publish's riskLevel "write".
    const controller = nodes.find((node) => node.id === "publication_controller")!;
    const executor = nodes.find((node) => node.id === "publish_executor")!;
    const releaser = nodes.find((node) => node.id === "release_executor")!;
    expect(controller.riskLevel).toBe("publish");
    expect(executor.riskLevel).toBe("publish");
    expect(releaser.riskLevel).toBe("publish");
    expect(executor.kind).toBe("publisher");
    expect(releaser.kind).toBe("releaser");

    // capture's own dispatch route, not the DTC one: composeWorkflowNodes hands back fresh per-workflow
    // copies, and captureConductorNodes.ts retags exactly these three (release_executor needs no
    // retag — it is already object-agnostic).
    expect(readCaptureStage(controller)).toBe("publication_controller");
    expect(readCaptureStage(executor)).toBe("publish_executor");
    expect(readCaptureStage(releaser)).toBeUndefined();
    expect(releaser.metadata?.releaseExecutorDeterministic).toBe(true);

    // capture_report is still the terminal node, now reporting on what the TAIL did.
    const report = nodes.find((node) => node.id === "capture_report")!;
    expect(report.dependsOn).toContain("publish_executor");
    expect(report.dependsOn).toContain("release_executor");
    expect(report.dependsOn).not.toContain("capture_publish");
    // learning_recorder (the tail's own last node) closes the composed array now, downstream of
    // capture_report's own dependencies — capture_report is still the workflow's terminal REPORT, not
    // necessarily the terminal array entry.
    expect(nodes[nodes.length - 1].id).toBe("learning_recorder");
    expect(nodes.some((node) => node.id === "capture_report")).toBe(true);
  });
});

describe("publish_payload builds an object-scoped plan and names a quarantined object withheld", () => {
  beforeEach(() => { resetRepositoryManager(); });
  afterEach(() => { resetRepositoryManager(); });

  it("plans the valid object to publish and withholds the quarantined one, with a reason", async () => {
    await createTargetProject();
    const run = {
      projectId: TARGET,
      initialInput: {},
      stageOutputs: { capture_emit_live: liveEmissionEnvelope(), capture_score: fidelityEnvelope() }
    } as unknown as WorkflowExecutionRecord;
    const node = listCaptureConductorNodes().find((candidate) => candidate.id === "publish_payload")!;

    const outcome = await runCaptureStage({ run, node, stage: "publish_payload" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    expect(outcome.output.artifact).toBe("dry_run_publish_payload.v1");
    const clientObject = outcome.output.clientObject as { objectPublishPlan: ReturnType<typeof buildObjectPublishPlan> };
    const plan = clientObject.objectPublishPlan;
    expect(plan.publish).toEqual([{ objectId: "page_home", objectType: "page", phase: "postpatch" }]);
    expect(plan.withheld).toEqual([{ objectId: "page_new", objectType: "page", phase: "postcreate", reason: "quarantined_by_emission" }]);
    // The exact ban this module exists to enforce — the two verbs a build-side node must never reach.
    expect(plan.forbiddenVerbs).toContain("trigger_netlify_build");
    expect(plan.forbiddenVerbs).toContain("deploy");
  });

  it("refuses when the project's publishing is switched off (the per-project env kill-switch) — no plan is built at all", async () => {
    await createTargetProject();
    const config = await repositoryManager.getProjectRepository().get(TARGET);
    process.env[publishEnabledEnvVar(config!)] = "false";
    try {
      const run = {
        projectId: TARGET,
        initialInput: {},
        stageOutputs: { capture_emit_live: liveEmissionEnvelope(), capture_score: fidelityEnvelope() }
      } as unknown as WorkflowExecutionRecord;
      const node = listCaptureConductorNodes().find((candidate) => candidate.id === "publish_payload")!;

      const outcome = await runCaptureStage({ run, node, stage: "publish_payload" });
      expect(outcome).toMatchObject({ kind: "refused", code: "capture_publish_disabled" });
    } finally {
      delete process.env[publishEnabledEnvVar(config!)];
    }
  });
});

// T15.11 (2026-08-25, #190; ADR-2026-08-25-publish-autonomy §6.3) — the object-native emission report
// carries a theme AND a section_template alongside the page, so these tests exercise the widened
// capture_conductor charter through the SAME dispatch (captureConductorRoutes.ts's publish_payload
// stage) production actually uses, not just the pure buildObjectPublishPlan unit.
const emissionReportWithRecipeObjects = (): ObjectPublishSourceReport => ({
  target: TARGET,
  createdObjects: [
    { objectType: "page", objectId: "page_home", mode: "created" },
    { objectType: "theme", objectId: "theme_captured", mode: "created" },
    { objectType: "section_template", objectId: "tmpl_hero", mode: "created" },
    { objectType: "site", objectId: "site_zilberman", mode: "patched" }
  ],
  reusedObjects: [],
  quarantines: [],
  validationStates: [
    { phase: "postcreate", objectId: "page_home", valid: true, reason: null },
    { phase: "postcreate", objectId: "theme_captured", valid: true, reason: null },
    { phase: "postcreate", objectId: "tmpl_hero", valid: true, reason: null },
    { phase: "postpatch", objectId: "site_zilberman", valid: true, reason: null }
  ]
});

describe("T15.11 (#190) — publish_payload enforces the run's OWN snapshotted charter, never a live one", () => {
  beforeEach(() => { resetRepositoryManager(); });
  afterEach(() => { resetRepositoryManager(); });

  const runWith = (publishableTypes: readonly string[] | undefined, report: ObjectPublishSourceReport) =>
    ({
      projectId: TARGET,
      workflowId: "capture_conductor",
      initialInput: {},
      // The snapshot is what publish_payload reads (captureConductorRoutes.ts) — NEVER a live
      // resolvePublishableTypeCharter() call, which this module doesn't even import (see its own
      // header). Passing an explicit publishableTypes array here stands in for "whatever this run's
      // snapshot happened to capture at creation," so this fixture can assert the stage honors THAT,
      // independent of what the code-declared charter says today.
      publishingPolicySnapshot: { autonomyMode: "operator-gated" as const, publishEnabled: true, publishableTypes },
      stageOutputs: { capture_emit_live: { artifact: "capture_emission_run.v1", live: true, report }, capture_score: fidelityEnvelope() }
    }) as unknown as WorkflowExecutionRecord;

  it("capture_conductor's widened charter (T15.11) publishes theme, section_template, and the site singleton", async () => {
    await createTargetProject();
    const run = runWith(["page", "navigation", "theme", "site", "section_template"], emissionReportWithRecipeObjects());
    const node = listCaptureConductorNodes().find((candidate) => candidate.id === "publish_payload")!;

    const outcome = await runCaptureStage({ run, node, stage: "publish_payload" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    const clientObject = outcome.output.clientObject as { objectPublishPlan: ReturnType<typeof buildObjectPublishPlan> };
    const publishedIds = clientObject.objectPublishPlan.publish.map((entry) => entry.objectId).sort();
    expect(publishedIds).toEqual(["page_home", "site_zilberman", "theme_captured", "tmpl_hero"]);
    expect(clientObject.objectPublishPlan.withheld).toEqual([]);
  });

  it("a run whose snapshot predates T15.11 (publishableTypes absent) falls back to the legacy page/navigation-only default", async () => {
    await createTargetProject();
    const run = runWith(undefined, emissionReportWithRecipeObjects());
    const node = listCaptureConductorNodes().find((candidate) => candidate.id === "publish_payload")!;

    const outcome = await runCaptureStage({ run, node, stage: "publish_payload" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    const clientObject = outcome.output.clientObject as { objectPublishPlan: ReturnType<typeof buildObjectPublishPlan> };
    expect(clientObject.objectPublishPlan.publish.map((entry) => entry.objectId)).toEqual(["page_home"]);
    const withheldIds = clientObject.objectPublishPlan.withheld.map((entry) => entry.objectId).sort();
    expect(withheldIds).toEqual(["site_zilberman", "theme_captured", "tmpl_hero"]);
    for (const entry of clientObject.objectPublishPlan.withheld) expect(entry.reason).toBe("type_not_publishable");
  });

  // DETERMINISM (#200, ADR §2.5/§6.3 invariant 7): a run's publish plan is built from its OWN
  // snapshot, taken once at creation — never from whatever the code-declared charter says at the
  // moment publish_payload happens to dispatch. This run's snapshot is deliberately narrower than
  // capture_conductor's CURRENT (T15.11-widened) charter, standing in for a run created before a
  // charter widening landed; the assertion is that this in-flight run keeps behaving exactly as it
  // did when it was created, unaffected by the "later" (here: already-shipped) widening.
  it("a mid-run charter widening never reaches an in-flight run — only the run's own snapshot governs", async () => {
    await createTargetProject();
    const oldSnapshotTypes = ["page", "navigation"] as const; // capture's pre-T15.11 charter, frozen on this run
    const run = runWith(oldSnapshotTypes, emissionReportWithRecipeObjects());
    const node = listCaptureConductorNodes().find((candidate) => candidate.id === "publish_payload")!;

    // The CURRENT, live, widened charter really does include theme/site/section_template — proving
    // this is a genuine "old snapshot vs. new charter" divergence, not a vacuous comparison.
    const liveCharter = resolvePublishableTypeCharter("capture_conductor");
    expect(liveCharter.publishableTypes).toEqual(expect.arrayContaining(["theme", "site", "section_template"]));

    const outcome = await runCaptureStage({ run, node, stage: "publish_payload" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    const clientObject = outcome.output.clientObject as { objectPublishPlan: ReturnType<typeof buildObjectPublishPlan> };
    // The run's OWN (older, narrower) snapshot governed — not the live charter's wider set.
    expect(clientObject.objectPublishPlan.publish.map((entry) => entry.objectId)).toEqual(["page_home"]);
    expect(clientObject.objectPublishPlan.withheld.map((entry) => entry.objectId).sort()).toEqual(["site_zilberman", "theme_captured", "tmpl_hero"]);
  });

  it("publishing_conductor's own charter (if ever routed through this same plan builder) still excludes every recipe type", () => {
    // Structural proof independent of any run: publish_payload's enforcement point is
    // buildObjectPublishPlan, and publishing_conductor's charter — resolved the same way capture's
    // is, at run creation — never grants a recipe type. This is the mechanism ADR-2026-08-25-
    // structure-studio §2.2 names as one of the three enforcement points for "copy workflows never
    // author structure."
    const plan = buildObjectPublishPlan({
      report: emissionReportWithRecipeObjects(),
      target: TARGET,
      publishableTypes: resolvePublishableTypeCharter("publishing_conductor").publishableTypes,
      workflowId: "publishing_conductor"
    });
    expect(plan.publish.map((entry) => entry.objectId)).toEqual(["page_home"]);
    const themeWithheld = plan.withheld.find((entry) => entry.objectId === "theme_captured");
    expect(themeWithheld).toMatchObject({ reason: "type_not_publishable" });
    expect(themeWithheld?.detail).toContain("publishing_conductor is not chartered to publish object type \"theme\"");
  });
});

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("wired end to end through the shared tail's own publish-risk gate", () => {
  let calledVerbs: Array<{ verb: string; objectId?: string }>;

  // objectPublishExecution.ts's payloadOf reads result.structuredContent directly (one level, no
  // further "data" wrapper) — unlike the capture bridge's own transport, which wraps its answers one
  // level deeper. This mock answers the shape THIS module actually reads.
  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

  beforeEach(() => {
    resetRepositoryManager();
    calledVerbs = [];
    process.env.ZILBERMAN_PUBLISH_TAIL_MCP_ENDPOINT = TARGET_ENDPOINT;
  });

  afterEach(() => {
    delete process.env.ZILBERMAN_PUBLISH_TAIL_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const stubFetch = () =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (!String(url).startsWith(TARGET_ENDPOINT)) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push({ verb: name, objectId: typeof args.object_id === "string" ? args.object_id : undefined });
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}` });
      if (name === "object_publish") return respond(request.id, { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } });
      if (name === "object_checkin") return respond(request.id, { released: true });
      if (name === "release_to_production") return respond(request.id, { released: true, productionConfirmed: true, deployStatus: "ready", targetCommit: "deadbeef" });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

  // Enter the run late-stage, at publish_payload — the same trick every sibling publish-tail suite
  // uses (deterministicPublishExecutor.test.ts): the entry node's ancestors are seeded as skip
  // markers (they never re-run), and the entry node's OWN output is the exact plan capture's
  // publish_payload stage would have built from emissionReport() above.
  //
  // executionMode "openai" (a LIVE run, no provider configured) — deliberately, not "mock": the
  // shared tail's release_executor deterministic route (executor.ts) is scoped to LIVE runs only, and
  // this suite means to exercise it for real. gap_adjudicator (this workflow's one AI node that is
  // NOT an ancestor of publish_payload — a sibling branch off capture_score, so entrypoint seeding
  // never reaches it) is short-circuited by hand below rather than left to attempt a real model call
  // with no provider configured: it plays no part in what this suite asserts.
  const startAtPublishPayload = async (executionMode: "openai" | "mock" = "openai") => {
    const plan = buildObjectPublishPlan({ report: emissionReport(), target: TARGET });
    const store = repositoryManager.getExecutionRepository();
    const started = await startDryRun(
      {
        projectId: TARGET,
        workflowId: "capture_conductor",
        executionMode,
        input: { targetProjectId: TARGET },
        entrypoint: {
          nodeId: "publish_payload",
          output: {
            artifact: "dry_run_publish_payload.v1",
            summary: "fixture plan.",
            clientProjectId: TARGET,
            clientObjectType: "capture_emission_batch",
            contractSource: { source: "capture_conductor", targetProjectId: TARGET },
            dryRun: true,
            clientObject: { objectPublishPlan: plan },
            blockers: []
          }
        }
      },
      store
    );
    const run = (await getRun(started.runId, store))!;
    const adjudicator = run.nodes.find((node) => node.nodeId === "gap_adjudicator")!;
    const ts = new Date().toISOString();
    adjudicator.status = "completed";
    adjudicator.output = { artifact: "gap_adjudication.v1", summary: "fixture: no gaps adjudicated.", adjudications: [], humanSummary: "n/a (test fixture)" };
    adjudicator.startedAt = ts;
    adjudicator.completedAt = ts;
    adjudicator.durationMs = 0;
    run.stageOutputs.gap_adjudicator = adjudicator.output;
    await store.saveRun(run);
    return { runId: started.runId, store };
  };

  // Advance until the run halts or nothing is left runnable — bounded, not a fixed step count, since
  // gap_adjudicator (an AI node, mock-dispatched) and learning_recorder also share this run.
  const driveToHalt = async (runId: string, store: Awaited<ReturnType<typeof repositoryManager.getExecutionRepository>>) => {
    let run = (await getRun(runId, store))!;
    for (let i = 0; i < 20 && run.currentNodeId && !HALTED_EXECUTION_STATUSES.has(run.status); i++) {
      run = await runNextNode(runId, { executionRepository: store });
    }
    return run;
  };

  it("an autonomous project's run publishes the valid object, withholds the quarantined one, and reaches release — with no operator call at all", async () => {
    await createTargetProject("autonomous");
    stubFetch();
    const { runId, store } = await startAtPublishPayload();

    const run = await driveToHalt(runId, store);

    // No operator ever touched this run.
    expect(run.operatorPublishDecision).toBeUndefined();

    const publishExecution = run.stageOutputs.publish_executor as Record<string, unknown>;
    expect(publishExecution.artifact).toBe("publish_execution.v1");
    expect(publishExecution.publishCommitted).toBe(true);
    expect((publishExecution.objectPublish as { published: Array<{ objectId: string }> }).published.map((entry) => entry.objectId)).toEqual(["page_home"]);
    expect((publishExecution.objectPublish as { withheld: Array<{ objectId: string }> }).withheld.map((entry) => entry.objectId)).toEqual(["page_new"]);
    // publishAuthority names WHY this proceeded with no operator record: the project's own autonomy
    // policy, not a forged "an operator approved this".
    expect((publishExecution.publishAuthority as { source: string | null }).source).toBe("policy_autonomous");

    // The quarantined object never reached object_publish (or checkout/checkin) — only page_home did.
    const objectIdsTouched = new Set(calledVerbs.filter((entry) => entry.objectId).map((entry) => entry.objectId));
    expect(objectIdsTouched).toEqual(new Set(["page_home"]));
    expect(calledVerbs.filter((entry) => entry.verb === "object_publish")).toHaveLength(1);

    // release_executor reached a real release call — the ONE node authorized to (Board decision B2).
    expect(calledVerbs.some((entry) => entry.verb === "release_to_production")).toBe(true);
    const releaseExecution = run.stageOutputs.release_executor as Record<string, unknown> | undefined;
    expect(releaseExecution?.artifact).toBe("release_execution.v1");
    expect(releaseExecution?.status).toBe("executed");

    // The autonomous pass is still VISIBLE — ADR §5's advisory entry, not silence.
    const advisory = run.approvalsRequired.filter((entry) => entry.source === "policy_autonomous");
    expect(advisory.length).toBeGreaterThan(0);
    expect(advisory.every((entry) => entry.pending === undefined)).toBe(true);
  });

  it("an operator's withheld decision halts the run before publication_controller ever runs — no publish call, no release call", async () => {
    await createTargetProject("autonomous");
    stubFetch();
    const { runId, store } = await startAtPublishPayload();
    await setOperatorPublishDecision(runId, "withheld", store);

    const run = await driveToHalt(runId, store);

    expect(run.status).toBe("blocked");
    expect(run.stageOutputs.publish_executor).toBeUndefined();
    expect(run.stageOutputs.release_executor).toBeUndefined();
    expect(calledVerbs.filter((entry) => entry.verb === "object_publish" || entry.verb === "release_to_production")).toHaveLength(0);
    expect(run.approvalsRequired.some((entry) => entry.reason.includes("operator_withheld") || entry.reason.includes("withheld"))).toBe(true);
  });

  it("an operator-gated project with no decision halts the same way — autonomy is per-project, never assumed", async () => {
    await createTargetProject("operator-gated");
    stubFetch();
    const { runId, store } = await startAtPublishPayload();

    const run = await driveToHalt(runId, store);

    expect(run.status).toBe("blocked");
    expect(run.stageOutputs.publish_executor).toBeUndefined();
    expect(calledVerbs.filter((entry) => entry.verb === "object_publish" || entry.verb === "release_to_production")).toHaveLength(0);
  });
});
