import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRun,
  runNextNode,
  setOperatorPublishDecision,
  startDryRun
} from "../../../src/agent/workspace/executor.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import {
  pdfTemplateIntakeStep,
  pdfTemplateMintStep,
  pdfTemplatePublishStep,
  depositPublishedPdfTemplatesStep,
  PDF_TEMPLATE_ARTIFACTS
} from "../../../src/agent/capture/pdfTemplateEngine.js";
import { CLONE_ARTIFACTS } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import { resetClientMemoryStore } from "../../../src/agent/memory/clientMemoryBackend.js";
import { ClientMemoryStore } from "../../../src/agent/memory/clientMemoryStore.js";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T15.34 (#210; ADR-2026-08-25-structure-studio §7) — the PDF-template workspace.
//
// Covers the acceptance criteria named in the issue and the ADR:
//   1. a designed template is validated before publication (design -> validate -> publish, reject-
//      never-coerce);
//   2. an invalid template is withheld and NAMED with its reason;
//   3. a published pdf_template reaches client memory with objectType "pdf_template";
//   4. an operator `withheld` halts pdf_template_publish;
//   5. an autonomous tenant needs no human.
//
// Mirrors the existing suite's own patterns exactly: clonePublishTail.test.ts's fetch-stub +
// startDryRun(entrypoint) shape for (4)/(5), clientMemoryWriteWiring.test.ts's direct-runCloneStage
// fixture shape for (3), and templateLibraryDepositWiring.test.ts's shape for the library deposit.

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const TARGET = "zilberman-pdf-template-workspace";
const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

const createTargetProject = async (autonomyMode?: "autonomous" | "operator-gated") => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: TARGET,
      name: "PDF-template workspace fixture",
      mcpEndpointEnvVar: "ZILBERMAN_PDF_TEMPLATE_MCP_ENDPOINT",
      authMode: "none",
      defaultToolPolicy: "allowed"
    })
  );
  if (autonomyMode) {
    await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode }));
  }
};

// ===================================================================================================
// UNIT LEVEL — pdfTemplateEngine.ts's own stages, directly.
// ===================================================================================================
describe("pdfTemplateIntakeStep — brief normalization", () => {
  it("normalizes a well-formed brief into a validated entry list", () => {
    const envelope = pdfTemplateIntakeStep({
      initialInput: { targetProjectId: TARGET, pdfTemplateBrief: { siteId: "site_x", entries: [{ name: "Routine Brochure", renderer: "chromium" }] } }
    });
    expect(envelope.artifact).toBe(PDF_TEMPLATE_ARTIFACTS.intake);
    expect(envelope.siteId).toBe("site_x");
    expect(envelope.entries).toHaveLength(1);
    expect(envelope.entries[0].requestedId).toBe("pdf-routine-brochure");
    expect(envelope.rejectedEntries).toEqual([]);
  });

  it("names zero entries (never a refusal) when no pdfTemplateBrief is present — the common case for a structure-only studio run", () => {
    const envelope = pdfTemplateIntakeStep({ initialInput: { targetProjectId: TARGET, captureRunId: "run_1" } });
    expect(envelope.entries).toEqual([]);
    expect(envelope.siteId).toBeNull();
  });

  it("rejects — by name, not silently — an entry with no name, and a brief with no siteId", () => {
    const envelope = pdfTemplateIntakeStep({
      initialInput: { pdfTemplateBrief: { entries: [{ renderer: "pdfme" }] } } // no siteId at all, entry has no name
    });
    expect(envelope.entries).toEqual([]);
    const reasons = envelope.rejectedEntries.map((entry) => entry.reason);
    expect(reasons.some((reason) => reason.includes("siteId"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("name"))).toBe(true);
  });
});

describe("pdfTemplateMintStep — design -> validate -> publish discipline, reject-never-coerce", () => {
  beforeEach(() => {
    resetRepositoryManager();
    process.env.ZILBERMAN_PDF_TEMPLATE_MCP_ENDPOINT = `https://${TARGET}.example/mcp`;
  });
  afterEach(() => {
    delete process.env.ZILBERMAN_PDF_TEMPLATE_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const intake = () =>
    pdfTemplateIntakeStep({
      initialInput: {
        pdfTemplateBrief: {
          siteId: "site_zilberman",
          entries: [
            { name: "Sales Brochure", renderer: "chromium" },
            { name: "Simple Form", renderer: "pdfme" },
            { name: "Broken Design", renderer: "chromium" }
          ]
        }
      }
    });

  const stubFetch = (calls: { verb: string; args: Record<string, unknown> }[]) =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      calls.push({ verb: name, args });
      if (name === "create_pdf_template") {
        const isValidatedRenderer = args.renderer !== "pdfme";
        return respond(request.id, { templateId: `tpl_${String(args.template_json && (args.template_json as Record<string, unknown>).__kind === "broken" ? "broken" : "ok")}_${calls.length}`, version: 1, status: isValidatedRenderer ? "draft" : "active" });
      }
      if (name === "validate_pdf_template") return respond(request.id, { validationId: `val_${calls.length}`, status: "pending" });
      if (name === "get_pdf_template_validation") {
        const templateId = String(args.template_id);
        const status = templateId.includes("broken") ? "FAILED" : "PASSED";
        return respond(request.id, { status, errors: status === "FAILED" ? ["chromium: unresolved {{missingField}}"] : [] });
      }
      throw new Error(`Unexpected pdf-tool verb: ${name}`);
    }) as unknown as typeof fetch;

  it("mints a pdfme template with no validation call at all (create-then-publish, warn-only)", async () => {
    const calls: { verb: string; args: Record<string, unknown> }[] = [];
    stubFetch(calls);
    await createTargetProject();
    const design = { designs: [{ requestedId: "pdf-simple-form", templateJson: { schemas: [{ title: { type: "text" } }] } }] };
    const result = await pdfTemplateMintStep({ targetProjectId: TARGET, intake: intake(), design }, { sleepImpl: async () => {} });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].validated).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(calls.map((c) => c.verb)).toEqual(["create_pdf_template"]); // no validate/poll for pdfme
  });

  it("mints a chromium template only after validate_pdf_template -> get_pdf_template_validation reaches PASSED", async () => {
    const calls: { verb: string; args: Record<string, unknown> }[] = [];
    stubFetch(calls);
    await createTargetProject();
    const design = {
      designs: [{ requestedId: "pdf-sales-brochure", templateJson: { html: "<div>{{title}}</div>", css: "" }, sampleData: { title: "Longest Possible Title Goes Here" } }]
    };
    const result = await pdfTemplateMintStep({ targetProjectId: TARGET, intake: intake(), design }, { sleepImpl: async () => {} });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].validated).toBe(true);
    expect(calls.map((c) => c.verb)).toEqual(["create_pdf_template", "validate_pdf_template", "get_pdf_template_validation"]);
  });

  it("withholds — NAMED with pdf-tool's own reason — a design whose validation report comes back FAILED", async () => {
    const calls: { verb: string; args: Record<string, unknown> }[] = [];
    stubFetch(calls);
    await createTargetProject();
    const design = {
      designs: [{ requestedId: "pdf-broken-design", templateJson: { html: "<div>{{missingField}}</div>", css: "", __kind: "broken" }, sampleData: { x: "y" } }]
    };
    const result = await pdfTemplateMintStep({ targetProjectId: TARGET, intake: intake(), design }, { sleepImpl: async () => {} });
    expect(result.applied).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("pdf_template_validation_failed");
    expect(result.rejected[0].reason).toContain("FAILED");
    expect(result.rejected[0].reason).toContain("unresolved {{missingField}}");
  });

  it("withholds — NAMED, never coerced — a design with no usable templateJson, an invalid renderer, and a non-pdfme renderer with no sample data", async () => {
    await createTargetProject();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("no wire call should ever be attempted for a design rejected before create_pdf_template");
    }) as unknown as typeof fetch;
    const design = {
      designs: [
        { requestedId: "pdf-sales-brochure", templateJson: {} }, // empty object: no usable content
        { requestedId: "pdf-simple-form" } // renderer defaults to pdfme via intake, but no templateJson at all either — still content_missing first
      ]
    };
    const result = await pdfTemplateMintStep({ targetProjectId: TARGET, intake: intake(), design }, { sleepImpl: async () => {} });
    expect(result.applied).toEqual([]);
    expect(result.rejected.map((r) => r.code)).toEqual(["pdf_template_content_missing", "pdf_template_content_missing"]);
  });

  it("withholds a non-pdfme design with no sample data, named pdf_template_sample_data_missing", async () => {
    await createTargetProject();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("no wire call should ever be attempted");
    }) as unknown as typeof fetch;
    const design = { designs: [{ requestedId: "pdf-sales-brochure", templateJson: { html: "<div/>", css: "" } }] }; // chromium (from intake), no sampleData
    const result = await pdfTemplateMintStep({ targetProjectId: TARGET, intake: intake(), design }, { sleepImpl: async () => {} });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("pdf_template_sample_data_missing");
  });
});

describe("depositPublishedPdfTemplatesStep — the cross-tenant library deposit under objectType pdf_template", () => {
  beforeEach(() => resetTemplateLibraryMemoryStore());
  afterEach(() => resetTemplateLibraryMemoryStore());

  it("deposits a published entry with a stated sourceUrl into the library as objectType pdf_template", async () => {
    const mint = {
      artifact: PDF_TEMPLATE_ARTIFACTS.mint,
      siteId: "site_x",
      applied: [{ requestedId: "pdf-sales-brochure", name: "Sales Brochure", renderer: "chromium", templateId: "tpl_1", version: 1, validated: true, templateJson: { html: "<div/>", css: "" }, sourceUrl: "https://zilberman.example/brochure", tags: [] }],
      rejected: []
    };
    const published = [{ requestedId: "pdf-sales-brochure", name: "Sales Brochure", templateId: "tpl_1", version: 1 }];
    const ledger = await depositPublishedPdfTemplatesStep({ sourceProjectId: TARGET, mint, published });
    expect(ledger.deposited).toHaveLength(1);
    expect(ledger.refused).toEqual([]);

    const record = await new TemplateLibraryStore().getVersion(ledger.deposited[0].templateId, 1);
    expect(record?.objectType).toBe("pdf_template");
    expect(record?.sectionTypesUsed).toEqual([]); // a pdf_template depends on no CMS section type
    expect(record?.provenance.sourceUrl).toBe("https://zilberman.example/brochure");
    expect(record?.provenance.captureRunId).toBeUndefined(); // always demand-driven — see the module's own header
  });

  it("refuses — NAMED, never a placeholder URL — a published entry whose brief stated no sourceUrl", async () => {
    const mint = {
      artifact: PDF_TEMPLATE_ARTIFACTS.mint,
      siteId: "site_x",
      applied: [{ requestedId: "pdf-no-source", name: "No Source", renderer: "pdfme", templateId: "tpl_2", version: 1, validated: true, templateJson: { schemas: [] }, tags: [] }],
      rejected: []
    };
    const published = [{ requestedId: "pdf-no-source", name: "No Source", templateId: "tpl_2", version: 1 }];
    const ledger = await depositPublishedPdfTemplatesStep({ sourceProjectId: TARGET, mint, published });
    expect(ledger.deposited).toEqual([]);
    expect(ledger.refused).toHaveLength(1);
    expect(ledger.refused[0].code).toBe("template_provenance_unstateable");
    expect(ledger.refused[0].reason).toContain("sourceUrl");
  });
});

// ===================================================================================================
// WIRING LEVEL — the studio's terminal report/memory write, alongside a structure-template deposit,
// through runCloneStage directly (clientMemoryWriteWiring.test.ts's own pattern).
// ===================================================================================================
describe("the studio's terminal report writes a published pdf_template to client memory, alongside CMS structure", () => {
  const CAPTURE_RUN_ID = "run_capture_pdf_fixture";
  const SOURCE_URL = "https://zilberman.example/";

  const intakeEnvelope = () => ({ artifact: CLONE_ARTIFACTS.intake, target: TARGET, site: { objectId: "site_zilberman" }, theme: { objectId: "theme_captured" } });
  const mintEnvelope = () => ({ artifact: CLONE_ARTIFACTS.mint, plan: { creates: [] }, applied: [], rejected: [], reused: [], substitutions: [] });
  const themeBindEnvelope = () => ({ artifact: CLONE_ARTIFACTS.themeBind, siteId: "site_zilberman", themeId: "theme_captured", applied: { colors: {}, fonts: {} }, dropped: [], substitutions: [] });
  const restampEnvelope = () => ({ artifact: CLONE_ARTIFACTS.restamp, restamped: [], skipped: [], quarantined: [] });

  const pdfIntakeEnvelope = () => ({ artifact: PDF_TEMPLATE_ARTIFACTS.intake, siteId: "site_zilberman", entries: [{ requestedId: "pdf-routine", name: "Routine Card", renderer: "pdfme", tags: [], sourceUrl: SOURCE_URL }], rejectedEntries: [] });
  const pdfMintEnvelope = () => ({
    artifact: PDF_TEMPLATE_ARTIFACTS.mint,
    siteId: "site_zilberman",
    applied: [{ requestedId: "pdf-routine", name: "Routine Card", renderer: "pdfme", templateId: "tpl_routine_1", version: 1, validated: true, templateJson: { schemas: [{ title: { type: "text" } }] }, sourceUrl: SOURCE_URL, tags: [] }],
    rejected: []
  });
  const pdfPublishEnvelope = () => ({
    artifact: PDF_TEMPLATE_ARTIFACTS.publish,
    published: [{ requestedId: "pdf-routine", name: "Routine Card", templateId: "tpl_routine_1", version: 1 }],
    failed: [],
    library: { deposited: [{ templateId: `${TARGET}::pdf_template::pdf-routine`, version: 1, objectId: "tpl_routine_1" }], unchanged: [], refused: [] }
  });

  const fixtureRun = (): WorkflowExecutionRecord =>
    ({
      projectId: TARGET,
      workflowId: "clone_conductor",
      initialInput: { targetProjectId: TARGET, captureRunId: CAPTURE_RUN_ID },
      publishingPolicySnapshot: { autonomyMode: "autonomous" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter("clone_conductor").publishableTypes },
      stageOutputs: {
        clone_intake: intakeEnvelope(),
        recipe_mint: mintEnvelope(),
        theme_bind: themeBindEnvelope(),
        layout_restamp: restampEnvelope(),
        pdf_template_intake: pdfIntakeEnvelope(),
        pdf_template_mint: pdfMintEnvelope(),
        pdf_template_publish: pdfPublishEnvelope()
      }
    }) as unknown as WorkflowExecutionRecord;

  beforeEach(async () => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    resetClientMemoryStore();
    await createTargetProject("autonomous");
    // Pre-seed the pdf_template library version this fixture's report reads back (mirrors the real
    // wiring: pdf_template_publish's OWN dispatch deposits it before report ever reads it).
    await new TemplateLibraryStore().publish({
      templateId: `${TARGET}::pdf_template::pdf-routine`,
      objectType: "pdf_template",
      name: "Routine Card",
      recipe: { schemas: [{ title: { type: "text" } }] },
      sourceProjectId: TARGET,
      provenance: { sourceUrl: SOURCE_URL, driven: "demand" }
    });
  });
  afterEach(() => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    resetClientMemoryStore();
  });

  it("records the published pdf_template in the tenant's own client memory under objectType \"pdf_template\"", async () => {
    const reportNode = listCloneConductorNodes().find((n) => n.id === "clone_report")!;
    const run = fixtureRun();
    const outcome = await runCloneStage({ run, node: reportNode, stage: "report" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;

    // pdfTemplates is its OWN block, separate from `publication` (the CMS ledger) — the ADR §7 line.
    expect(outcome.output.pdfTemplates).toBeDefined();
    expect((outcome.output as Record<string, unknown>).publication).toBeDefined();

    const templates = await new ClientMemoryStore().listTemplates(TARGET);
    const pdfRecord = templates.find((t) => t.objectType === "pdf_template");
    expect(pdfRecord).toBeDefined();
    expect(pdfRecord?.templateId).toBe(`${TARGET}::pdf_template::pdf-routine`);
    expect(pdfRecord?.instantiatedObjectId).toBe("tpl_routine_1");
    expect(pdfRecord?.provenance.sourceUrl).toBe(SOURCE_URL);
  });

  it("a run that briefed no pdf template gets no pdfTemplates block at all — never an all-zeros ledger", async () => {
    const reportNode = listCloneConductorNodes().find((n) => n.id === "clone_report")!;
    const run = fixtureRun();
    run.stageOutputs.pdf_template_intake = { artifact: PDF_TEMPLATE_ARTIFACTS.intake, siteId: null, entries: [], rejectedEntries: [] };
    run.stageOutputs.pdf_template_mint = { artifact: PDF_TEMPLATE_ARTIFACTS.mint, siteId: null, applied: [], rejected: [] };
    run.stageOutputs.pdf_template_publish = { artifact: PDF_TEMPLATE_ARTIFACTS.publish, published: [], failed: [] };
    const outcome = await runCloneStage({ run, node: reportNode, stage: "report" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.pdfTemplates).toBeUndefined();
  });
});

// ===================================================================================================
// EXECUTOR LEVEL — pdf_template_publish's own gate: operator withheld halts it; an autonomous tenant
// needs no human. The SAME generic publish-risk mechanism publication_controller/publish_executor
// use, proven against THIS node specifically (clonePublishTail.test.ts's own pattern).
// ===================================================================================================
describe("pdf_template_publish is gated by the SAME publish authority read every publish-risk node uses", () => {
  let calledVerbs: string[];

  const stubFetch = () =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      if (!String(url).startsWith(`https://${TARGET}.example/mcp`)) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push(name);
      if (name === "publish_pdf_template") return respond(request.id, { published: true, activeVersion: 1 });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

  const mintEnvelope = () => ({
    artifact: PDF_TEMPLATE_ARTIFACTS.mint,
    summary: "fixture mint.",
    siteId: "site_zilberman",
    applied: [{ requestedId: "pdf-routine", name: "Routine Card", renderer: "pdfme", templateId: "tpl_routine_1", version: 1, validated: true, templateJson: { schemas: [{ title: { type: "text" } }] }, sourceUrl: "https://zilberman.example/", tags: [] }],
    rejected: []
  });

  // pdf_template_mint's ancestors (per late-stage-entry seeding) are ONLY pdf_template_intake and
  // pdf_template_designer — the PDF-template branch is deliberately independent of clone_intake (the
  // ADR's "discipline shared, transport not" boundary), so clone_intake is a SIBLING here, not an
  // ancestor, exactly like gap_adjudicator sits outside publish_payload's ancestor set in
  // capturePublishTail.test.ts. clone_intake still starts "queued" with satisfied (empty) deps, so
  // left alone it would be the run's canonical-order firstRunnable/nextRunnable pick ahead of
  // pdf_template_publish. Short-circuit it BY HAND to "blocked" (never "completed"/"skipped" — either
  // of those would satisfy its own dependents, e.g. layout_analyst, and cascade the drive loop through
  // the entire unrelated CMS structure chain) so the run has nothing else eligible except the
  // pdf-template branch this suite means to exercise.
  const startAtPdfMint = async (autonomyMode: "autonomous" | "operator-gated") => {
    await createTargetProject(autonomyMode);
    const nodes = listCloneConductorNodes();
    const mintNode = nodes.find((n) => n.id === "pdf_template_mint")!;
    const store = repositoryManager.getExecutionRepository();
    const started = await startDryRun(
      {
        projectId: TARGET,
        workflowId: "clone_conductor",
        executionMode: "openai",
        input: { targetProjectId: TARGET, captureRunId: "run_capture_fixture" },
        entrypoint: { nodeId: mintNode.id, output: mintEnvelope() }
      },
      store
    );
    const run = (await getRun(started.runId, store))!;
    const cloneIntake = run.nodes.find((node) => node.nodeId === "clone_intake")!;
    cloneIntake.status = "blocked";
    cloneIntake.warnings = [...(cloneIntake.warnings ?? []), "fixture_short_circuited_out_of_scope_for_this_suite"];
    await store.saveRun(run);
    return { runId: started.runId, store };
  };

  const driveToHalt = async (runId: string, store: Awaited<ReturnType<typeof repositoryManager.getExecutionRepository>>) => {
    let run = (await getRun(runId, store))!;
    for (let i = 0; i < 20 && run.currentNodeId && !HALTED_EXECUTION_STATUSES.has(run.status); i++) {
      run = await runNextNode(runId, { executionRepository: store });
    }
    return run;
  };

  beforeEach(() => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    calledVerbs = [];
    process.env.ZILBERMAN_PDF_TEMPLATE_MCP_ENDPOINT = `https://${TARGET}.example/mcp`;
  });
  afterEach(() => {
    delete process.env.ZILBERMAN_PDF_TEMPLATE_MCP_ENDPOINT;
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
  });

  it("an autonomous tenant publishes the pdf_template with no operator decision at all", async () => {
    stubFetch();
    const { runId, store } = await startAtPdfMint("autonomous");
    const run = await driveToHalt(runId, store);

    expect(run.operatorPublishDecision).toBeUndefined();
    const publishOutput = run.stageOutputs.pdf_template_publish as Record<string, unknown> | undefined;
    expect(publishOutput?.artifact).toBe(PDF_TEMPLATE_ARTIFACTS.publish);
    expect((publishOutput?.published as unknown[])?.length).toBe(1);
    expect((publishOutput?.publishAuthority as { source: string | null } | undefined)?.source).toBe("policy_autonomous");
    expect(calledVerbs).toContain("publish_pdf_template");

    const advisory = run.approvalsRequired.filter((entry) => entry.nodeId === "pdf_template_publish" && entry.source === "policy_autonomous");
    expect(advisory.length).toBeGreaterThan(0);
  });

  it("an operator's withheld decision halts pdf_template_publish — no publish_pdf_template call at all", async () => {
    const { runId, store } = await startAtPdfMint("autonomous");
    await setOperatorPublishDecision(runId, "withheld", store);
    stubFetch();

    const run = await driveToHalt(runId, store);

    expect(run.status).toBe("blocked");
    // pdf_template_publish is BOTH the gate and the doer in one node (unlike the CMS tail, where
    // publication_controller gates and publish_executor separately does the work and stays
    // undefined when gated) — so a withheld run still writes pdf_template_publish's OWN "blocked"
    // decision record; the gate refusal IS its stage output. What proves nothing was published is the
    // decision shape below plus the absence of any publish_pdf_template call, not an absent output.
    const publishOutput = run.stageOutputs.pdf_template_publish as Record<string, unknown> | undefined;
    expect(publishOutput?.decision).toBe("blocked");
    expect(String(publishOutput?.reason)).toContain("operator_withheld");
    expect(calledVerbs).not.toContain("publish_pdf_template");
    expect(run.approvalsRequired.some((entry) => entry.reason.includes("operator_withheld") || entry.reason.includes("withheld"))).toBe(true);
  });

  it("an operator-gated project with no decision halts the same way — autonomy is per-project, never assumed", async () => {
    const { runId, store } = await startAtPdfMint("operator-gated");
    stubFetch();

    const run = await driveToHalt(runId, store);

    expect(run.status).toBe("blocked");
    const publishOutput = run.stageOutputs.pdf_template_publish as Record<string, unknown> | undefined;
    expect(publishOutput?.decision).toBe("blocked");
    expect(String(publishOutput?.reason)).toContain("operator_approval_absent");
    expect(calledVerbs).not.toContain("publish_pdf_template");
  });
});
