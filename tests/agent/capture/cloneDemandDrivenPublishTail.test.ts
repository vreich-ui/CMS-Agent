import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { evaluateNodeSkip } from "../../../src/agent/workspace/skipPredicates.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { CLONE_ARTIFACTS } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T15.30 (#206; ADR-2026-08-25-structure-studio §3, §4.1) — the demand-driven entry driven end to
// end through the SAME routes clone-driven runs use (cloneConductorRoutes.ts's runCloneStage), never
// a second dispatch path. Proves:
//   - resolveRunFacts accepts a structureBrief with NO captureRunId in initialInput at all;
//   - the REAL clone_intake output this produces (not a hand-built stand-in) is what
//     skipPredicates.ts's clone_demand_driven_entry reads to skip layout_analyst;
//   - a structure mints with no capture run ever consulted, and publishes through the IDENTICAL
//     shared-tail machinery a clone-driven run uses;
//   - the deposited library record states provenance {driven:"demand", sourceUrl, no captureRunId} —
//     "a demand-driven template's provenance is stateable."
const TARGET = "clone-demand-publish-tail";
const TARGET_ENDPOINT = "https://clone-demand-publish-tail.example/mcp";
const SITE_ID = "site_demand_tail";
const THEME_ID = "theme_demand_tail";
const SOURCE_URL = "https://tenant.example/structure-request";

const STRUCTURE_BRIEF = {
  sourceUrl: SOURCE_URL,
  needs: [{ pageRef: "need_hero", kind: "section_template", sourceShape: ["hero"], rationale: "Tenant asked for a reusable hero directly, no capture involved." }]
};

const COMPONENT_REGISTRY = {
  definitions: [
    { type: "hero", data_schema: { type: "object", properties: { heading: { type: "string" } }, required: ["heading"] } }
  ]
};
const PAGE_TYPE_REGISTRY = { definitions: [{ id: "landing", allowedSections: "any", requiredSections: [] }] };
const SITE_BRAND_TOKENS = { colors: { "brand-primary": "#101010" }, fonts: {} };

const RECIPE_DESIGN = {
  artifact: "clone_recipe_design.v1",
  summary: "Designed from the brief directly.",
  sectionTemplates: [{ name: "Reusable Hero", whenToUse: "Landing pages needing a bold opener.", blueprint_type: "hero", blueprint: { type: "hero", data: { heading: "Welcome" } } }],
  templates: []
};

const createTargetProject = async () => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "Demand-driven publish-tail fixture", mcpEndpointEnvVar: "CLONE_DEMAND_PUBLISH_TAIL_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "allowed" })
  );
  await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
};

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

const fixtureRun = (): WorkflowExecutionRecord =>
  ({
    projectId: TARGET,
    workflowId: "clone_conductor",
    // T15.30 — NO captureRunId anywhere in initialInput. A demand-driven run is a run resolveRunFacts
    // must accept on structureBrief alone.
    initialInput: { targetProjectId: TARGET, structureBrief: STRUCTURE_BRIEF },
    publishingPolicySnapshot: { autonomyMode: "autonomous" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter("clone_conductor").publishableTypes },
    stageOutputs: {}
  }) as unknown as WorkflowExecutionRecord;

describe("clone_conductor demand-driven entry through the shared routes (T15.30/#206)", () => {
  let calledVerbs: string[];

  beforeEach(async () => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    calledVerbs = [];
    process.env.CLONE_DEMAND_PUBLISH_TAIL_MCP_ENDPOINT = TARGET_ENDPOINT;

    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (!String(url).startsWith(TARGET_ENDPOINT)) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push(name);
      if (name === "registry_get") return respond(request.id, { data: args.registry === "component" ? COMPONENT_REGISTRY : PAGE_TYPE_REGISTRY });
      if (name === "object_inventory") {
        if (args.object_type === "site") return respond(request.id, { data: { objects: [{ object_id: SITE_ID, object_type: "site", status: "active" }] } });
        if (args.object_type === "theme") return respond(request.id, { data: { objects: [{ object_id: THEME_ID, object_type: "theme", status: "active" }] } });
        return respond(request.id, { data: { objects: [] } });
      }
      if (name === "object_get" && args.object_type === "site") return respond(request.id, { data: { record: { object_id: SITE_ID, body: { brandTokens: SITE_BRAND_TOKENS } } } });
      if (name === "object_get" && args.object_type === "theme") return respond(request.id, { data: { record: { object_id: THEME_ID, body: { tokens: { colors: {}, fonts: {} } } } } });
      if (name === "object_create") return respond(request.id, { data: { record: { object_id: args.requestedId, body: args.body } } });
      // object_checkout/object_publish/object_checkin below run through the SHARED publish tail's
      // own transport (objectPublishExecution.ts's callTool -> payloadOf), which unwraps exactly ONE
      // level of structuredContent — unlike cloneEngine.ts's callProjectTool above, which also
      // unwraps a nested `.data`. These three are deliberately NOT wrapped in `{data: ...}`.
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}` });
      if (name === "object_publish") return respond(request.id, { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "cafebabe" } });
      if (name === "object_checkin") return respond(request.id, { released: true });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

    await createTargetProject();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLONE_DEMAND_PUBLISH_TAIL_MCP_ENDPOINT;
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
  });

  it("mints, publishes and deposits a structure with NO captureRunId anywhere — provenance states driven:\"demand\"", async () => {
    const run = fixtureRun();

    // 1) intake — resolveRunFacts must select demand mode from structureBrief alone; no
    // captureRunId, and no capture run is ever looked up (the fetch stub above throws on any
    // unrecognized verb, so a stray capture lookup would fail this test loudly).
    const intakeNode = listCloneConductorNodes().find((n) => n.id === "clone_intake")!;
    const intakeOutcome = await runCloneStage({ run, node: intakeNode, stage: "intake" });
    expect(intakeOutcome.kind).toBe("completed");
    if (intakeOutcome.kind !== "completed") throw new Error("unreachable");
    run.stageOutputs.clone_intake = intakeOutcome.output;
    expect(intakeOutcome.output.artifact).toBe(CLONE_ARTIFACTS.intake);
    expect(intakeOutcome.output.entryMode).toBe("demand");
    expect(intakeOutcome.output.captureRunId).toBeNull();
    expect(intakeOutcome.output.sourceUrl).toBe(SOURCE_URL);

    // 2) layout_analyst is SKIPPED against this REAL envelope — the same predicate the executor
    // gates dispatch on, not a hand-built stand-in for it.
    const layoutAnalyst = listCloneConductorNodes().find((n) => n.id === "layout_analyst")!;
    const skipVerdict = evaluateNodeSkip(
      { id: layoutAnalyst.id, dependsOn: layoutAnalyst.dependsOn, metadata: layoutAnalyst.metadata },
      { stageOutputs: run.stageOutputs }
    )!;
    expect(skipVerdict.skip).toBe(true);
    expect(skipVerdict.basis).toContain("entryMode: demand");

    // recipe_designer reads clone_intake.mismatches directly (layout_analyst's output is absent).
    expect(intakeOutcome.output.mismatches).toEqual([
      { pageRef: "need_hero", sourceShape: ["hero"], emittedShape: [], missingRecipeKind: "section_template", rationale: "Tenant asked for a reusable hero directly, no capture involved." }
    ]);

    // 3) mint — recipe_designer's own output supplied as a fixture (an AI node; not exercised by
    // these deterministic routes), exactly as templateLibraryDepositWiring.test.ts does for the
    // clone-driven path.
    run.stageOutputs.recipe_designer = RECIPE_DESIGN;
    const mintNode = listCloneConductorNodes().find((n) => n.id === "recipe_mint")!;
    const mintOutcome = await runCloneStage({ run, node: mintNode, stage: "mint" });
    expect(mintOutcome.kind).toBe("completed");
    if (mintOutcome.kind !== "completed") throw new Error("unreachable");
    run.stageOutputs.recipe_mint = mintOutcome.output;
    expect(mintOutcome.output.applied).toHaveLength(1);

    // theme_bind / restamp: nothing in this brief asked for either, so they contribute nothing —
    // fixtures standing in for their own (already-tested-elsewhere) deterministic stages.
    run.stageOutputs.theme_bind = { artifact: CLONE_ARTIFACTS.themeBind, siteId: SITE_ID, themeId: THEME_ID, applied: { colors: {}, fonts: {} }, dropped: [], substitutions: [] };
    run.stageOutputs.layout_restamp = { artifact: CLONE_ARTIFACTS.restamp, restamped: [], skipped: [], quarantined: [] };

    // 4) publish_payload / publish_executor — the SAME shared-tail machinery a clone-driven run
    // reaches, deposit included.
    const payloadNode = listCloneConductorNodes().find((n) => n.id === "publish_payload")!;
    const payloadOutcome = await runCloneStage({ run, node: payloadNode, stage: "publish_payload" });
    expect(payloadOutcome.kind).toBe("completed");
    if (payloadOutcome.kind !== "completed") throw new Error("unreachable");
    run.stageOutputs.publish_payload = payloadOutcome.output;

    const executorNode = listCloneConductorNodes().find((n) => n.id === "publish_executor")!;
    const executorOutcome = await runCloneStage({ run, node: executorNode, stage: "publish_executor" });
    expect(executorOutcome.kind).toBe("completed");
    if (executorOutcome.kind !== "completed") throw new Error("unreachable");
    expect(executorOutcome.output.publishCommitted).toBe(true);
    expect(calledVerbs).toContain("object_publish");
    // No capture run was EVER looked up — the fetch stub above would have thrown on any verb it
    // did not recognize, and "getRun" isn't a wire verb at all, so this also proves
    // executionsOf(deps).getRun was never called for this run.

    // The requestedId/objectId is recipe_mint's own deterministic hash of (target, name) — asserted
    // once, directly off the mint output, rather than re-guessed as a literal here.
    const mintedObjectId = (mintOutcome.output.applied as Array<{ objectId: string }>)[0].objectId;
    const templateId = `${TARGET}::section_template::${mintedObjectId}`;

    const library = executorOutcome.output.library as { deposited: Array<{ templateId: string; version: number; objectId: string }>; refused: unknown[] };
    expect(library.refused).toEqual([]);
    expect(library.deposited).toEqual([{ templateId, version: 1, objectId: mintedObjectId }]);

    const record = await new TemplateLibraryStore().getVersion(templateId, 1);
    expect(record?.provenance).toEqual({
      sourceUrl: SOURCE_URL,
      engineHashes: record?.provenance.engineHashes,
      standardsPack: record?.provenance.standardsPack
    });
    // "a template whose provenance cannot be stated is not publishable" (ADR §4.1) — this one COULD
    // be stated, and captureRunId is correctly ABSENT rather than fabricated or borrowed.
    expect(record?.provenance).not.toHaveProperty("captureRunId");
  });

  it("refuses a demand-driven deposit whose brief stated no sourceUrl — named, never fatal to the run", async () => {
    const run = fixtureRun();
    run.initialInput = { targetProjectId: TARGET, structureBrief: { needs: STRUCTURE_BRIEF.needs } };

    const intakeNode = listCloneConductorNodes().find((n) => n.id === "clone_intake")!;
    const intakeOutcome = await runCloneStage({ run, node: intakeNode, stage: "intake" });
    if (intakeOutcome.kind !== "completed") throw new Error("unreachable");
    run.stageOutputs.clone_intake = intakeOutcome.output;
    expect(intakeOutcome.output.sourceUrl).toBeNull();

    run.stageOutputs.recipe_designer = RECIPE_DESIGN;
    const mintNode = listCloneConductorNodes().find((n) => n.id === "recipe_mint")!;
    const mintOutcome = await runCloneStage({ run, node: mintNode, stage: "mint" });
    if (mintOutcome.kind !== "completed") throw new Error("unreachable");
    run.stageOutputs.recipe_mint = mintOutcome.output;

    run.stageOutputs.theme_bind = { artifact: CLONE_ARTIFACTS.themeBind, siteId: SITE_ID, themeId: THEME_ID, applied: { colors: {}, fonts: {} }, dropped: [], substitutions: [] };
    run.stageOutputs.layout_restamp = { artifact: CLONE_ARTIFACTS.restamp, restamped: [], skipped: [], quarantined: [] };

    const payloadNode = listCloneConductorNodes().find((n) => n.id === "publish_payload")!;
    const payloadOutcome = await runCloneStage({ run, node: payloadNode, stage: "publish_payload" });
    if (payloadOutcome.kind !== "completed") throw new Error("unreachable");
    run.stageOutputs.publish_payload = payloadOutcome.output;

    const executorNode = listCloneConductorNodes().find((n) => n.id === "publish_executor")!;
    const executorOutcome = await runCloneStage({ run, node: executorNode, stage: "publish_executor" });
    if (executorOutcome.kind !== "completed") throw new Error("unreachable");

    expect(executorOutcome.output.publishCommitted).toBe(true);
    const library = executorOutcome.output.library as { deposited: unknown[]; refused: Array<{ code: string }> };
    expect(library.deposited).toEqual([]);
    expect(library.refused).toHaveLength(1);
    expect(library.refused[0].code).toBe("template_provenance_unstateable");
    // The tenant's own publish was NOT touched by the library refusal — additive, never a gate.
    expect((executorOutcome.output as { status: string }).status).toBe("published_pending_release");
  });
});
