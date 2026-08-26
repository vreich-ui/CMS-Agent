import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { declaresWorkflowStageRoute, getRun, resolveConductorNodes, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { buildObjectPublishPlan, type ObjectPublishSourceReport } from "../../../src/agent/workspace/objectPublishExecution.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";

// T1 (2026-08-26) — THE REGRESSION THIS FILE EXISTS FOR, stated as the live evidence stated it.
//
// Two clone_conductor runs against project zilberman (run_1787748666186_ammpuv,
// run_1787748899372_lbvqdz) went 16/18 nodes green, passed every gate — approvalMatched:true,
// publishPolicyChecked:true, publication_controller "go" with 2 objects cleared — and then made ZERO
// client calls, blocking at publish_executor on `publish_request_id_absent` and
// `publish_sequence_error / no_valid_article_body`. For a workflow that composes the PUBLISH segment
// only, emits clientObjectType "clone_structure_batch", and has no article body by construction.
//
// WHY THE EXISTING SUITE WAS GREEN THROUGHOUT. clonePublishTail.test.ts drives this exact tail and
// passes — because it runs against the CANONICAL node definitions, where publish_executor carries no
// `publishExecutorDeterministic` flag at all (it is a STORE-ONLY flag; see
// scripts/reseedStoreFromCanonical.ts's header, which says so in as many words). Production sets that
// flag on the store row via --set-publish-executor-mode. overlayStoreNode then MERGES store metadata
// onto the canonical node BY ID — and clone shares the tail's node ids — so in production, and only in
// production, clone's publish_executor declared both its own `cloneStageDeterministic` route and the
// DTC `publishExecutorDeterministic: "execute"` one. The DTC route is evaluated first and is the one
// deterministic route in executor.ts with no fallback ("Every outcome therefore terminates here").
//
// So the store row is not incidental set-up here — it IS the reproduction. Every test below seeds it.
const TARGET = "zilberman-stage-route-precedence";

describe("declaresWorkflowStageRoute — a workflow-owned stage route, by declaration", () => {
  it("is true only for a non-empty string capture/clone stage declaration", () => {
    expect(declaresWorkflowStageRoute({ metadata: { cloneStageDeterministic: "publish_executor" } })).toBe(true);
    expect(declaresWorkflowStageRoute({ metadata: { captureStageDeterministic: "publish_executor" } })).toBe(true);
    expect(declaresWorkflowStageRoute({ metadata: undefined })).toBe(false);
    expect(declaresWorkflowStageRoute({ metadata: {} })).toBe(false);
    expect(declaresWorkflowStageRoute({ metadata: { cloneStageDeterministic: "  " } })).toBe(false);
    // The DTC flags are NOT stage routes — a node carrying only those keeps the DTC dispatch it asked
    // for. publishing_conductor's own publish_executor must be untouched by this predicate.
    expect(declaresWorkflowStageRoute({ metadata: { publishExecutorDeterministic: "execute" } })).toBe(false);
  });

  it("separates the composed workflows from publishing_conductor on the real node arrays", () => {
    const cloneExecutor = listCloneConductorNodes().find((node) => node.id === "publish_executor")!;
    const dtcExecutor = listWorkspaceNodes().find((node) => node.id === "publish_executor")!;
    expect(declaresWorkflowStageRoute(cloneExecutor)).toBe(true);
    expect(declaresWorkflowStageRoute(dtcExecutor)).toBe(false);
  });
});

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("a clone run reaches its own publish route even with the DTC store flag merged on top", () => {
  let calledVerbs: Array<{ verb: string; objectId?: string }>;

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

  beforeEach(() => {
    resetRepositoryManager();
    calledVerbs = [];
    process.env.ZILBERMAN_STAGE_ROUTE_MCP_ENDPOINT = "https://zilberman-stage-route.example/mcp";
  });

  afterEach(() => {
    delete process.env.ZILBERMAN_STAGE_ROUTE_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const createTargetProject = async () => {
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "Stage-route precedence fixture",
        mcpEndpointEnvVar: "ZILBERMAN_STAGE_ROUTE_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "allowed"
      })
    );
    await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
  };

  // THE REPRODUCTION. Exactly what `--set-publish-executor-mode execute` writes to the live store.
  const seedProductionStoreFlag = async () => {
    await repositoryManager.getWorkspaceRepository().updateNode("publish_executor", { metadata: { publishExecutorDeterministic: "execute" } }, { actor: "t1-test" });
  };

  const stubFetch = () =>
    ((globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (!String(url).startsWith("https://zilberman-stage-route.example/mcp")) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push({ verb: name, objectId: typeof args.object_id === "string" ? args.object_id : undefined });
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}` });
      if (name === "object_publish") return respond(request.id, { published: true, published_time: "2026-08-26T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } });
      if (name === "object_checkin") return respond(request.id, { released: true });
      if (name === "release_to_production") return respond(request.id, { released: true, productionConfirmed: true, deployStatus: "ready", targetCommit: "deadbeef" });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch);

  const changedReport = (): ObjectPublishSourceReport => ({
    target: TARGET,
    createdObjects: [{ objectType: "section_template", objectId: "tmpl_hero" }],
    reusedObjects: [],
    quarantines: [],
    validationStates: [{ phase: "postcreate", objectId: "tmpl_hero", valid: true, reason: null }]
  });

  // Nothing publishable: the run wrote nothing this pass. The acceptance criterion is about the REASON
  // it reports — anything but "no valid article body", a sentence that has no meaning for a structure
  // batch and told the operator nothing about their clone.
  const unchangedReport = (): ObjectPublishSourceReport => ({ target: TARGET, createdObjects: [], reusedObjects: [], quarantines: [], validationStates: [] });

  const startAtPublishPayload = async (report: ObjectPublishSourceReport) => {
    const plan = buildObjectPublishPlan({ report, target: TARGET, publishableTypes: resolvePublishableTypeCharter("clone_conductor").publishableTypes, workflowId: "clone_conductor" });
    const store = repositoryManager.getExecutionRepository();
    const started = await startDryRun(
      {
        projectId: TARGET,
        workflowId: "clone_conductor",
        executionMode: "openai",
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

  it("the store row really does merge both routes onto clone's publish_executor — the condition this fix is defined against", async () => {
    await createTargetProject();
    await seedProductionStoreFlag();
    const resolved = (await resolveConductorNodes(repositoryManager.getWorkspaceRepository(), "clone_conductor")).find((node) => node.id === "publish_executor")!;
    expect(resolved.metadata?.publishExecutorDeterministic).toBe("execute");
    expect(resolved.metadata?.cloneStageDeterministic).toBe("publish_executor");
    // ...and the workflow's own route is the one that wins.
    expect(declaresWorkflowStageRoute(resolved)).toBe(true);
  });

  it("a clone run with a changed publishable object publishes it and records a non-empty tool sequence", async () => {
    await createTargetProject();
    await seedProductionStoreFlag();
    stubFetch();
    const { runId, store } = await startAtPublishPayload(changedReport());

    const run = await driveToHalt(runId, store);

    const publishExecution = run.stageOutputs.publish_executor as Record<string, unknown> | undefined;
    expect(publishExecution).toBeDefined();
    expect(publishExecution!.artifact).toBe("publish_execution.v1");
    expect(publishExecution!.publishCommitted).toBe(true);
    expect(publishExecution!.clientObjectType).toBe("clone_structure_batch");

    // T1's acceptance criterion is phrased "a non-empty receipts.toolSequence" — the ARTICLE path's
    // field name. The object path's equivalent record of what actually ran, in order, is
    // objectPublish.trace, which is the same fact under the shape a multi-object structure batch needs.
    const objectPublish = publishExecution!.objectPublish as { published: Array<{ objectId: string }>; trace: Array<{ verb: string }> };
    expect(objectPublish.published.map((entry) => entry.objectId)).toEqual(["tmpl_hero"]);
    expect(objectPublish.trace.length).toBeGreaterThan(0);
    expect(objectPublish.trace.map((entry) => entry.verb)).toEqual(["object_checkout", "object_publish", "object_checkin"]);

    // The two failures the live runs actually died on, named so a regression re-reads as itself.
    expect(JSON.stringify(publishExecution)).not.toContain("no_valid_article_body");
    expect(JSON.stringify(publishExecution)).not.toContain("publish_request_id_absent");
    expect(calledVerbs.filter((entry) => entry.verb === "object_publish")).toHaveLength(1);
  });

  it("a clone run with nothing changed reports published:false for a reason that is not no_valid_article_body", async () => {
    await createTargetProject();
    await seedProductionStoreFlag();
    stubFetch();
    const { runId, store } = await startAtPublishPayload(unchangedReport());

    const run = await driveToHalt(runId, store);

    const publishExecution = run.stageOutputs.publish_executor as Record<string, unknown> | undefined;
    expect(publishExecution).toBeDefined();
    expect(publishExecution!.publishCommitted).toBe(false);
    expect(publishExecution!.status).toBe("skipped");
    const serialised = JSON.stringify(publishExecution);
    expect(serialised).not.toContain("no_valid_article_body");
    expect(serialised).not.toContain("publish_request_id_absent");
    // Nothing publishable means nothing touched — not a refusal, and not a client call either.
    expect(calledVerbs.filter((entry) => entry.verb === "object_publish")).toHaveLength(0);
  });
});
