import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { getOperation } from "../../../src/agent/operations/operationCatalog.js";
import { getOperationWorkflowBinding, resolveBindingInputContract } from "../../../src/agent/operations/operationWorkflowBindings.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { listImageTemplateRevisionNodes } from "../../../src/agent/workspace/imageTemplateRevisionNodes.js";
import { listPdfTemplateStudioNodes } from "../../../src/agent/workspace/pdfTemplateStudioNodes.js";
import { IMAGE_TEMPLATE_REVISION_WORKFLOW_ID } from "../../../src/agent/workspace/imageTemplateRevisionWorkflow.js";
import { PDF_TEMPLATE_STUDIO_WORKFLOW_ID } from "../../../src/agent/workspace/pdfTemplateStudioWorkflow.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
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
import { PDF_FAMILY_ARTIFACTS } from "../../../src/agent/capture/pdfTemplateFamilyEngine.js";
import { setImageTemplateRevisionProviders, resetImageTemplateRevisionProviders } from "../../../src/agent/workspace/imageTemplateRevisionProviders.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// =================================================================================================
// A10 — the independent end-to-end review's own integration tests.
//
// Everything in this file is OFFLINE: pdf-tool is a fetch double, the asset catalogue / preview /
// verify seams are fixture doubles, and no live tenant, renderer, publish or release path is ever
// touched. Nothing here asserts live media generation.
//
// The existing A7/A9 suites drive their stages with a HAND-BUILT
// `initialInput.pdfTemplateFamilyBrief` / `initialInput.imageTemplateRevisionBrief`. No test on
// either side of the repo boundary has ever driven them with the input a signed-in Platform chat
// actually sends. Section 1 closes that hole; sections 2-8 inject A10's named faults.
// =================================================================================================

const TARGET = "zilberman-a10-integration";
const MCP_ENV_VAR = "ZILBERMAN_A10_INTEGRATION_MCP_ENDPOINT";
const PUBLISH_ENABLED_ENV_VAR = "ZILBERMAN_A10_INTEGRATION_PUBLISH_ENABLED";

// -------------------------------------------------------------------------------------------------
// A faithful, local re-implementation of Platform's `resolveCatalogOperation` input construction
// (platform packages/core/server/lib/agent/tools.ts, the workflow branch): appliedDefaults, then the
// model's own input, then the binding's inputMapping rename, then tenantId forced LAST under the
// mapped scope key. Re-implemented here rather than imported because the two repos do not share a
// package — if Platform's algorithm changes, THIS is the mirror that has to change with it.
// -------------------------------------------------------------------------------------------------
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

// -------------------------------------------------------------------------------------------------
// Shared fixture: three multi-page pdfme templates in the cross-tenant library, one tagged source
// asset, recording doubles for preview/verify and for pdf-tool's wire.
// -------------------------------------------------------------------------------------------------
const HERO: ResolvedSourceAsset = {
  assetId: "asset_a10_hero",
  checksum: "sha256-a10-hero",
  tags: ["a10-hero"],
  widthPx: 800,
  heightPx: 400,
  reference: "asset://a10-hero/v1",
  provenance: { captureRequestId: "capreq_a10_1" }
};

const templateRef = (requestedId: string) => ({ surface: "pdf" as const, templateId: `${TARGET}::pdf_template::${requestedId}`, tenantId: TARGET });
const pdfmePage = (fieldY: number) => [{ name: `field_${fieldY}`, type: "text", position: { x: 20, y: fieldY } }];

const seedLibrary = async () => {
  const store = new TemplateLibraryStore();
  const seeds: Array<[string, unknown[]]> = [
    ["newsletter", [pdfmePage(20), pdfmePage(30), pdfmePage(500)]],
    ["flyer", [pdfmePage(10), pdfmePage(10)]],
    ["order-form", [pdfmePage(700), pdfmePage(700), pdfmePage(700), pdfmePage(700)]]
  ];
  for (const [requestedId, pages] of seeds) {
    await store.publish({
      templateId: `${TARGET}::pdf_template::${requestedId}`,
      objectType: "pdf_template",
      name: requestedId,
      recipe: { schemas: pages },
      sourceProjectId: TARGET,
      provenance: { sourceUrl: `https://a10.example/templates/${requestedId}`, driven: "demand" }
    });
  }
  return store;
};

const assetCatalog: AssetCatalogSource = {
  resolveByTag: async (tenantId, tag) => (tenantId === TARGET && tag === "a10-hero" ? [HERO] : []),
  resolveByChecksum: async () => undefined,
  resolveByCaptureRequestId: async () => undefined
};

type WireCall = { verb: string; args: Record<string, unknown> };

let wire: WireCall[];
let previewCalls: string[];
let verifyCalls: string[];
/** verbs whose FIRST attempt should be failed with an "ambiguous" transport timeout */
let timeoutOnce: Set<string>;

const previewTemplateVariant: PreviewTemplateVariantFn = async (input) => {
  previewCalls.push(input.templateId);
  return { beforeRef: `preview://before/${input.templateId}/v${input.beforeVersion}`, afterRef: `preview://after/${input.templateId}/v${input.beforeVersion}` };
};
const verifyImagePresence: VerifyImagePresenceFn = async (input) => {
  verifyCalls.push(input.templateId);
  return { pagesWithImage: Array.from({ length: input.pageCount }, (_, index) => index), pagesMissingImage: [] };
};

const installFetchDouble = () => {
  let created = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const ok = (result: unknown) =>
      ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }) }) as unknown as Response;
    if (request.method !== "tools/call") return ok({});
    const verb = String(request.params?.name);
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    wire.push({ verb, args });
    // "Ambiguous create timeout": the server DID the work, the caller never learned the answer.
    if (timeoutOnce.has(verb)) {
      timeoutOnce.delete(verb);
      created += 1; // the server-side effect really happened
      throw new Error(`ETIMEDOUT calling ${verb} (the server may or may not have completed it)`);
    }
    if (verb === "create_pdf_template") {
      created += 1;
      return ok({ templateId: `pdftool_internal_${created}`, version: 1 });
    }
    if (verb === "publish_pdf_template") return ok({ published: true, activeVersion: 1 });
    throw new Error(`Unexpected verb in this fixture: ${verb}`);
  }) as unknown as typeof fetch;
};

const imageNodes = new Map(listImageTemplateRevisionNodes().map((node) => [node.id, node]));
const pdfNodes = new Map(listPdfTemplateStudioNodes().map((node) => [node.id, node]));

const runWith = (initialInput: Record<string, unknown>, workflowId: string): WorkflowExecutionRecord =>
  ({
    projectId: TARGET,
    workflowId,
    initialInput,
    publishingPolicySnapshot: { autonomyMode: "autonomous" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter(workflowId).publishableTypes },
    stageOutputs: {}
  }) as unknown as WorkflowExecutionRecord;

const briefRun = (over: Record<string, unknown> = {}) =>
  runWith(
    {
      targetProjectId: TARGET,
      imageTemplateRevisionBrief: {
        tenantId: TARGET,
        sourceAsset: { tag: "a10-hero" },
        templateRefs: [templateRef("newsletter"), templateRef("flyer"), templateRef("order-form")],
        approve: true,
        ...over
      }
    },
    IMAGE_TEMPLATE_REVISION_WORKFLOW_ID
  );

const stage = async (run: WorkflowExecutionRecord, nodeId: string, stageId: string) => {
  const node = imageNodes.get(nodeId) ?? pdfNodes.get(nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  const outcome = await runCloneStage({ run, node, stage: stageId as never });
  if (outcome.kind === "completed") run.stageOutputs[nodeId] = outcome.output;
  return outcome;
};

const runImagePipeline = async (run: WorkflowExecutionRecord) => {
  await stage(run, "image_revision_intake", "image_revision_intake");
  await stage(run, "image_revision_compile_preview", "image_revision_compile_preview");
  const applied = await stage(run, "image_revision_apply", "image_revision_apply");
  const report = await stage(run, "image_revision_report", "image_revision_report");
  return { applied, report };
};

beforeEach(async () => {
  resetRepositoryManager();
  resetTemplateLibraryMemoryStore();
  wire = [];
  previewCalls = [];
  verifyCalls = [];
  timeoutOnce = new Set();
  process.env[MCP_ENV_VAR] = `https://${TARGET}.example/mcp`;
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "A10 integration fixture", mcpEndpointEnvVar: MCP_ENV_VAR, authMode: "none", defaultToolPolicy: "allowed" })
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

// =================================================================================================
// 1. THE TRACE — what a signed-in Platform chat actually dispatches.
//
// DEFECT PINNED (A10-D1). Both A7's and A9's bindings carry an EMPTY inputMapping and their entry
// nodes declare the permissive `openInput` schema, so R1c's binding-input-contract check reports
// `satisfied: true` and preflight reports `executable: true`. Platform therefore dispatches the
// operation's own FLAT fields (tenantId/templateRefs/batchSize) as the run's initialInput — but the
// entry node reads a NESTED `initialInput.imageTemplateRevisionBrief`, which nothing on either side
// of the boundary ever constructs. The run does not fail: every stage "completes" on an empty
// envelope and the terminal report names ZERO items with partial=false and allFailed=false.
//
// These tests CHARACTERIZE that behaviour. When the missing executor lands, they must be inverted
// (assert real items), not deleted.
// =================================================================================================
describe("A10-D1 — the input a signed-in Platform chat dispatches never reaches the workflow's brief", () => {
  it("image_template_revision: R1c reports the binding contract SATISFIED even though the entry node can never receive a brief", () => {
    const binding = getOperationWorkflowBinding("image_template_revision")!;
    expect(binding.inputMapping).toEqual({});
    // The green light Platform reads.
    expect(resolveBindingInputContract(binding).contract?.satisfied).toBe(true);
    // ...and the flat keys it therefore dispatches. `imageTemplateRevisionBrief` is not among them.
    const { workflowId, input } = platformDispatchInput("image_template_revision", { templateRefs: [templateRef("newsletter")] }, TARGET);
    expect(workflowId).toBe(IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
    expect(Object.keys(input)).not.toContain("imageTemplateRevisionBrief");
    expect(input.tenantId).toBe(TARGET);
  });

  it("image_template_revision: the chat-dispatched run completes all four stages and reports ZERO items — a silent no-op, not a refusal", async () => {
    await seedLibrary();
    const { workflowId, input } = platformDispatchInput("image_template_revision", { templateRefs: [templateRef("newsletter"), templateRef("flyer")] }, TARGET);
    const run = runWith({ ...input, targetProjectId: TARGET }, workflowId);

    const { report } = await runImagePipeline(run);
    expect(report.kind).toBe("completed"); // never blocked, never refused
    if (report.kind !== "completed") return;

    expect(report.output.artifact).toBe(IMAGE_REVISION_ARTIFACTS.report);
    expect(report.output.items).toEqual([]); // the two templateRefs the editor named are simply gone
    // THE DISHONEST BIT: neither flag marks this as a non-result.
    expect(report.output.partial).toBe(false);
    expect(report.output.allFailed).toBe(false);
    expect(String(report.output.summary)).toContain("0 item(s) succeeded, 0 failed, of 0 named");

    // Nothing was attempted anywhere: no preview, no pdf-tool call, no library write.
    expect(previewCalls).toEqual([]);
    expect(wire).toEqual([]);
    const store = new TemplateLibraryStore();
    expect((await store.getLatest(`${TARGET}::pdf_template::newsletter`))?.version).toBe(1);

    // The only trace of the failure is prose on the intake envelope — no code, no blocker, nothing a
    // projection or a caller can branch on.
    const intake = run.stageOutputs.image_revision_intake as Record<string, unknown>;
    expect(String(intake.summary)).toContain("No imageTemplateRevisionBrief");
    expect(intake.sourceAssetError).toBeNull();
  });

  it("pdf_template_family (A7): the same hole — the chat-dispatched run's intake yields an empty family, not a refusal", async () => {
    const { workflowId, input } = platformDispatchInput("pdf_template_family", { familyId: "nonprofit-core" }, TARGET);
    expect(workflowId).toBe(PDF_TEMPLATE_STUDIO_WORKFLOW_ID);
    expect(Object.keys(input)).not.toContain("pdfTemplateFamilyBrief");

    const run = runWith({ ...input, targetProjectId: TARGET }, workflowId);
    const intake = await stage(run, "pdf_template_intake", "pdf_family_plan");
    expect(intake.kind).toBe("completed");
    if (intake.kind !== "completed") return;
    expect(intake.output.artifact).toBe(PDF_FAMILY_ARTIFACTS.plan);
    expect(intake.output.entries).toEqual([]);
    expect(String(intake.output.summary)).toContain("No pdfTemplateFamilyBrief");
  });
});

// =================================================================================================
// 2. FAULT: an unavailable renderer / preview seam (the PRODUCTION default — neither
//    previewTemplateVariant nor verifyImagePresence is wired to Platform today).
// =================================================================================================
describe("fault: unavailable renderer", () => {
  it("no previewTemplateVariant: every item is preview_failed with a NAMED reason, nothing is minted, and the report says allFailed", async () => {
    await seedLibrary();
    setImageTemplateRevisionProviders({ assetCatalog }); // production's real default: no preview, no verify
    const run = briefRun();
    const { report } = await runImagePipeline(run);
    expect(report.kind).toBe("completed");
    if (report.kind !== "completed") return;

    const items = report.output.items as Array<{ outcome: string; detail?: string }>;
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.outcome === "preview_failed")).toBe(true);
    expect(items[0].detail).toContain("No previewTemplateVariant dependency was supplied");
    expect(report.output.allFailed).toBe(true);
    // Safe compensation: an un-previewable edit is never minted or published.
    expect(wire).toEqual([]);
  });

  it("preview available but no verifyImagePresence: the new version IS published and then reported verify_failed — honest, but NOT compensated", async () => {
    await seedLibrary();
    setImageTemplateRevisionProviders({ assetCatalog, previewTemplateVariant });
    const run = briefRun();
    const { report } = await runImagePipeline(run);
    expect(report.kind).toBe("completed");
    if (report.kind !== "completed") return;

    const items = report.output.items as Array<{ outcome: string; detail?: string; afterVersion?: number }>;
    expect(items.every((item) => item.outcome === "verify_failed")).toBe(true);
    expect(items[0].detail).toContain("No verifyImagePresence dependency was supplied");
    expect(report.output.allFailed).toBe(true); // the RUN is honest about not having verified

    // ...but the side effect is real and permanent: v2 of every template is live in the library and
    // published to pdf-tool, with no rollback and no quarantine. A10's "safe compensation" is NOT
    // met on this path — pinned here so the gap cannot be closed silently.
    expect(wire.filter((call) => call.verb === "publish_pdf_template")).toHaveLength(3);
    const store = new TemplateLibraryStore();
    expect((await store.getLatest(`${TARGET}::pdf_template::newsletter`))?.version).toBe(2);
  });
});

// =================================================================================================
// 3. FAULT: the asset catalogue is not configured at all (the production default).
//    A5's acceptance: "forbidden/unavailable is not 'none found'". It currently IS.
// =================================================================================================
describe("A10-D2 — an unconfigured asset catalogue is reported as 'no such asset'", () => {
  it("the default provider's empty answer is indistinguishable from a genuinely absent tag", async () => {
    await seedLibrary();
    resetImageTemplateRevisionProviders(); // exactly what a live run with no wiring gets
    const run = briefRun();
    await stage(run, "image_revision_intake", "image_revision_intake");
    const intake = run.stageOutputs.image_revision_intake as Record<string, unknown>;
    const error = intake.sourceAssetError as { code: string; reason: string };
    // "not configured" is reported with the SAME code and the SAME prose as a real miss.
    expect(error.code).toBe("image_revision_source_tag_not_found");
    expect(error.reason).toContain('No asset tagged "a10-hero"');
    expect(error.reason).not.toMatch(/configur/i);

    const { report } = await runImagePipeline(run);
    if (report.kind !== "completed") throw new Error("expected a completed report");
    const items = report.output.items as Array<{ outcome: string }>;
    expect(items.every((item) => item.outcome === "source_resolve_failed")).toBe(true);
  });
});

// =================================================================================================
// 4. FAULT: a stale revision. A third party publishes a new library version between intake and
//    apply. Nothing re-reads it; the revision is minted from the version intake captured.
// =================================================================================================
describe("A10-D3 — a concurrent library version is silently overwritten by the apply stage", () => {
  it("apply mints from the recipe intake read, discarding the version published in between", async () => {
    const store = await seedLibrary();
    const run = briefRun({ templateRefs: [templateRef("newsletter")] });
    await stage(run, "image_revision_intake", "image_revision_intake");
    await stage(run, "image_revision_compile_preview", "image_revision_compile_preview");

    // Someone else revises the same template while this run is mid-flight.
    await store.publish({
      templateId: `${TARGET}::pdf_template::newsletter`,
      objectType: "pdf_template",
      name: "newsletter",
      recipe: { schemas: [pdfmePage(20), pdfmePage(30), pdfmePage(500)], concurrentEdit: "added-by-someone-else" },
      sourceProjectId: TARGET,
      provenance: { sourceUrl: "https://a10.example/templates/newsletter", driven: "demand" }
    });
    expect((await store.getLatest(`${TARGET}::pdf_template::newsletter`))?.version).toBe(2);

    const applied = await stage(run, "image_revision_apply", "image_revision_apply");
    expect(applied.kind).toBe("completed");
    if (applied.kind !== "completed") return;
    const items = applied.output.items as Array<{ outcome: string; afterVersion?: number }>;
    // No staleness is detected: the item is reported VERIFIED.
    expect(items[0].outcome).toBe("verified");

    const latest = await store.getLatest(`${TARGET}::pdf_template::newsletter`);
    expect(latest?.version).toBe(3);
    // THE LOST UPDATE: v3 was built on v1's recipe, so the concurrent edit is gone from latest.
    expect(Object.keys(latest!.recipe)).not.toContain("concurrentEdit");
  });
});

// =================================================================================================
// 5. FAULT: an ambiguous create timeout — pdf-tool completed create_pdf_template but the answer
//    never came back. Duplicate prevention here is a WIRE-LEVEL idempotency key, not a local guard.
// =================================================================================================
describe("fault: ambiguous create timeout", () => {
  it("the timed-out item is reported mint_rejected (never success), and the retry re-sends the IDENTICAL idempotencyKey", async () => {
    await seedLibrary();
    const run = briefRun({ templateRefs: [templateRef("newsletter")] });
    await stage(run, "image_revision_intake", "image_revision_intake");
    await stage(run, "image_revision_compile_preview", "image_revision_compile_preview");

    timeoutOnce.add("create_pdf_template");
    const first = await stage(run, "image_revision_apply", "image_revision_apply");
    expect(first.kind).toBe("completed");
    if (first.kind !== "completed") return;
    const firstItems = first.output.items as Array<{ outcome: string; detail?: string }>;
    expect(firstItems[0].outcome).toBe("mint_rejected");
    // NOTE (minor finding): an AMBIGUOUS timeout is reported as a definite non-reach
    // ("failed to reach the project MCP endpoint... variables may be unset"), which is the wrong
    // diagnosis for a call the server may well have completed.
    expect(firstItems[0].detail).toContain("client_unreachable");
    // Nothing was published and no library version landed off an unknown create.
    expect(wire.filter((call) => call.verb === "publish_pdf_template")).toHaveLength(0);
    const store = new TemplateLibraryStore();
    expect((await store.getLatest(`${TARGET}::pdf_template::newsletter`))?.version).toBe(1);

    const createsAfterFirst = wire.filter((call) => call.verb === "create_pdf_template");
    const firstKey = createsAfterFirst[0].args.idempotency_key;
    expect(typeof firstKey).toBe("string");

    // Retry the same stage — this is the only duplicate protection the path has.
    const second = await stage(run, "image_revision_apply", "image_revision_apply");
    expect(second.kind).toBe("completed");
    const creates = wire.filter((call) => call.verb === "create_pdf_template");
    expect(creates.length).toBeGreaterThan(createsAfterFirst.length);
    // Same content -> same key on EVERY attempt, so pdf-tool can collapse them into one template.
    expect(new Set(creates.map((call) => call.args.idempotency_key)).size).toBe(1);
    expect(creates[creates.length - 1].args.idempotency_key).toBe(firstKey);
  });
});

// =================================================================================================
// 6. FAULT: a process restart between stages. The run is reloaded from its persisted stage outputs
//    (JSON round-trip, exactly what a store read produces) — nothing in-memory survives.
// =================================================================================================
describe("fault: process restart", () => {
  it("a verified item is carried forward from the persisted stage output — never re-minted, re-published or re-verified", async () => {
    await seedLibrary();
    const run = briefRun();
    await runImagePipeline(run);
    const createsBefore = wire.filter((call) => call.verb === "create_pdf_template").length;
    const publishesBefore = wire.filter((call) => call.verb === "publish_pdf_template").length;
    const verifiesBefore = verifyCalls.length;
    expect(createsBefore).toBe(3);

    // "Restart": a brand new run object holding only what was persisted.
    const reloaded = runWith(JSON.parse(JSON.stringify(run.initialInput)) as Record<string, unknown>, IMAGE_TEMPLATE_REVISION_WORKFLOW_ID);
    reloaded.stageOutputs = JSON.parse(JSON.stringify(run.stageOutputs)) as Record<string, Record<string, unknown>>;

    const applied = await stage(reloaded, "image_revision_apply", "image_revision_apply");
    expect(applied.kind).toBe("completed");
    if (applied.kind !== "completed") return;
    const items = applied.output.items as Array<{ outcome: string }>;
    expect(items.filter((item) => item.outcome === "verified")).toHaveLength(3);
    expect(wire.filter((call) => call.verb === "create_pdf_template")).toHaveLength(createsBefore);
    expect(wire.filter((call) => call.verb === "publish_pdf_template")).toHaveLength(publishesBefore);
    expect(verifyCalls).toHaveLength(verifiesBefore);

    const store = new TemplateLibraryStore();
    expect((await store.getLatest(`${TARGET}::pdf_template::newsletter`))?.version).toBe(2); // not 3
  });
});

// =================================================================================================
// 7. FAULT: a permission hold. Two shapes: the operator kill switch (stage refuses, run blocks) and
//    an approval that simply was not given (stage completes, items are `not_approved`).
// =================================================================================================
describe("fault: permission hold", () => {
  it("the publish kill switch refuses the apply stage before any mint — nothing is created or published", async () => {
    await seedLibrary();
    const run = briefRun();
    await stage(run, "image_revision_intake", "image_revision_intake");
    await stage(run, "image_revision_compile_preview", "image_revision_compile_preview");
    process.env[PUBLISH_ENABLED_ENV_VAR] = "false";
    const applied = await runCloneStage({ run, node: imageNodes.get("image_revision_apply")!, stage: "image_revision_apply" });
    expect(applied.kind).toBe("refused");
    if (applied.kind !== "refused") return;
    expect(applied.code).toBe("image_revision_publish_disabled");
    expect(wire).toEqual([]);
  });

  it("A10-D4: an unapproved item is counted as a SUCCESS by the terminal report — 'nothing was applied' reads as '3 succeeded, 0 failed'", async () => {
    await seedLibrary();
    const run = briefRun({ approve: false }); // previewed, authorised for nothing
    const { report } = await runImagePipeline(run);
    expect(report.kind).toBe("completed");
    if (report.kind !== "completed") return;

    const items = report.output.items as Array<{ outcome: string }>;
    expect(items.every((item) => item.outcome === "not_approved")).toBe(true);
    expect(wire).toEqual([]); // genuinely nothing happened

    // THE DEFECT: `not_approved` (and `previewed`) are in SUCCESS_OUTCOMES, so the ledger the
    // projection reads says the opposite of what happened.
    expect(String(report.output.summary)).toContain("3 item(s) succeeded, 0 failed, of 3 named");
    expect(report.output.partial).toBe(false);
    expect(report.output.allFailed).toBe(false);
  });
});

// =================================================================================================
// 8. FAULT: an expired lock — NOT COVERABLE, because no lock is ever taken. This test proves the
//    absence rather than asserting a vacuous pass: the whole write path issues exactly two verbs.
// =================================================================================================
describe("fault: expired lock", () => {
  it("the apply path takes no checkout/lock on anything it revises — there is no lock that could expire", async () => {
    await seedLibrary();
    const run = briefRun();
    await runImagePipeline(run);
    const verbs = [...new Set(wire.map((call) => call.verb))].sort();
    expect(verbs).toEqual(["create_pdf_template", "publish_pdf_template"]);
    for (const lockVerb of ["object_checkout", "object_checkin", "object_refresh_lock", "object_discard"]) {
      expect(verbs).not.toContain(lockVerb);
    }
  });
});
