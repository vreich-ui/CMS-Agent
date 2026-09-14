import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkflowDefinition, listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import { IMAGE_TEMPLATE_REVISION_WORKFLOW_ID } from "../../../src/agent/workspace/imageTemplateRevisionWorkflow.js";
import { listImageTemplateRevisionNodes, IMAGE_TEMPLATE_REVISION_AI_NODE_IDS } from "../../../src/agent/workspace/imageTemplateRevisionNodes.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { resolveExecutionKind, resolveRouteId, routeRequiredToolsFor, phaseTimeoutMsFor } from "../../../src/agent/workspace/routeRegistry.js";
import { listPublishGates } from "../../../src/agent/workspace/gateRegistry.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { getOperationWorkflowBinding, resolveBindingInputContract } from "../../../src/agent/operations/operationWorkflowBindings.js";
import "../../../src/agent/operations/registerOperations.js";
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

// A9 — the image-on-every-page batch operation, wiring level AND the supplied Zilberman acceptance
// scenario (design doc, 2026-09-11: place a tagged/provenance image top-right on every page of three
// multi-page PDF templates, reviewable before/after outputs, per-item reporting, errors never "all
// done"). Mirrors pdfTemplateStudioWorkflow.test.ts's own structure exactly: registration -> routes ->
// operation binding -> the full scenario driven directly through runCloneStage, one stage at a time,
// exactly as A7's own tests drive its stages. No production publication anywhere in this file: every
// mint/publish call below is pdf-tool's own template store (a create_pdf_template/publish_pdf_template
// double), never object_publish/release_to_production, and this run never composes the shared CMS
// publishing tail at all (see imageTemplateRevisionNodes.ts's own header).

const TARGET = "zilberman-image-revision-studio";
const MCP_ENV_VAR = "ZILBERMAN_IMAGE_REVISION_STUDIO_MCP_ENDPOINT";
// publisher.ts's publishEnabledEnvVar: strips _MCP_ENDPOINT, appends _PUBLISH_ENABLED. An explicit
// "false" here is the kill switch regardless of publishingPolicy — this is what the last test below
// actually flips, never autonomyMode (which governs operator-approval precedence, a different axis).
const PUBLISH_ENABLED_ENV_VAR = "ZILBERMAN_IMAGE_REVISION_STUDIO_PUBLISH_ENABLED";

describe("image_template_revision_studio — registered in the workflow registry", () => {
  it("is registered, distinct from every other workflow, and never silently falls back to publishing_conductor", () => {
    expect(listRegisteredWorkflowIds()).toContain(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
    expect(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID).toBe("image_template_revision_studio");
    const definition = getWorkflowDefinition(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
    expect(definition).toBeDefined();
    expect(definition?.canonicalNodes().map((node) => node.id)).toEqual([
      "image_revision_intake",
      "image_revision_compile_preview",
      "image_revision_apply",
      "image_revision_report"
    ]);
  });

  it("listImageTemplateRevisionNodes returns a fresh, independently-mutable copy each call", () => {
    const first = listImageTemplateRevisionNodes();
    const second = listImageTemplateRevisionNodes();
    expect(first).not.toBe(second);
    first[0].dependsOn.push("mutated");
    expect(second[0].dependsOn).not.toContain("mutated");
  });

  it("carries zero AI-judgment nodes — every node is a deterministic clone-stage route (placement is mechanical, not a creative judgment)", () => {
    expect(IMAGE_TEMPLATE_REVISION_AI_NODE_IDS).toEqual([]);
    for (const node of listImageTemplateRevisionNodes()) {
      expect(resolveExecutionKind(node), `${node.id} should be a deterministic route`).toBe("deterministic");
    }
  });

  it("never composes the shared CMS publishing tail — a pdf_template is not a CMS-publishable type", () => {
    const nodeIds = listImageTemplateRevisionNodes().map((node) => node.id);
    for (const tailNodeId of ["publish_payload", "publication_controller", "publish_executor", "release_executor"]) {
      expect(nodeIds).not.toContain(tailNodeId);
    }
  });
});

describe("image_template_revision_studio — routes and gates", () => {
  it("resolves every node's route id to clone_stage, and every phase's required tools", () => {
    const byId = new Map(listImageTemplateRevisionNodes().map((node) => [node.id, node]));
    expect(resolveRouteId(byId.get("image_revision_intake")!)).toBe("clone_stage");
    expect(routeRequiredToolsFor("clone_stage", "image_revision_intake")).toEqual([]);
    expect(routeRequiredToolsFor("clone_stage", "image_revision_compile_preview")).toEqual([]);
    const applyTools = routeRequiredToolsFor("clone_stage", "image_revision_apply");
    expect(applyTools?.map((tool) => tool.verb)).toEqual(["create_pdf_template", "publish_pdf_template"]);
    expect(applyTools?.find((tool) => tool.verb === "publish_pdf_template")?.risk).toBe("publish");
    expect(routeRequiredToolsFor("clone_stage", "image_revision_report")).toEqual([]);
    for (const phaseId of ["image_revision_intake", "image_revision_compile_preview", "image_revision_apply", "image_revision_report"]) {
      expect(phaseTimeoutMsFor("clone_stage", phaseId, byId.get("image_revision_intake")!)).toBeGreaterThan(0);
    }
  });

  it("gates image_revision_apply (riskLevel publish) under its own (workflowId, nodeId) pair", () => {
    const gate = listPublishGates().find((g) => g.workflowId === IMAGE_TEMPLATE_REVISION_WORKFLOW_ID && g.nodeId === "image_revision_apply");
    expect(gate).toBeDefined();
    const applyNode = listImageTemplateRevisionNodes().find((node) => node.id === "image_revision_apply");
    expect(applyNode?.riskLevel).toBe("publish");
  });
});

describe("image_template_revision (A2 catalog operation) is bound to image_template_revision_studio, its input contract SATISFIED (A10)", () => {
  it("resolves via getOperationWorkflowBinding, and R1c now reports the contract satisfied for a CHECKED reason — the entry node names the brief it requires and the binding's declared builder supplies exactly that", () => {
    const binding = getOperationWorkflowBinding("image_template_revision");
    expect(binding).not.toBeNull();
    expect(binding?.workflowId).toBe(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
    expect(binding?.workflowId).not.toBe("image_template_revision"); // never the operation id itself
    const status = resolveBindingInputContract(binding!);
    // A10-D1 pinned this false because the check had nothing to evaluate (an open entry-node schema)
    // and nothing was guaranteed (an empty inputMapping). BOTH are now closed, in the two ways
    // A10-D1's own comment named as legitimate: image_revision_intake's inputSchema names
    // `imageTemplateRevisionBrief` as required, and the binding declares the initial-input builder
    // that constructs it (verified against this operation's own guaranteed fields). See
    // operationWorkflowBindings.test.ts's R1c block for the field-level assertions.
    expect(status.contract?.satisfied).toBe(true);
    expect(status.contract?.guaranteedTargetFields).toEqual(["imageTemplateRevisionBrief"]);
    expect(status.contract?.unsatisfiedBuilderOperationFields).toEqual([]);
  });
});

// ===================================================================================================
// THE ZILBERMAN ACCEPTANCE SCENARIO — resolve source -> fetch target versions -> compile recurring-
// header image edit -> preview all variants -> approved per-version updates -> verify, driven one
// stage at a time through runCloneStage exactly as pdfTemplateStudioWorkflow.test.ts drives A7's own
// stages. Three multi-page PDF templates + one deliberately-unreachable ("web" surface) fourth item,
// so partial reporting is asserted against a REAL failure, never a fabricated one.
// ===================================================================================================
describe("the Zilberman scenario: place a tagged image top-right on every page of three multi-page PDF templates", () => {
  const nodesById = new Map(listImageTemplateRevisionNodes().map((node) => [node.id, node]));

  const ZILBERMAN_HERO: ResolvedSourceAsset = {
    assetId: "asset_zilberman_hero",
    checksum: "sha256-zilberman-hero-fixed",
    tags: ["zilberman-hero"],
    widthPx: 800,
    heightPx: 400,
    reference: "asset://zilberman-hero/v1",
    provenance: { captureRequestId: "capreq_zilberman_9001" }
  };

  const templateRef = (requestedId: string, surface: "pdf" | "web" = "pdf") => ({
    surface,
    templateId: surface === "pdf" ? `${TARGET}::pdf_template::${requestedId}` : `${TARGET}::web_template::${requestedId}`,
    tenantId: TARGET
  });

  const pdfmePage = (fieldY: number) => [{ name: `field_${fieldY}`, type: "text", position: { x: 20, y: fieldY } }];

  const seedLibrary = async () => {
    const store = new TemplateLibraryStore();
    await store.publish({
      templateId: `${TARGET}::pdf_template::newsletter`,
      objectType: "pdf_template",
      name: "Zilberman Newsletter",
      recipe: { schemas: [pdfmePage(20), pdfmePage(30), pdfmePage(500)] }, // 3 pages
      sourceProjectId: TARGET,
      provenance: { sourceUrl: "https://zilberman.example/templates/newsletter", driven: "demand" }
    });
    await store.publish({
      templateId: `${TARGET}::pdf_template::flyer`,
      objectType: "pdf_template",
      name: "Zilberman Flyer",
      recipe: { schemas: [pdfmePage(10), pdfmePage(10)] }, // 2 pages
      sourceProjectId: TARGET,
      provenance: { sourceUrl: "https://zilberman.example/templates/flyer", driven: "demand" }
    });
    await store.publish({
      templateId: `${TARGET}::pdf_template::order-form`,
      objectType: "pdf_template",
      name: "Zilberman Order Form",
      recipe: { schemas: [pdfmePage(700), pdfmePage(700), pdfmePage(700), pdfmePage(700)] }, // 4 pages
      sourceProjectId: TARGET,
      provenance: { sourceUrl: "https://zilberman.example/templates/order-form", driven: "demand" }
    });
    return store;
  };

  const assetCatalog: AssetCatalogSource = {
    resolveByTag: async (tenantId, tag) => (tenantId === TARGET && tag === "zilberman-hero" ? [ZILBERMAN_HERO] : []),
    resolveByChecksum: async () => undefined,
    resolveByCaptureRequestId: async () => undefined
  };

  let previewCalls: string[];
  let verifyCalls: string[];
  const previewTemplateVariant: PreviewTemplateVariantFn = async (input) => {
    previewCalls.push(input.templateId);
    return { beforeRef: `preview://before/${input.templateId}/v${input.beforeVersion}`, afterRef: `preview://after/${input.templateId}/v${input.beforeVersion}` };
  };
  const verifyImagePresence: VerifyImagePresenceFn = async (input) => {
    verifyCalls.push(input.templateId);
    return { pagesWithImage: Array.from({ length: input.pageCount }, (_, i) => i), pagesMissingImage: [] };
  };

  let createCalls = 0;
  let publishCalls = 0;
  const installFetchDouble = () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string } };
      const ok = (result: unknown) =>
        ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }) } as unknown as Response);
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

  const baseRun = (): WorkflowExecutionRecord =>
    ({
      projectId: TARGET,
      workflowId: IMAGE_TEMPLATE_REVISION_WORKFLOW_ID,
      initialInput: {
        targetProjectId: TARGET,
        imageTemplateRevisionBrief: {
          tenantId: TARGET,
          sourceAsset: { tag: "zilberman-hero" },
          templateRefs: [templateRef("newsletter"), templateRef("flyer"), templateRef("order-form"), templateRef("brochure", "web")],
          approve: true
        }
      },
      publishingPolicySnapshot: { autonomyMode: "autonomous" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID).publishableTypes },
      stageOutputs: {}
    }) as unknown as WorkflowExecutionRecord;

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
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "Image template revision fixture",
        mcpEndpointEnvVar: MCP_ENV_VAR,
        authMode: "none",
        defaultToolPolicy: "allowed"
      })
    );
    await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
    setImageTemplateRevisionProviders({ assetCatalog, previewTemplateVariant, verifyImagePresence });
  });
  afterEach(() => {
    delete process.env[MCP_ENV_VAR];
    delete process.env[PUBLISH_ENABLED_ENV_VAR];
    resetImageTemplateRevisionProviders();
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
  });

  it("STAGE 1 (intake): resolves the tagged/provenance source image exactly once and fetches every target template's current version — the web-surface item is a named gap, not a crash", async () => {
    await seedLibrary();
    const run = baseRun();
    const outcome = await runCloneStage({ run, node: nodesById.get("image_revision_intake")!, stage: "image_revision_intake" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.artifact).toBe(IMAGE_REVISION_ARTIFACTS.intake);
    expect(outcome.output.sourceAsset).toMatchObject({ assetId: "asset_zilberman_hero" });
    const items = outcome.output.items as Array<{ templateRef: { templateId: string }; current?: { pageCount: number }; error?: { code: string } }>;
    expect(items).toHaveLength(4);
    expect(items.find((i) => i.templateRef.templateId.endsWith("newsletter"))?.current?.pageCount).toBe(3);
    expect(items.find((i) => i.templateRef.templateId.endsWith("flyer"))?.current?.pageCount).toBe(2);
    expect(items.find((i) => i.templateRef.templateId.endsWith("order-form"))?.current?.pageCount).toBe(4);
    expect(items.find((i) => i.templateRef.templateId.endsWith("brochure"))?.error?.code).toBe("image_revision_surface_unsupported");
  });

  it("the FULL pipeline: preview all variants, apply approved per-version updates, verify, and report — every page carries the image top-right, before/after outputs are reviewable, each item is reported individually, and the run reports PARTIAL, never fully successful", async () => {
    await seedLibrary();
    installFetchDouble();
    const run = baseRun();

    const intakeOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_intake")!, stage: "image_revision_intake" });
    expect(intakeOutcome.kind).toBe("completed");
    if (intakeOutcome.kind !== "completed") return;
    run.stageOutputs.image_revision_intake = intakeOutcome.output;

    const previewOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_compile_preview")!, stage: "image_revision_compile_preview" });
    expect(previewOutcome.kind).toBe("completed");
    if (previewOutcome.kind !== "completed") return;
    run.stageOutputs.image_revision_compile_preview = previewOutcome.output;

    const previewItems = previewOutcome.output.items as Array<{ templateRef: { templateId: string }; outcome: string; beforeRef?: string; afterRef?: string; pages?: Array<{ imagePlaced: boolean; pageIndex: number }> }>;
    expect(previewItems).toHaveLength(4);
    const newsletter = previewItems.find((i) => i.templateRef.templateId.endsWith("newsletter"))!;
    expect(newsletter.outcome).toBe("previewed");
    // Reviewable before/after outputs.
    expect(newsletter.beforeRef).toMatch(/^preview:\/\/before\//);
    expect(newsletter.afterRef).toMatch(/^preview:\/\/after\//);
    // Placed on EVERY page.
    expect(newsletter.pages).toHaveLength(3);
    expect(newsletter.pages!.every((p) => p.imagePlaced)).toBe(true);
    const flyer = previewItems.find((i) => i.templateRef.templateId.endsWith("flyer"))!;
    expect(flyer.pages).toHaveLength(2);
    const orderForm = previewItems.find((i) => i.templateRef.templateId.endsWith("order-form"))!;
    expect(orderForm.pages).toHaveLength(4);
    const brochure = previewItems.find((i) => i.templateRef.templateId.endsWith("brochure"))!;
    expect(brochure.outcome).toBe("target_fetch_failed"); // carried through from intake's named surface gap
    expect(previewCalls.sort()).toEqual([`${TARGET}::pdf_template::flyer`, `${TARGET}::pdf_template::newsletter`, `${TARGET}::pdf_template::order-form`].sort());

    const applyOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_apply")!, stage: "image_revision_apply" });
    expect(applyOutcome.kind).toBe("completed");
    if (applyOutcome.kind !== "completed") return;
    run.stageOutputs.image_revision_apply = applyOutcome.output;

    const applyItems = applyOutcome.output.items as Array<{ templateRef: { templateId: string }; outcome: string; afterVersion?: number }>;
    expect(applyItems.filter((i) => i.outcome === "verified")).toHaveLength(3);
    expect(applyItems.find((i) => i.templateRef.templateId.endsWith("brochure"))?.outcome).toBe("target_fetch_failed");
    expect(createCalls).toBe(3);
    expect(publishCalls).toBe(3);
    expect(verifyCalls).toHaveLength(3);

    // The library's OWN next version actually landed — "preserve earlier version, never overwrite":
    // v1 (the original) is still reachable, and v2 is the new one, for every applied template.
    const store = new TemplateLibraryStore();
    for (const requestedId of ["newsletter", "flyer", "order-form"]) {
      const templateId = `${TARGET}::pdf_template::${requestedId}`;
      const v1 = await store.getVersion(templateId, 1);
      const latest = await store.getLatest(templateId);
      expect(v1).toBeDefined(); // the ORIGINAL is untouched and still reachable
      expect(latest?.version).toBe(2); // the revision minted the NEXT version, not a new template
    }

    const reportOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_report")!, stage: "image_revision_report" });
    expect(reportOutcome.kind).toBe("completed");
    if (reportOutcome.kind !== "completed") return;
    expect(reportOutcome.output.artifact).toBe(IMAGE_REVISION_ARTIFACTS.report);
    // ERRORS NEVER BECOME "ALL DONE": one item failed (the web-surface gap), so this run is PARTIAL —
    // never reported as fully successful, and never reported as a total failure either.
    expect(reportOutcome.output.partial).toBe(true);
    expect(reportOutcome.output.allFailed).toBe(false);
    const reportItems = reportOutcome.output.items as Array<{ templateRef: { templateId: string }; outcome: string }>;
    expect(reportItems).toHaveLength(4); // every named templateRef reported, exactly once
    expect(reportItems.filter((i) => i.outcome === "verified")).toHaveLength(3);
    expect(reportItems.filter((i) => i.outcome === "target_fetch_failed")).toHaveLength(1);

    // ------------------------------------------------------------------------------------------
    // CHECKPOINTING: retry compile+preview and apply with the SAME (unchanged) run. The three
    // already-successful items must NOT be re-rendered, re-minted, re-published, or re-verified —
    // only the persisted failure is re-attempted (and fails the same honest way again).
    // ------------------------------------------------------------------------------------------
    const previewCallsBeforeRetry = previewCalls.length;
    const createCallsBeforeRetry = createCalls;
    const publishCallsBeforeRetry = publishCalls;
    const verifyCallsBeforeRetry = verifyCalls.length;

    const retriedPreview = await runCloneStage({ run, node: nodesById.get("image_revision_compile_preview")!, stage: "image_revision_compile_preview" });
    expect(retriedPreview.kind).toBe("completed");
    if (retriedPreview.kind !== "completed") return;
    expect(previewCalls.length).toBe(previewCallsBeforeRetry); // NOT re-rendered
    run.stageOutputs.image_revision_compile_preview = retriedPreview.output;

    const retriedApply = await runCloneStage({ run, node: nodesById.get("image_revision_apply")!, stage: "image_revision_apply" });
    expect(retriedApply.kind).toBe("completed");
    if (retriedApply.kind !== "completed") return;
    expect(createCalls).toBe(createCallsBeforeRetry); // NOT re-minted
    expect(publishCalls).toBe(publishCallsBeforeRetry); // NOT re-published
    expect(verifyCalls.length).toBe(verifyCallsBeforeRetry); // NOT re-verified
    const retriedItems = retriedApply.output.items as Array<{ outcome: string }>;
    expect(retriedItems.filter((i) => i.outcome === "verified")).toHaveLength(3); // still 3, carried forward verbatim
  });

  it("the apply stage refuses to run when the project is not publish-enabled — the SAME kill switch the PDF branches use, never bypassed for this operation", async () => {
    await seedLibrary();
    installFetchDouble();
    const run = baseRun();
    const intakeOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_intake")!, stage: "image_revision_intake" });
    if (intakeOutcome.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_intake = intakeOutcome.output;
    const previewOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_compile_preview")!, stage: "image_revision_compile_preview" });
    if (previewOutcome.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_compile_preview = previewOutcome.output;

    process.env[PUBLISH_ENABLED_ENV_VAR] = "false"; // the operator kill switch, explicit and independent of autonomyMode
    const applyOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_apply")!, stage: "image_revision_apply" });
    expect(applyOutcome.kind).toBe("refused");
    expect(createCalls).toBe(0); // nothing was minted — no production publication happened
    expect(publishCalls).toBe(0);
  });

  // A10-D1 (image half) — operationWorkflowBindings.ts's image_template_revision binding carries a
  // deliberately-empty inputMapping (see that file's own comment, and bindingInputContract.ts's new
  // open_schema_no_guaranteed_input check), so a run dispatched WITHOUT the caller itself having
  // constructed an imageTemplateRevisionBrief must refuse at image_revision_intake — never fall
  // through to imageRevisionIntakeStep's own "no brief" branch, which silently returns `items: []`
  // and let every later stage complete on an empty intake (the terminal report used to read "0 of 0"
  // succeeded, partial:false, allFailed:false: a silent no-op dressed as full success).
  it("A10-D1 — image_revision_intake REFUSES when initialInput carries no imageTemplateRevisionBrief, rather than completing an empty intake", async () => {
    await seedLibrary();
    const run = {
      projectId: TARGET,
      workflowId: IMAGE_TEMPLATE_REVISION_WORKFLOW_ID,
      initialInput: { targetProjectId: TARGET }, // no imageTemplateRevisionBrief — e.g. the operation's own flat fields only
      publishingPolicySnapshot: { autonomyMode: "autonomous" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID).publishableTypes },
      stageOutputs: {}
    } as unknown as WorkflowExecutionRecord;
    const outcome = await runCloneStage({ run, node: nodesById.get("image_revision_intake")!, stage: "image_revision_intake" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("image_template_revision_brief_missing");
  });

  it("A10-D1 — image_revision_intake still completes normally when a real imageTemplateRevisionBrief IS present (the refusal above is narrowly targeted, not a new blanket block)", async () => {
    await seedLibrary();
    const run = baseRun();
    const outcome = await runCloneStage({ run, node: nodesById.get("image_revision_intake")!, stage: "image_revision_intake" });
    expect(outcome.kind).toBe("completed");
  });

  // A10-D3 — optimistic concurrency: a colleague (or another run) publishes a new library version of
  // one target template AFTER intake read it but BEFORE this run's apply stage executes. Before this
  // fix, apply always recompiled from intake's own (now-stale) `current.recipe` and minted the next
  // version from it unconditionally — the colleague's v2 edit was silently overwritten/orphaned and
  // the item was reported "verified". Now: refused, named, per-item — the other, unaffected items
  // still proceed and are still verified.
  it("A10-D3 — apply refuses a single item, named, when its target library version moved between intake and apply; unaffected items still proceed to verified", async () => {
    await seedLibrary();
    installFetchDouble();
    const run = baseRun();

    const intakeOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_intake")!, stage: "image_revision_intake" });
    if (intakeOutcome.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_intake = intakeOutcome.output;

    const previewOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_compile_preview")!, stage: "image_revision_compile_preview" });
    if (previewOutcome.kind !== "completed") throw new Error("fixture setup failed");
    run.stageOutputs.image_revision_compile_preview = previewOutcome.output;

    // Simulate a concurrent, out-of-band edit: someone else publishes v2 of "newsletter" directly to
    // the SAME library store this run will re-read at apply time — before this run's own apply call.
    const concurrentStore = new TemplateLibraryStore();
    await concurrentStore.publish({
      templateId: `${TARGET}::pdf_template::newsletter`,
      objectType: "pdf_template",
      name: "Zilberman Newsletter (concurrent edit)",
      // Content must genuinely differ from seedLibrary's original (an extra field on page 1) — the
      // library's own publish() treats an identical-content deposit as a no-op ("unchanged", same
      // version), which would defeat this fixture's purpose of actually minting a real v2.
      recipe: { schemas: [[...pdfmePage(20), { name: "concurrent_addition", type: "text", position: { x: 5, y: 5 } }], pdfmePage(30), pdfmePage(500)] },
      sourceProjectId: TARGET,
      provenance: { sourceUrl: "https://zilberman.example/templates/newsletter", driven: "demand" }
    });

    const applyOutcome = await runCloneStage({ run, node: nodesById.get("image_revision_apply")!, stage: "image_revision_apply" });
    expect(applyOutcome.kind).toBe("completed");
    if (applyOutcome.kind !== "completed") return;
    const applyItems = applyOutcome.output.items as Array<{ templateRef: { templateId: string }; outcome: string; detail?: string }>;
    const newsletterItem = applyItems.find((i) => i.templateRef.templateId.endsWith("newsletter"))!;
    expect(newsletterItem.outcome).toBe("concurrent_modification");
    expect(newsletterItem.detail).toMatch(/moved from v1.*v2/);
    // The colleague's v2 edit is untouched — never overwritten by a mint from the stale v1 recipe.
    const latestAfter = await concurrentStore.getLatest(`${TARGET}::pdf_template::newsletter`);
    expect(latestAfter?.version).toBe(2);
    expect(latestAfter?.name).toBe("Zilberman Newsletter (concurrent edit)");
    // The OTHER items, whose targets did NOT move, still proceed normally.
    expect(applyItems.filter((i) => i.outcome === "verified")).toHaveLength(2); // flyer, order-form
    expect(createCalls).toBe(2); // newsletter was never (re-)minted
  });
});
