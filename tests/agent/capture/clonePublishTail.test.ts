import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { readCloneStage, runCloneStage, CLONE_STAGES } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { publishingPublishSegmentIds } from "../../../src/agent/workspace/publishingTail.js";
import { buildObjectPublishPlan, type ObjectPublishSourceReport } from "../../../src/agent/workspace/objectPublishExecution.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { publishEnabledEnvVar } from "../../../src/agent/workspace/publisher.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T15.10 (ADR-2026-08-25-publish-autonomy §6, §9; ADR-2026-08-25-structure-studio §1) —
// clone_conductor no longer ends at a node named "terminal — human gate". It composes the shared
// publishing tail's PUBLISH segment (composeWorkflowNodes) exactly as capture_conductor (T15.7) and
// publishing_conductor do, and inherits that tail's OWN publish-risk safety machinery. These tests
// prove: (1) the composition is real — the same tail node ids, wired in; (2) publish_payload builds a
// plan from recipe_mint/theme_bind/layout_restamp that publishes a minted recipe and withholds a
// quarantined one AND a restamped page (clone is not chartered to publish pages — structure-studio
// ADR §2.1); (3) an autonomous project's run reaches release with no operator ever touching it; (4) an
// operator's "withheld" halts the run before any publish call, in every mode.

const TARGET = "zilberman-clone-publish-tail";

const createTargetProject = async (autonomyMode?: "autonomous" | "operator-gated") => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: TARGET,
      name: "Zilberman clone publish tail fixture",
      mcpEndpointEnvVar: "ZILBERMAN_CLONE_PUBLISH_TAIL_MCP_ENDPOINT",
      authMode: "none",
      defaultToolPolicy: "allowed"
    })
  );
  if (autonomyMode) {
    await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode }));
  }
};

describe("clone_conductor composes the shared publishing tail", () => {
  it("carries the SAME tail node ids publishing_conductor and capture_conductor use", () => {
    const nodes = listCloneConductorNodes();
    expect(CLONE_STAGES).toContain("publish_payload");
    expect(CLONE_STAGES).toContain("publication_controller");
    expect(CLONE_STAGES).toContain("publish_executor");

    for (const tailId of publishingPublishSegmentIds) {
      expect(nodes.some((node) => node.id === tailId)).toBe(true);
    }

    const controller = nodes.find((node) => node.id === "publication_controller")!;
    const executor = nodes.find((node) => node.id === "publish_executor")!;
    const releaser = nodes.find((node) => node.id === "release_executor")!;
    expect(controller.riskLevel).toBe("publish");
    expect(executor.riskLevel).toBe("publish");
    expect(releaser.riskLevel).toBe("publish");
    expect(executor.kind).toBe("publisher");
    expect(releaser.kind).toBe("releaser");

    // clone's own dispatch route, not the DTC one — composeWorkflowNodes hands back fresh
    // per-workflow copies, and cloneConductorNodes.ts retags exactly these three.
    expect(readCloneStage(controller)).toBe("publication_controller");
    expect(readCloneStage(executor)).toBe("publish_executor");
    expect(readCloneStage(releaser)).toBeUndefined();
    expect(releaser.metadata?.releaseExecutorDeterministic).toBe(true);

    // clone_report is still the terminal node, now reporting on what the TAIL did.
    const report = nodes.find((node) => node.id === "clone_report")!;
    expect(report.dependsOn).toContain("publish_executor");
    expect(report.dependsOn).toContain("release_executor");
    expect(nodes[nodes.length - 1].id).toBe("learning_recorder");

    // No node's NAME or output schema claims a human gate that does not exist.
    expect(report.name.toLowerCase()).not.toContain("human gate");
    expect((report.outputSchema as { properties: Record<string, unknown> }).properties.publication).toBeDefined();
    expect((report.outputSchema as { properties: Record<string, unknown> }).properties.humanGate).toBeUndefined();
  });
});

describe("publish_payload assembles the object-scoped plan from recipe_mint/theme_bind/layout_restamp", () => {
  beforeEach(() => { resetRepositoryManager(); });
  afterEach(() => { resetRepositoryManager(); });

  const intakeEnvelope = () => ({ artifact: "clone_intake.v1", target: TARGET, site: { objectId: "site_zilberman" }, theme: { objectId: "theme_captured" } });

  // One recipe minted cleanly (publishable), one whose draft verification failed (a quarantine-class
  // failure — never published even though it WAS created), and the theme/site the run bound tokens
  // onto. Matches the exact shape cloneMintStep/cloneThemeBindStep produce.
  const mintEnvelope = () => ({
    artifact: "clone_recipe_mint.v1",
    applied: [
      { objectType: "section_template", objectId: "tmpl_hero", requestedId: "req_hero", name: "Hero", draftVerified: true },
      { objectType: "template", objectId: "tmpl_landing_bad", requestedId: "req_landing", name: "Landing (unverified)", draftVerified: false }
    ],
    rejected: [],
    reused: [],
    substitutions: []
  });
  const themeBindEnvelope = () => ({
    artifact: "clone_theme_bind.v1",
    siteId: "site_zilberman",
    themeId: "theme_captured",
    applied: { colors: { primary: "rgb(1 2 3)" }, fonts: {} },
    dropped: [],
    substitutions: []
  });
  // A page restamped cleanly (a real write — but clone is not chartered to publish pages) and one the
  // restamp quarantined outright.
  const restampEnvelope = () => ({
    artifact: "clone_restamp.v1",
    restamped: [{ objectId: "page_home", ops: [] }],
    skipped: [],
    quarantined: [{ objectId: "page_broken", reason: "restamp_patch_failed", detail: "lock conflict" }]
  });

  const fixtureRun = () =>
    ({
      projectId: TARGET,
      workflowId: "clone_conductor",
      initialInput: { captureRunId: "run_capture_fixture" },
      // The run's OWN snapshot (never a live charter re-resolve — ADR §2.5/§6.3 invariant 7):
      // production stamps this at run creation from resolvePublishableTypeCharter(run.workflowId)
      // (executor.ts); this fixture stands in for that stamp.
      publishingPolicySnapshot: { autonomyMode: "operator-gated" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter("clone_conductor").publishableTypes },
      stageOutputs: { clone_intake: intakeEnvelope(), recipe_mint: mintEnvelope(), theme_bind: themeBindEnvelope(), layout_restamp: restampEnvelope() }
    }) as unknown as WorkflowExecutionRecord;

  it("publishes the valid recipe, the bound theme, and the site — withholds the unverified recipe, the quarantined page, and the merely-restamped page (not chartered)", async () => {
    await createTargetProject();
    const run = fixtureRun();
    const node = listCloneConductorNodes().find((candidate) => candidate.id === "publish_payload")!;

    const outcome = await runCloneStage({ run, node, stage: "publish_payload" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    expect(outcome.output.artifact).toBe("dry_run_publish_payload.v1");
    const clientObject = outcome.output.clientObject as { objectPublishPlan: ReturnType<typeof buildObjectPublishPlan> };
    const plan = clientObject.objectPublishPlan;

    const publishedIds = plan.publish.map((entry) => entry.objectId).sort();
    expect(publishedIds).toEqual(["site_zilberman", "theme_captured", "tmpl_hero"]);

    const withheldById = new Map(plan.withheld.map((entry) => [entry.objectId, entry]));
    // The recipe created but never verified as a clean draft: withheld, never published.
    expect(withheldById.get("tmpl_landing_bad")).toMatchObject({ reason: "validation_failed" });
    // The page the restamp itself quarantined.
    expect(withheldById.get("page_broken")).toMatchObject({ reason: "quarantined_by_emission" });
    // A page restamped WITHOUT error is still withheld — clone's charter has no "page" entry.
    const pageWithheld = withheldById.get("page_home")!;
    expect(pageWithheld.reason).toBe("type_not_publishable");
    expect(pageWithheld.detail).toContain("not chartered to publish object type \"page\"");

    expect(plan.forbiddenVerbs).toContain("trigger_netlify_build");
    expect(plan.forbiddenVerbs).toContain("deploy");
    expect(plan.forbiddenVerbs).toContain("release_to_production");
  });

  it("refuses when the project's publishing is switched off (the per-project env kill-switch) — no plan is built at all", async () => {
    await createTargetProject();
    const config = await repositoryManager.getProjectRepository().get(TARGET);
    process.env[publishEnabledEnvVar(config!)] = "false";
    try {
      const run = fixtureRun();
      const node = listCloneConductorNodes().find((candidate) => candidate.id === "publish_payload")!;
      const outcome = await runCloneStage({ run, node, stage: "publish_payload" });
      expect(outcome).toMatchObject({ kind: "refused", code: "clone_publish_disabled" });
    } finally {
      delete process.env[publishEnabledEnvVar(config!)];
    }
  });

  it("clone_conductor's charter (T15.11/#190, fixed to the real wire type \"template\") never grants \"page\"", () => {
    const charter = resolvePublishableTypeCharter("clone_conductor");
    expect([...charter.publishableTypes].sort()).toEqual(["section_template", "site", "template", "theme"]);
    expect(charter.publishableTypes).not.toContain("page");
  });
});

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("wired end to end through the shared tail's own publish-risk gate", () => {
  let calledVerbs: Array<{ verb: string; objectId?: string }>;

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

  beforeEach(() => {
    resetRepositoryManager();
    calledVerbs = [];
    process.env.ZILBERMAN_CLONE_PUBLISH_TAIL_MCP_ENDPOINT = "https://zilberman-clone-publish-tail.example/mcp";
  });

  afterEach(() => {
    delete process.env.ZILBERMAN_CLONE_PUBLISH_TAIL_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const stubFetch = () =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (!String(url).startsWith("https://zilberman-clone-publish-tail.example/mcp")) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push({ verb: name, objectId: typeof args.object_id === "string" ? args.object_id : undefined });
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}` });
      if (name === "object_publish") return respond(request.id, { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } });
      if (name === "object_checkin") return respond(request.id, { released: true });
      if (name === "release_to_production") return respond(request.id, { released: true, productionConfirmed: true, deployStatus: "ready", targetCommit: "deadbeef" });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

  const cloneReport = (): ObjectPublishSourceReport => ({
    target: TARGET,
    createdObjects: [{ objectType: "section_template", objectId: "tmpl_hero" }],
    reusedObjects: [],
    quarantines: [{ objectId: "tmpl_broken", reason: "clone_mint_draft_verification_failed" }],
    validationStates: [
      { phase: "postcreate", objectId: "tmpl_hero", valid: true, reason: null },
      { phase: "postcreate", objectId: "tmpl_broken", valid: true, reason: null }
    ]
  });

  // Enter the run late-stage, at publish_payload — every upstream node (clone_intake through
  // layout_restamp/fit_adjudicator) is auto-seeded as skipped by the executor's own late-stage entry
  // machinery, since ALL of them are ancestors of publish_payload in clone's graph (unlike capture's
  // gap_adjudicator, clone has no AI node that sits OUTSIDE publish_payload's ancestor set).
  const startAtPublishPayload = async (executionMode: "openai" | "mock" = "openai") => {
    const plan = buildObjectPublishPlan({ report: cloneReport(), target: TARGET, publishableTypes: resolvePublishableTypeCharter("clone_conductor").publishableTypes, workflowId: "clone_conductor" });
    const store = repositoryManager.getExecutionRepository();
    const started = await startDryRun(
      {
        projectId: TARGET,
        workflowId: "clone_conductor",
        executionMode,
        input: { targetProjectId: TARGET, captureRunId: "run_capture_fixture" },
        entrypoint: {
          nodeId: "publish_payload",
          output: {
            artifact: "dry_run_publish_payload.v1",
            summary: "fixture plan.",
            clientProjectId: TARGET,
            clientObjectType: "clone_structure_batch",
            contractSource: { source: "clone_conductor", targetProjectId: TARGET },
            dryRun: true,
            clientObject: { objectPublishPlan: plan },
            blockers: []
          }
        }
      },
      store
    );
    return { runId: started.runId, store };
  };

  const driveToHalt = async (runId: string, store: Awaited<ReturnType<typeof repositoryManager.getExecutionRepository>>) => {
    let run = (await getRun(runId, store))!;
    for (let i = 0; i < 20 && run.currentNodeId && !HALTED_EXECUTION_STATUSES.has(run.status); i++) {
      run = await runNextNode(runId, { executionRepository: store });
    }
    return run;
  };

  it("an autonomous project's run publishes the valid recipe, withholds the quarantined one, and reaches release — with no operator call at all", async () => {
    await createTargetProject("autonomous");
    stubFetch();
    const { runId, store } = await startAtPublishPayload();

    const run = await driveToHalt(runId, store);

    expect(run.operatorPublishDecision).toBeUndefined();

    const publishExecution = run.stageOutputs.publish_executor as Record<string, unknown>;
    expect(publishExecution.artifact).toBe("publish_execution.v1");
    expect(publishExecution.publishCommitted).toBe(true);
    expect((publishExecution.objectPublish as { published: Array<{ objectId: string }> }).published.map((entry) => entry.objectId)).toEqual(["tmpl_hero"]);
    expect((publishExecution.objectPublish as { withheld: Array<{ objectId: string }> }).withheld.map((entry) => entry.objectId)).toEqual(["tmpl_broken"]);
    expect((publishExecution.publishAuthority as { source: string | null }).source).toBe("policy_autonomous");

    const objectIdsTouched = new Set(calledVerbs.filter((entry) => entry.objectId).map((entry) => entry.objectId));
    expect(objectIdsTouched).toEqual(new Set(["tmpl_hero"]));
    expect(calledVerbs.filter((entry) => entry.verb === "object_publish")).toHaveLength(1);

    expect(calledVerbs.some((entry) => entry.verb === "release_to_production")).toBe(true);
    const releaseExecution = run.stageOutputs.release_executor as Record<string, unknown> | undefined;
    expect(releaseExecution?.artifact).toBe("release_execution.v1");
    expect(releaseExecution?.status).toBe("executed");

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
