import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { getOperation } from "../../../src/agent/operations/operationCatalog.js";
import { getOperationWorkflowBinding } from "../../../src/agent/operations/operationWorkflowBindings.js";
import { preflightOperation } from "../../../src/agent/operations/operationPreflight.js";
import { buildImageTemplateRevisionBrief } from "../../../src/agent/capture/imageTemplateRevisionBriefBuilder.js";
import { applyWorkflowInitialInput, getWorkflowInitialInputBuilder } from "../../../src/agent/workspace/workflowInitialInput.js";
import { startDryRun } from "../../../src/agent/workspace/executor.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { listImageTemplateRevisionNodes } from "../../../src/agent/workspace/imageTemplateRevisionNodes.js";
import { IMAGE_TEMPLATE_REVISION_WORKFLOW_ID } from "../../../src/agent/workspace/imageTemplateRevisionWorkflow.js";
import { PDF_TEMPLATE_STUDIO_WORKFLOW_ID } from "../../../src/agent/workspace/pdfTemplateStudioWorkflow.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import {
  IMAGE_REVISION_ARTIFACTS,
  type AssetCatalogSource,
  type ResolvedSourceAsset,
  type PreviewTemplateVariantFn,
  type VerifyImagePresenceFn
} from "../../../src/agent/capture/imageTemplateRevisionEngine.js";
import { setImageTemplateRevisionProviders, resetImageTemplateRevisionProviders } from "../../../src/agent/workspace/imageTemplateRevisionProviders.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// =================================================================================================
// A10 — THE TEST THAT DID NOT EXIST: image_template_revision driven from the DISPATCHED OPERATION
// PAYLOAD, through run creation, into the pipeline — never from a hand-built brief.
//
// Every existing A9/A10 suite starts from an `initialInput.imageTemplateRevisionBrief` the test
// itself wrote. That is exactly the step nothing in production performed: Platform resolved the
// operation, sent its FLAT fields to workflow_start_dry_run, and the entry node refused
// (image_template_revision_brief_missing) because nobody constructed the brief. This file starts
// where a signed-in editor's chat turn starts — an operation id and a flat input — and asserts the
// run reaches image_revision_intake with a REAL brief and completes the Zilberman scenario's own
// per-item, partial-reporting guarantees from there.
//
// OFFLINE: pdf-tool is a fetch double, the asset catalogue / preview / verify seams are fixture
// doubles, the library is the in-memory backend. No live tenant, no renderer, no publish, no
// release, and nothing here asserts live media generation.
// =================================================================================================

const TARGET = "zilberman-dispatch-integration";
const MCP_ENV_VAR = "ZILBERMAN_DISPATCH_INTEGRATION_MCP_ENDPOINT";
const PUBLISH_ENABLED_ENV_VAR = "ZILBERMAN_DISPATCH_INTEGRATION_PUBLISH_ENABLED";

// A faithful, local re-implementation of Platform's own dispatch-input construction (platform
// packages/core/server/lib/agent/tools.ts, resolveCatalogOperation's workflow branch): the
// operation's appliedDefaults, then the model's own input, then binding.inputMapping's rename, then
// tenantId forced LAST under the mapped scope key so a model can never widen scope. Mirrored rather
// than imported — the two repos share no package — and deliberately NOT taught to build a brief:
// proving the brief is built CMS-Agent-side is the point of this file.
function platformDispatchInput(operationId: string, modelInput: Record<string, unknown>, projectId: string): { workflowId: string; input: Record<string, unknown> } {
  const binding = getOperationWorkflowBinding(operationId);
  if (!binding) throw new Error(`no workflow binding for ${operationId}`);
  const operation = getOperation(operationId);
  if (!operation.found) throw new Error(`no descriptor for ${operationId}`);
  const merged: Record<string, unknown> = { ...operation.descriptor.defaults, ...modelInput };
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) mapped[binding.inputMapping[key] ?? key] = value;
  mapped[binding.inputMapping.tenantId ?? "tenantId"] = projectId;
  return { workflowId: binding.workflowId, input: mapped };
}

// What the editor actually says, in the operation's own vocabulary: this tagged image, on these
// three templates, and yes — apply it. (The fourth, "web"-surface ref is the scenario's own
// deliberately-unreachable target, so partial reporting is asserted against a REAL failure.)
const templateId = (requestedId: string) => `${TARGET}::pdf_template::${requestedId}`;
const chatInput = (overrides: Record<string, unknown> = {}) => ({
  sourceAsset: { tag: "zilberman-hero" },
  templateRefs: [
    { surface: "pdf", templateId: templateId("newsletter"), tenantId: TARGET },
    { surface: "pdf", templateId: templateId("flyer"), tenantId: TARGET },
    { surface: "pdf", templateId: templateId("order-form"), tenantId: TARGET },
    { surface: "web", templateId: `${TARGET}::web_template::brochure`, tenantId: TARGET }
  ],
  approve: true,
  ...overrides
});

const HERO: ResolvedSourceAsset = {
  assetId: "asset_zilberman_hero",
  checksum: "sha256-zilberman-hero-fixed",
  tags: ["zilberman-hero"],
  widthPx: 800,
  heightPx: 400,
  reference: "asset://zilberman-hero/v1",
  provenance: { captureRequestId: "capreq_zilberman_9001" }
};

const assetCatalog: AssetCatalogSource = {
  resolveByTag: async (tenantId, tag) => (tenantId === TARGET && tag === "zilberman-hero" ? [HERO] : []),
  resolveByChecksum: async () => undefined,
  resolveByCaptureRequestId: async () => undefined
};

const pdfmePage = (fieldY: number) => [{ name: `field_${fieldY}`, type: "text", position: { x: 20, y: fieldY } }];

const seedLibrary = async () => {
  const store = new TemplateLibraryStore();
  const seeds: Array<[string, unknown[]]> = [
    ["newsletter", [pdfmePage(20), pdfmePage(30), pdfmePage(500)]],
    ["flyer", [pdfmePage(10), pdfmePage(10)]],
    ["order-form", [pdfmePage(700), pdfmePage(700), pdfmePage(700), pdfmePage(700)]]
  ];
  for (const [requestedId, schemas] of seeds) {
    await store.publish({
      templateId: templateId(requestedId),
      objectType: "pdf_template",
      name: `Zilberman ${requestedId}`,
      recipe: { schemas },
      sourceProjectId: TARGET,
      provenance: { sourceUrl: `https://zilberman.example/templates/${requestedId}`, driven: "demand" }
    });
  }
};

let previewCalls: string[];
let verifyCalls: string[];
let createCalls: number;
let publishCalls: number;

const previewTemplateVariant: PreviewTemplateVariantFn = async (input) => {
  previewCalls.push(input.templateId);
  return { beforeRef: `preview://before/${input.templateId}`, afterRef: `preview://after/${input.templateId}` };
};
const verifyImagePresence: VerifyImagePresenceFn = async (input) => {
  verifyCalls.push(input.templateId);
  return { pagesWithImage: Array.from({ length: input.pageCount }, (_, index) => index), pagesMissingImage: [] };
};

const installFetchDouble = () => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string } };
    const ok = (result: unknown) =>
      ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }) }) as unknown as Response;
    if (request.method !== "tools/call") return ok({});
    const name = request.params?.name;
    if (name === "create_pdf_template") {
      createCalls += 1;
      return ok({ templateId: `pdftool_internal_${createCalls}`, version: 1 });
    }
    if (name === "publish_pdf_template") {
      publishCalls += 1;
      return ok({ published: true, activeVersion: 1 });
    }
    throw new Error(`Unexpected verb in this fixture: ${name}`);
  }) as unknown as typeof fetch;
};

const nodesById = new Map(listImageTemplateRevisionNodes().map((node) => [node.id, node]));
type ImageRevisionStage = "image_revision_intake" | "image_revision_compile_preview" | "image_revision_apply" | "image_revision_report";
const stage = async (run: WorkflowExecutionRecord, stageId: ImageRevisionStage) => runCloneStage({ run, node: nodesById.get(stageId)!, stage: stageId });

// The dispatch itself: exactly what the tool layer does — Platform's flat input into startDryRun,
// under the binding's own workflowId. Everything this file asserts flows from this one call.
const dispatch = async (modelInput: Record<string, unknown>) => {
  const { workflowId, input } = platformDispatchInput("image_template_revision", modelInput, TARGET);
  expect(workflowId).toBe(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
  return startDryRun({ projectId: TARGET, workflowId, input });
};

beforeEach(async () => {
  resetRepositoryManager();
  resetTemplateLibraryMemoryStore();
  previewCalls = [];
  verifyCalls = [];
  createCalls = 0;
  publishCalls = 0;
  process.env[MCP_ENV_VAR] = `https://${TARGET}.example/mcp`;
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "Dispatch integration fixture", mcpEndpointEnvVar: MCP_ENV_VAR, authMode: "none", defaultToolPolicy: "allowed" })
  );
  await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
  setImageTemplateRevisionProviders({ assetCatalog, previewTemplateVariant, verifyImagePresence });
  installFetchDouble();
});

afterEach(() => {
  delete process.env[MCP_ENV_VAR];
  delete process.env[PUBLISH_ENABLED_ENV_VAR];
  resetImageTemplateRevisionProviders();
  resetRepositoryManager();
  resetTemplateLibraryMemoryStore();
});

describe("preflight reports image_template_revision executable because the binding genuinely guarantees the entry node its input", () => {
  it("executable:true with the binding's workflowId and a declared, verified initial-input builder — no relaxed check anywhere", () => {
    const result = preflightOperation({ operationId: "image_template_revision", tenantId: TARGET, input: { tenantId: TARGET, ...chatInput() } });
    expect(result.missingRequired).toEqual([]);
    expect(result.blockers.filter((blocker) => blocker.blocking)).toEqual([]);
    expect(result.executable).toBe(true);
    expect(result.binding?.workflowId).toBe(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
    expect(result.binding?.initialInputBuilder?.builderId).toBe("image_template_revision_brief_builder.v1");
    expect(result.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
    expect(result.appliedDefaults).toEqual({ batchSize: 10 });
  });

  it("the operation's own schema still refuses a request that names no source image — the field the builder needs is REQUIRED, not hoped for", () => {
    const result = preflightOperation({ operationId: "image_template_revision", tenantId: TARGET, input: { tenantId: TARGET, templateRefs: chatInput().templateRefs } });
    expect(result.missingRequired).toContain("sourceAsset");
    expect(result.blockers.some((blocker) => blocker.code === "input_schema_invalid" && blocker.blocking)).toBe(true);
  });

  it("pdf_template_family is UNCHANGED by this task — still unsatisfied, still not executable, and still has no builder", () => {
    const result = preflightOperation({ operationId: "pdf_template_family", tenantId: TARGET, input: { tenantId: TARGET } });
    expect(result.executable).toBe(false);
    expect(result.binding).toBeNull();
    expect(getWorkflowInitialInputBuilder(PDF_TEMPLATE_STUDIO_WORKFLOW_ID)).toBeNull();
  });
});

describe("a chat-dispatched run reaches image_revision_intake with a real brief", () => {
  it("startDryRun builds the nested brief from the dispatched flat fields — normalized, tenant-pinned, and carrying the editor's own approve", async () => {
    const run = await dispatch(chatInput());
    const initial = run.initialInput as Record<string, unknown>;
    // The flat fields the editor actually sent are kept on the record, alongside what was built.
    expect(initial.tenantId).toBe(TARGET);
    expect(initial.batchSize).toBe(10);
    expect(initial.targetProjectId).toBe(TARGET);
    expect(initial.imageTemplateRevisionBrief).toEqual({
      tenantId: TARGET,
      sourceAsset: { tag: "zilberman-hero" },
      templateRefs: [
        { surface: "pdf", templateId: templateId("newsletter"), tenantId: TARGET },
        { surface: "pdf", templateId: templateId("flyer"), tenantId: TARGET },
        { surface: "pdf", templateId: templateId("order-form"), tenantId: TARGET },
        { surface: "web", templateId: `${TARGET}::web_template::brochure`, tenantId: TARGET }
      ],
      approve: true
    });
    // A LIVE run, not a mock traversal: the default executionMode is "openai", so the editorial
    // subject gate (startDryRun's own, applied to every workflow) genuinely ran and accepted the
    // structured brief as the run's declared subject. Before A10 this exact run was refused with
    // editorial_subject_missing before a single node could dispatch.
    expect(run.executionMode).toBe("openai");
    expect(run.workflowId).toBe(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
    expect(run.currentNodeId).toBe("image_revision_intake");
  });

  it("intake COMPLETES for that run — no *_brief_missing refusal — resolving the source once and fetching every reachable target", async () => {
    await seedLibrary();
    const run = await dispatch(chatInput());
    const outcome = await stage(run, "image_revision_intake");
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.artifact).toBe(IMAGE_REVISION_ARTIFACTS.intake);
    expect(outcome.output.tenantId).toBe(TARGET);
    expect(outcome.output.sourceAsset).toMatchObject({ assetId: "asset_zilberman_hero" });
    const items = outcome.output.items as Array<{ templateRef: { templateId: string }; current?: { pageCount: number }; error?: { code: string } }>;
    expect(items).toHaveLength(4);
    expect(items.find((item) => item.templateRef.templateId.endsWith("newsletter"))?.current?.pageCount).toBe(3);
    expect(items.find((item) => item.templateRef.templateId.endsWith("flyer"))?.current?.pageCount).toBe(2);
    expect(items.find((item) => item.templateRef.templateId.endsWith("order-form"))?.current?.pageCount).toBe(4);
    // The web-surface target is a NAMED per-item gap, not a crash and not a silent skip.
    expect(items.find((item) => item.templateRef.templateId.endsWith("brochure"))?.error?.code).toBe("image_revision_surface_unsupported");
  });

  it("the full pipeline from the dispatched payload: previewed, applied to the next immutable version, verified on every page, and reported PARTIAL — never fully successful", async () => {
    await seedLibrary();
    const run = await dispatch(chatInput());

    const intake = await stage(run, "image_revision_intake");
    expect(intake.kind).toBe("completed");
    if (intake.kind !== "completed") return;
    run.stageOutputs.image_revision_intake = intake.output;

    const preview = await stage(run, "image_revision_compile_preview");
    expect(preview.kind).toBe("completed");
    if (preview.kind !== "completed") return;
    run.stageOutputs.image_revision_compile_preview = preview.output;
    const previewItems = preview.output.items as Array<{ templateRef: { templateId: string }; outcome: string; beforeRef?: string; afterRef?: string; pages?: Array<{ imagePlaced: boolean }> }>;
    const newsletter = previewItems.find((item) => item.templateRef.templateId.endsWith("newsletter"))!;
    expect(newsletter.outcome).toBe("previewed");
    expect(newsletter.beforeRef).toMatch(/^preview:\/\/before\//);
    expect(newsletter.pages).toHaveLength(3);
    expect(newsletter.pages!.every((page) => page.imagePlaced)).toBe(true);

    const applied = await stage(run, "image_revision_apply");
    expect(applied.kind).toBe("completed");
    if (applied.kind !== "completed") return;
    run.stageOutputs.image_revision_apply = applied.output;
    const appliedItems = applied.output.items as Array<{ templateRef: { templateId: string }; outcome: string }>;
    expect(appliedItems.filter((item) => item.outcome === "verified")).toHaveLength(3);
    expect(createCalls).toBe(3);
    expect(publishCalls).toBe(3);
    expect(verifyCalls).toHaveLength(3);

    // The library's own NEXT version landed; the originals are untouched and still reachable.
    const store = new TemplateLibraryStore();
    for (const requestedId of ["newsletter", "flyer", "order-form"]) {
      expect(await store.getVersion(templateId(requestedId), 1)).toBeDefined();
      expect((await store.getLatest(templateId(requestedId)))?.version).toBe(2);
    }

    const report = await stage(run, "image_revision_report");
    expect(report.kind).toBe("completed");
    if (report.kind !== "completed") return;
    expect(report.output.partial).toBe(true);
    expect(report.output.allFailed).toBe(false);
    const reportItems = report.output.items as Array<{ outcome: string }>;
    expect(reportItems).toHaveLength(4); // every dispatched templateRef named exactly once
    expect(reportItems.filter((item) => item.outcome === "verified")).toHaveLength(3);
    expect(reportItems.filter((item) => item.outcome === "target_fetch_failed")).toHaveLength(1);
  });

  it("a dispatch that does NOT approve still previews, applies NOTHING, and is reported partial — `previewed`/`not_approved` never count as successes (#337 D4)", async () => {
    await seedLibrary();
    const run = await dispatch(chatInput({ approve: undefined }));
    expect((run.initialInput as Record<string, unknown>).imageTemplateRevisionBrief).not.toHaveProperty("approve");

    const intake = await stage(run, "image_revision_intake");
    if (intake.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_intake = intake.output;
    const preview = await stage(run, "image_revision_compile_preview");
    if (preview.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_compile_preview = preview.output;
    const applied = await stage(run, "image_revision_apply");
    if (applied.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_apply = applied.output;

    // Nothing was minted, published or verified: an unapproved run touches no tenant state.
    expect(createCalls).toBe(0);
    expect(publishCalls).toBe(0);
    expect(verifyCalls).toEqual([]);
    const appliedItems = applied.output.items as Array<{ outcome: string }>;
    expect(appliedItems.filter((item) => item.outcome === "verified")).toEqual([]);
    expect(appliedItems.filter((item) => item.outcome === "not_approved")).toHaveLength(3);

    const report = await stage(run, "image_revision_report");
    if (report.kind !== "completed") throw new Error("fixture setup failed");
    expect(report.output.partial).toBe(true); // NOT reported as a success
    const store = new TemplateLibraryStore();
    expect((await store.getLatest(templateId("newsletter")))?.version).toBe(1); // untouched
  });

  it("the publish kill switch still refuses the apply stage for a chat-dispatched run — the builder changes what reaches the pipeline, never what the gates decide", async () => {
    await seedLibrary();
    const run = await dispatch(chatInput());
    const intake = await stage(run, "image_revision_intake");
    if (intake.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_intake = intake.output;
    const preview = await stage(run, "image_revision_compile_preview");
    if (preview.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_compile_preview = preview.output;

    process.env[PUBLISH_ENABLED_ENV_VAR] = "false";
    const applied = await stage(run, "image_revision_apply");
    expect(applied.kind).toBe("refused");
    expect(createCalls).toBe(0);
    expect(publishCalls).toBe(0);
  });
});

describe("the builder refuses before a run exists, by name, rather than emitting a partial brief", () => {
  const failedDispatch = async (modelInput: Record<string, unknown>) => {
    try {
      await dispatch(modelInput);
      return undefined;
    } catch (error) {
      return error as { code?: string; message?: string };
    }
  };

  it("a templateRef naming ANOTHER tenant is refused — the one place it can be, since Platform forces only the top-level tenantId", async () => {
    const error = await failedDispatch(chatInput({ templateRefs: [{ surface: "pdf", templateId: "other-tenant::pdf_template::x", tenantId: "some-other-tenant" }] }));
    expect(error?.code).toBe("image_revision_template_ref_tenant_mismatch");
    expect(await repositoryManager.getExecutionRepository().listRuns({})).toEqual([]); // nothing minted
  });

  it("an unreadable version pin is refused, never silently dropped in favour of whatever is latest", async () => {
    const error = await failedDispatch(chatInput({ templateRefs: [{ surface: "pdf", templateId: templateId("newsletter"), tenantId: TARGET, version: "latest" }] }));
    expect(error?.code).toBe("image_revision_template_ref_version_invalid");
  });

  it("more templateRefs than batchSize is refused, never truncated into a report that reads complete", async () => {
    const error = await failedDispatch(chatInput({ batchSize: 2 }));
    expect(error?.code).toBe("image_revision_batch_size_exceeded");
    expect(error?.message).toContain("refused rather than truncated");
  });

  it("a dispatch with no usable sourceAsset is refused at run creation too, not only at preflight", async () => {
    const error = await failedDispatch(chatInput({ sourceAsset: {} }));
    expect(error?.code).toBe("image_revision_source_ref_missing");
  });
});

describe("the builder is narrow: idempotent, workflow-scoped, and pure", () => {
  it("an initialInput that ALREADY carries a brief is passed through untouched — every existing operator/test caller, and every reset of a built run, behaves exactly as before", () => {
    const handBuilt = { targetProjectId: TARGET, imageTemplateRevisionBrief: { tenantId: TARGET, sourceAsset: { tag: "zilberman-hero" }, templateRefs: [] } };
    const result = applyWorkflowInitialInput(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID, handBuilt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(false);
    expect(result.input).toBe(handBuilt); // the same object, not a rebuilt copy
  });

  it("an input that is not an operation dispatch at all is passed through and the run is still CREATED — the builder builds, it is not a second gate on starting this workflow", async () => {
    await seedLibrary();
    // The shape publishAutonomyEveryWorkflow.test.ts starts every registered workflow with: no
    // tenantId, no templateRefs, no sourceAsset. It must still mint a run (that test asserts the
    // project's publishing-policy snapshot reaches every workflow) and must NOT be refused by name.
    const generic = applyWorkflowInitialInput(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID, { targetProjectId: TARGET, note: "operator run" });
    expect(generic).toMatchObject({ ok: true, applied: false });
    const run = await startDryRun({ projectId: TARGET, workflowId: IMAGE_TEMPLATE_REVISION_WORKFLOW_ID, executionMode: "mock", input: { targetProjectId: TARGET, note: "operator run" } });
    expect(run.runId).toBeTruthy();
    expect((run.initialInput as Record<string, unknown>).imageTemplateRevisionBrief).toBeUndefined();
    // And the entry node's own dispatch-boundary refusal is exactly as it was before this task.
    const outcome = await stage(run, "image_revision_intake");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("image_template_revision_brief_missing");
  });

  it("a workflow with no registered builder is untouched, and a non-object input is never coerced into one", () => {
    const publishing = applyWorkflowInitialInput("publishing_conductor", { topic: "unchanged" });
    expect(publishing).toMatchObject({ ok: true, applied: false, builderId: null });
    const bare = applyWorkflowInitialInput(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID, "a bare string subject");
    expect(bare).toMatchObject({ ok: true, applied: false });
  });

  it("buildImageTemplateRevisionBrief normalizes a numeric-string version and defaults a ref's tenant to the operation's own, without inventing anything else", () => {
    const built = buildImageTemplateRevisionBrief({
      tenantId: TARGET,
      sourceAsset: { tag: "  zilberman-hero  ", checksum: "" },
      templateRefs: [{ surface: "pdf", templateId: templateId("flyer"), version: "3" }]
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.brief).toEqual({
      tenantId: TARGET,
      sourceAsset: { tag: "zilberman-hero" },
      templateRefs: [{ surface: "pdf", templateId: templateId("flyer"), tenantId: TARGET, version: 3 }]
    });
  });
});
