import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { buildCloneReportStep, CLONE_ARTIFACTS } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — proves the wiring end to end: clone_conductor's
// OWN deterministic publish_executor stage (cloneConductorRoutes.ts), running against a fixture run
// (the same direct-runCloneStage style clonePublishTail.test.ts's "publish_payload assembles..."
// block uses), deposits a section_template that actually PUBLISHED into the cross-tenant library, and
// clone_report surfaces the deposit ledger read back verbatim.

const TARGET = "zilberman-library-deposit-wiring";
const CAPTURE_RUN_ID = "run_capture_library_deposit_fixture";
const SOURCE_URL = "https://zilberman.example/";

const createTargetProject = async () => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: TARGET,
      name: "Library deposit wiring fixture",
      mcpEndpointEnvVar: "ZILBERMAN_LIBRARY_DEPOSIT_MCP_ENDPOINT",
      authMode: "none",
      defaultToolPolicy: "allowed"
    })
  );
  await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
};

const seedCaptureRun = async () => {
  await repositoryManager.getExecutionRepository().createRun({
    runId: CAPTURE_RUN_ID,
    projectId: TARGET,
    workflowId: "capture_conductor",
    stageOutputs: { capture_crawl: { sourceUrl: SOURCE_URL, snapshot: { schemaVersion: "capture-snapshot.v1", pages: [] } } }
  } as unknown as WorkflowExecutionRecord);
};

const intakeEnvelope = () => ({ artifact: CLONE_ARTIFACTS.intake, target: TARGET, site: { objectId: "site_zilberman" }, theme: { objectId: "theme_captured" } });

const mintEnvelope = () => ({
  artifact: CLONE_ARTIFACTS.mint,
  plan: {
    creates: [
      { verb: "object_create", objectType: "section_template", requestedId: "req_hero", body: { name: "Hero", description: "", whenToUse: "", scope: "evergreen", blueprint: { type: "hero", data: { headline: "Welcome" } } } }
    ]
  },
  applied: [{ objectType: "section_template", objectId: "tmpl_hero_1", requestedId: "req_hero", name: "Hero", draftVerified: true }],
  rejected: [],
  reused: [],
  substitutions: []
});
const themeBindEnvelope = () => ({ artifact: CLONE_ARTIFACTS.themeBind, siteId: "site_zilberman", themeId: "theme_captured", applied: { colors: {}, fonts: {} }, dropped: [], substitutions: [] });
const restampEnvelope = () => ({ artifact: CLONE_ARTIFACTS.restamp, restamped: [], skipped: [], quarantined: [] });

const fixtureRun = (): WorkflowExecutionRecord =>
  ({
    projectId: TARGET,
    workflowId: "clone_conductor",
    initialInput: { targetProjectId: TARGET, captureRunId: CAPTURE_RUN_ID },
    publishingPolicySnapshot: { autonomyMode: "autonomous" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter("clone_conductor").publishableTypes },
    stageOutputs: { clone_intake: intakeEnvelope(), recipe_mint: mintEnvelope(), theme_bind: themeBindEnvelope(), layout_restamp: restampEnvelope() }
  }) as unknown as WorkflowExecutionRecord;

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("clone_conductor's publish_executor deposits a published recipe into the cross-tenant library", () => {
  let calledVerbs: string[];

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

  const stubFetch = () =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (!String(url).startsWith("https://zilberman-library-deposit-wiring.example/mcp")) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push(name);
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}` });
      if (name === "object_publish") return respond(request.id, { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } });
      if (name === "object_checkin") return respond(request.id, { released: true });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

  beforeEach(async () => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    calledVerbs = [];
    process.env.ZILBERMAN_LIBRARY_DEPOSIT_MCP_ENDPOINT = "https://zilberman-library-deposit-wiring.example/mcp";
    await createTargetProject();
    await seedCaptureRun();
  });

  afterEach(() => {
    delete process.env.ZILBERMAN_LIBRARY_DEPOSIT_MCP_ENDPOINT;
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
  });

  it("deposits the published section_template and surfaces it on publish_execution.v1's `library` field", async () => {
    stubFetch();
    const run = fixtureRun();
    const publishPayloadNode = listCloneConductorNodes().find((n) => n.id === "publish_payload")!;
    const payloadOutcome = await runCloneStage({ run, node: publishPayloadNode, stage: "publish_payload" });
    expect(payloadOutcome.kind).toBe("completed");
    if (payloadOutcome.kind !== "completed") throw new Error("unreachable");
    run.stageOutputs.publish_payload = payloadOutcome.output;

    const executorNode = listCloneConductorNodes().find((n) => n.id === "publish_executor")!;
    const executorOutcome = await runCloneStage({ run, node: executorNode, stage: "publish_executor" });
    expect(executorOutcome.kind).toBe("completed");
    if (executorOutcome.kind !== "completed") throw new Error("unreachable");

    expect(executorOutcome.output.publishCommitted).toBe(true);
    expect(calledVerbs).toContain("object_publish");

    const library = executorOutcome.output.library as { deposited: Array<{ templateId: string; version: number }>; unchanged: unknown[]; refused: unknown[] };
    expect(library.deposited).toEqual([{ templateId: "zilberman-library-deposit-wiring::section_template::req_hero", version: 1, objectId: "tmpl_hero_1" }]);
    expect(library.unchanged).toEqual([]);
    expect(library.refused).toEqual([]);

    const record = await new TemplateLibraryStore().getVersion("zilberman-library-deposit-wiring::section_template::req_hero", 1);
    expect(record?.provenance.sourceUrl).toBe(SOURCE_URL);
    expect(record?.provenance.captureRunId).toBe(CAPTURE_RUN_ID);
    expect(record?.recipe).toEqual(mintEnvelope().plan.creates[0].body);

    // clone_report reads the ledger back verbatim, never re-deriving it.
    const report = buildCloneReportStep({
      intake: intakeEnvelope() as never,
      mint: mintEnvelope() as never,
      themeBind: themeBindEnvelope() as never,
      restamp: restampEnvelope() as never,
      publishExecution: executorOutcome.output
    });
    expect(report.library).toEqual(library);
  });

  it("running the SAME deposit twice (a re-run against unchanged content) leaves version 1 as the only version — idempotent, not a second mint", async () => {
    stubFetch();

    const runOnce = async () => {
      const run = fixtureRun();
      const publishPayloadNode = listCloneConductorNodes().find((n) => n.id === "publish_payload")!;
      const payloadOutcome = await runCloneStage({ run, node: publishPayloadNode, stage: "publish_payload" });
      if (payloadOutcome.kind !== "completed") throw new Error("unreachable");
      run.stageOutputs.publish_payload = payloadOutcome.output;
      const executorNode = listCloneConductorNodes().find((n) => n.id === "publish_executor")!;
      const executorOutcome = await runCloneStage({ run, node: executorNode, stage: "publish_executor" });
      if (executorOutcome.kind !== "completed") throw new Error("unreachable");
      return executorOutcome.output.library as { deposited: unknown[]; unchanged: unknown[] };
    };

    const first = await runOnce();
    expect(first.deposited).toHaveLength(1);
    expect(first.unchanged).toHaveLength(0);

    const second = await runOnce();
    expect(second.deposited).toHaveLength(0);
    expect(second.unchanged).toHaveLength(1);

    const all = await new TemplateLibraryStore().list({ templateId: "zilberman-library-deposit-wiring::section_template::req_hero" });
    expect(all.map((r) => r.version)).toEqual([1]);
  });
});
