import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { CLONE_ARTIFACTS } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import { resetClientMemoryStore } from "../../../src/agent/memory/clientMemoryBackend.js";
import { ClientMemoryStore } from "../../../src/agent/memory/clientMemoryStore.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T15.32 (#208; ADR-2026-08-25-structure-studio §5) — proves the studio's terminal-stage
// client-memory write end to end: a full run through publish_payload -> publish_executor -> report
// (clone_conductor's own deterministic stages, cloneConductorRoutes.ts), against the same
// direct-runCloneStage fixture style templateLibraryDepositWiring.test.ts (#207) uses, ends with the
// published section_template recorded in the TARGET tenant's own client memory — and proves the
// ADR §5.3 determinism-boundary caveat: the report stage's own output never carries the memory
// envelope's wall-clock `updatedAt`, and is byte-identical across two calls separated by real time.

const TARGET = "zilberman-client-memory-wiring";
const OTHER_TENANT = "some-other-tenant-never-touched";
const CAPTURE_RUN_ID = "run_capture_client_memory_fixture";
const SOURCE_URL = "https://zilberman.example/";
const TEMPLATE_ID = `${TARGET}::section_template::req_hero`;

const createTargetProject = async () => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: TARGET,
      name: "Client memory wiring fixture",
      mcpEndpointEnvVar: "ZILBERMAN_CLIENT_MEMORY_MCP_ENDPOINT",
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
  plan: { creates: [{ verb: "object_create", objectType: "section_template", requestedId: "req_hero", body: { name: "Hero", description: "", whenToUse: "", scope: "evergreen", blueprint: { type: "hero", data: { headline: "Welcome" } } } }] },
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

describe("clone_conductor's terminal report stage writes finished templates to the target tenant's client memory", () => {
  let calledVerbs: string[];

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

  const stubFetch = () =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (!String(url).startsWith(`https://${TARGET}.example/mcp`)) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push(name);
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}` });
      if (name === "object_publish") return respond(request.id, { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } });
      if (name === "object_checkin") return respond(request.id, { released: true });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

  const runThroughPublish = async (run: WorkflowExecutionRecord) => {
    const publishPayloadNode = listCloneConductorNodes().find((n) => n.id === "publish_payload")!;
    const payloadOutcome = await runCloneStage({ run, node: publishPayloadNode, stage: "publish_payload" });
    if (payloadOutcome.kind !== "completed") throw new Error(`publish_payload refused: ${JSON.stringify(payloadOutcome)}`);
    run.stageOutputs.publish_payload = payloadOutcome.output;

    const executorNode = listCloneConductorNodes().find((n) => n.id === "publish_executor")!;
    const executorOutcome = await runCloneStage({ run, node: executorNode, stage: "publish_executor" });
    if (executorOutcome.kind !== "completed") throw new Error(`publish_executor refused: ${JSON.stringify(executorOutcome)}`);
    run.stageOutputs.publish_executor = executorOutcome.output;
    return executorOutcome;
  };

  const runReport = async (run: WorkflowExecutionRecord) => {
    const reportNode = listCloneConductorNodes().find((n) => n.id === "clone_report")!;
    return runCloneStage({ run, node: reportNode, stage: "report" });
  };

  beforeEach(async () => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    resetClientMemoryStore();
    calledVerbs = [];
    process.env.ZILBERMAN_CLIENT_MEMORY_MCP_ENDPOINT = `https://${TARGET}.example/mcp`;
    await createTargetProject();
    await seedCaptureRun();
  });

  afterEach(() => {
    delete process.env.ZILBERMAN_CLIENT_MEMORY_MCP_ENDPOINT;
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    resetClientMemoryStore();
  });

  it("a published template appears in the owning tenant's memory and NOT in another tenant's memory", async () => {
    stubFetch();
    const run = fixtureRun();
    await runThroughPublish(run);
    const reportOutcome = await runReport(run);
    expect(reportOutcome.kind).toBe("completed");

    const owning = await new ClientMemoryStore().listTemplates(TARGET);
    expect(owning).toHaveLength(1);
    expect(owning[0].templateId).toBe(TEMPLATE_ID);
    expect(owning[0].version).toBe(1);
    expect(owning[0].instantiatedObjectId).toBe("tmpl_hero_1");

    const other = await new ClientMemoryStore().listTemplates(OTHER_TENANT);
    expect(other).toEqual([]);
  });

  it("the record carries full provenance (sourceUrl, captureRunId, engineHashes, standardsPack), read back from the library", async () => {
    stubFetch();
    const run = fixtureRun();
    await runThroughPublish(run);
    await runReport(run);

    const [recorded] = await new ClientMemoryStore().listTemplates(TARGET);
    expect(recorded.provenance.sourceUrl).toBe(SOURCE_URL);
    expect(recorded.provenance.captureRunId).toBe(CAPTURE_RUN_ID);
    expect(recorded.provenance.standardsPack).toBeTruthy();
    expect(Object.keys(recorded.provenance.engineHashes).length).toBeGreaterThan(0);
  });

  it("a reader (client_memory.list_templates' own backing store) can find the tenant's templates by projectId", async () => {
    stubFetch();
    const run = fixtureRun();
    await runThroughPublish(run);
    await runReport(run);

    // The exact call surface client_manager and copy workflows use (toolRegistry.ts's
    // client_memory.list_templates handler) — asserted directly against the store it wraps, since
    // that handler is a one-line pass-through with its own coverage in toolRegistry tests.
    const templates = await new ClientMemoryStore().listTemplates(TARGET);
    expect(templates.map((t) => t.templateId)).toContain(TEMPLATE_ID);
  });

  it("the write is deterministic and engine-authored: runCloneStage's report case takes no model/agent dependency and both writer inputs (library record, ledger objectId) are read back, never invented", async () => {
    // Structural proof: runCloneStage's signature accepts only {run, node, stage} — no model client,
    // no prompt, no agent handle exists for this call to have used. Two independent runs against
    // BYTE-IDENTICAL upstream stage output (recipe_mint, publish_executor) therefore deposit the
    // IDENTICAL library version (proven by templateLibraryDepositWiring.test.ts's own "re-run is
    // idempotent" case) and record the SAME templateId@version + provenance in memory here — nothing
    // a model could have varied run to run.
    stubFetch();
    const run = fixtureRun();
    await runThroughPublish(run);
    await runReport(run);
    const first = await new ClientMemoryStore().listTemplates(TARGET);

    const run2 = fixtureRun();
    await runThroughPublish(run2);
    await runReport(run2);
    const second = await new ClientMemoryStore().listTemplates(TARGET);

    expect(second).toEqual(first); // idempotent re-recording, not a duplicate or a drifted value
  });

  it("DETERMINISM BOUNDARY (ADR §5.3): a memory read/write never introduces a wall-clock value into the report stage's own run output", async () => {
    stubFetch();
    const run = fixtureRun();
    await runThroughPublish(run);

    const first = await runReport(run);
    await new Promise((resolve) => setTimeout(resolve, 5)); // let real wall-clock time actually pass
    const second = await runReport(run);

    expect(first.kind).toBe("completed");
    expect(second.kind).toBe("completed");
    // Byte-identical despite real time passing and a second memory write happening in between —
    // proves the memory envelope's own `updatedAt` (stamped fresh on every normalizeMemoryEnvelope
    // call, memoryEnvelope.ts) never entered this stage's returned output.
    expect(first).toEqual(second);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("updatedAt");
    // The client-memory summary this stage DOES surface is clock-free by construction: counts only.
    if (first.kind === "completed") {
      expect(first.output.clientMemory).toEqual({ attempted: true, recordedCount: 1, refused: 0 });
    }
  });
});
