import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkflowDefinition, listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import { PDF_TEMPLATE_STUDIO_WORKFLOW_ID } from "../../../src/agent/workspace/pdfTemplateStudioWorkflow.js";
import { listPdfTemplateStudioNodes, PDF_TEMPLATE_STUDIO_AI_NODE_IDS } from "../../../src/agent/workspace/pdfTemplateStudioNodes.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { resolveExecutionKind, resolveRouteId, routeRequiredToolsFor, phaseTimeoutMsFor } from "../../../src/agent/workspace/routeRegistry.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { PDF_TEMPLATE_ARTIFACTS } from "../../../src/agent/capture/pdfTemplateEngine.js";
import { PDF_FAMILY_ARTIFACTS } from "../../../src/agent/capture/pdfTemplateFamilyEngine.js";
import { getOperationWorkflowBinding, UNBOUND_OPERATION_IMPLEMENTING_TASK } from "../../../src/agent/operations/operationWorkflowBindings.js";
import "../../../src/agent/operations/registerOperations.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// A7 — the standalone PDF template studio, wiring level. Maps onto the task's stated requirements:
//   * "registered in the workflow registry and expose its effective skills, tools and routes" —
//     the "registration" and "route exposure" describe blocks.
//   * "wire pdf_template_family in the operation catalog to this workflow ... never pass an
//     operation name as a workflow id" — the "operation binding" describe block.
//   * "publish-before-validation must be structurally impossible" and "two separate steps" —
//     the "two-step publication" describe block, driving pdf_publish_only/pdf_library_deposit
//     directly through runCloneStage exactly as pdfTemplateWorkspace.test.ts drives the base
//     branch's own stages.

const TARGET = "zilberman-pdf-template-studio";

describe("pdf_template_studio — registered in the workflow registry", () => {
  it("is registered, distinct from clone_conductor, and never silently falls back to publishing_conductor", () => {
    expect(listRegisteredWorkflowIds()).toContain(PDF_TEMPLATE_STUDIO_WORKFLOW_ID);
    expect(PDF_TEMPLATE_STUDIO_WORKFLOW_ID).toBe("pdf_template_studio");
    const definition = getWorkflowDefinition(PDF_TEMPLATE_STUDIO_WORKFLOW_ID);
    expect(definition).toBeDefined();
    const nodeIds = definition?.canonicalNodes().map((node) => node.id);
    expect(nodeIds).toEqual([
      "pdf_template_intake",
      "pdf_template_designer",
      "pdf_template_mint",
      "pdf_template_publish",
      "pdf_template_library_deposit",
      "pdf_template_family_report"
    ]);
  });

  it("listPdfTemplateStudioNodes returns a fresh, independently-mutable copy each call", () => {
    const first = listPdfTemplateStudioNodes();
    const second = listPdfTemplateStudioNodes();
    expect(first).not.toBe(second);
    first[0].dependsOn.push("mutated");
    expect(second[0].dependsOn).not.toContain("mutated");
  });

  it("carries exactly one AI-judgment node id — pdf_template_designer, reused verbatim; every other node is a deterministic clone-stage route", () => {
    expect(PDF_TEMPLATE_STUDIO_AI_NODE_IDS).toEqual(["pdf_template_designer"]);
    for (const node of listPdfTemplateStudioNodes()) {
      const kind = resolveExecutionKind(node);
      if ((PDF_TEMPLATE_STUDIO_AI_NODE_IDS as readonly string[]).includes(node.id)) {
        expect(kind).toBe("model");
      } else {
        expect(kind, `${node.id} should be a deterministic route`).toBe("deterministic");
      }
    }
  });

  it("never composes the shared CMS publishing tail — a pdf_template is not a CMS-publishable type", () => {
    const nodeIds = listPdfTemplateStudioNodes().map((node) => node.id);
    for (const tailNodeId of ["publish_payload", "publication_controller", "publish_executor", "release_executor"]) {
      expect(nodeIds).not.toContain(tailNodeId);
    }
  });
});

describe("pdf_template_studio — routes: every deterministic node's tool grant is discoverable through routeRegistry (node_get_effective_tools' own source)", () => {
  it("resolves every node's route id to clone_stage, and every new phase's required tools", () => {
    const byId = new Map(listPdfTemplateStudioNodes().map((node) => [node.id, node]));

    expect(resolveRouteId(byId.get("pdf_template_intake")!)).toBe("clone_stage");
    expect(routeRequiredToolsFor("clone_stage", "pdf_family_plan")).toEqual([]);

    expect(resolveRouteId(byId.get("pdf_template_mint")!)).toBe("clone_stage");
    expect(routeRequiredToolsFor("clone_stage", "pdf_mint_validated")?.map((tool) => tool.verb)).toEqual(["create_pdf_template", "validate_pdf_template", "get_pdf_template_validation"]);

    expect(resolveRouteId(byId.get("pdf_template_publish")!)).toBe("clone_stage");
    const publishTools = routeRequiredToolsFor("clone_stage", "pdf_publish_only");
    expect(publishTools?.map((tool) => tool.verb)).toEqual(["publish_pdf_template"]);
    expect(publishTools?.[0].risk).toBe("publish");

    expect(resolveRouteId(byId.get("pdf_template_library_deposit")!)).toBe("clone_stage");
    expect(routeRequiredToolsFor("clone_stage", "pdf_library_deposit")).toEqual([]);

    expect(resolveRouteId(byId.get("pdf_template_family_report")!)).toBe("clone_stage");
    expect(routeRequiredToolsFor("clone_stage", "pdf_family_report")).toEqual([]);

    // Every new phase has a timeout window, same as every existing clone_stage phase.
    for (const phaseId of ["pdf_family_plan", "pdf_mint_validated", "pdf_publish_only", "pdf_library_deposit", "pdf_family_report"]) {
      expect(phaseTimeoutMsFor("clone_stage", phaseId, byId.get("pdf_template_intake")!)).toBeGreaterThan(0);
    }
  });
});

describe("pdf_template_family (A2 catalog operation) is bound to pdf_template_studio — the workflow id, never the operation's own id", () => {
  it("resolves via getOperationWorkflowBinding, and is no longer listed as unbound", () => {
    const binding = getOperationWorkflowBinding("pdf_template_family");
    expect(binding).not.toBeNull();
    expect(binding?.workflowId).toBe(PDF_TEMPLATE_STUDIO_WORKFLOW_ID);
    expect(binding?.workflowId).not.toBe("pdf_template_family"); // never the operation id itself
    expect(UNBOUND_OPERATION_IMPLEMENTING_TASK.pdf_template_family).toBeUndefined();
  });
});

// ===================================================================================================
// TWO-STEP PUBLICATION — pdf_publish_only (STEP A, pdf-tool's own store) and pdf_library_deposit
// (STEP B, the cross-tenant library) driven directly through runCloneStage, mirroring
// pdfTemplateWorkspace.test.ts's own direct-stage-dispatch pattern.
// ===================================================================================================
describe("the studio's two-step publication: template-store publication and library export are separate steps, separately reported", () => {
  const nodesById = new Map(listPdfTemplateStudioNodes().map((node) => [node.id, node]));

  const mintEnvelope = () => ({
    artifact: PDF_TEMPLATE_ARTIFACTS.mint,
    summary: "fixture",
    siteId: "site_studio",
    applied: [
      {
        requestedId: "family-fall-appeal-newsletter",
        name: "Newsletter",
        renderer: "pdfme",
        templateId: "tpl_newsletter",
        version: 1,
        validated: true,
        tags: [],
        sourceUrl: "https://example.org/newsletter",
        templateJson: { schemas: [{ title: { type: "text" } }] }
      }
    ],
    rejected: [],
    contractRejected: []
  });

  const baseRun = (): WorkflowExecutionRecord =>
    ({
      projectId: TARGET,
      workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
      initialInput: { targetProjectId: TARGET },
      publishingPolicySnapshot: { autonomyMode: "autonomous" as const, publishEnabled: true, publishableTypes: resolvePublishableTypeCharter(PDF_TEMPLATE_STUDIO_WORKFLOW_ID).publishableTypes },
      stageOutputs: { pdf_template_mint: mintEnvelope() }
    }) as unknown as WorkflowExecutionRecord;

  beforeEach(async () => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    process.env.ZILBERMAN_PDF_TEMPLATE_STUDIO_MCP_ENDPOINT = `https://${TARGET}.example/mcp`;
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "PDF template studio fixture",
        mcpEndpointEnvVar: "ZILBERMAN_PDF_TEMPLATE_STUDIO_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "allowed"
      })
    );
    await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
  });
  afterEach(() => {
    delete process.env.ZILBERMAN_PDF_TEMPLATE_STUDIO_MCP_ENDPOINT;
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
  });

  it("STEP A (pdf_publish_only) publishes to pdf-tool's own store and its output carries no library field at all", async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string } };
      if (request.method !== "tools/call") return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: {} } }) } as unknown as Response;
      if (request.params?.name === "publish_pdf_template") {
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { published: true, activeVersion: 1 } } }) } as unknown as Response;
      }
      throw new Error(`Unexpected verb: ${request.params?.name}`);
    }) as unknown as typeof fetch;

    const run = baseRun();
    const outcome = await runCloneStage({ run, node: nodesById.get("pdf_template_publish")!, stage: "pdf_publish_only" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.artifact).toBe(PDF_TEMPLATE_ARTIFACTS.publish);
    expect((outcome.output.published as unknown[]).length).toBe(1);
    // STEP A never deposits — no "library" key at all on this stage's own output.
    expect(outcome.output.library).toBeUndefined();
  });

  it("STEP B (pdf_library_deposit) is its OWN node reading both pdf_template_mint and pdf_template_publish — never folded into STEP A's output", async () => {
    const run = baseRun();
    run.stageOutputs.pdf_template_publish = {
      artifact: PDF_TEMPLATE_ARTIFACTS.publish,
      published: [{ requestedId: "family-fall-appeal-newsletter", name: "Newsletter", templateId: "tpl_newsletter", version: 1 }],
      failed: []
    };
    const outcome = await runCloneStage({ run, node: nodesById.get("pdf_template_library_deposit")!, stage: "pdf_library_deposit" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.artifact).toBe(PDF_FAMILY_ARTIFACTS.libraryDeposit);
    expect(outcome.output.attempted).toBe(true);
    expect((outcome.output.deposited as unknown[]).length).toBe(1);
  });

  it("pdf_library_deposit refuses to run ahead of pdf_template_publish's own output — it never invents a publish result", async () => {
    const run = baseRun(); // stageOutputs carries pdf_template_mint but no pdf_template_publish at all
    const outcome = await runCloneStage({ run, node: nodesById.get("pdf_template_library_deposit")!, stage: "pdf_library_deposit" });
    expect(outcome.kind).toBe("refused");
  });

  it("pdf_family_report reads STEP A and STEP B back as two separate blocks, never merging them", async () => {
    const run = baseRun();
    run.stageOutputs.pdf_template_intake = {
      artifact: PDF_FAMILY_ARTIFACTS.plan,
      summary: "fixture",
      siteId: "site_studio",
      familyId: "fall-appeal",
      useCase: "nonprofit_standard",
      entries: [],
      rejectedEntries: [],
      entryVariants: { "family-fall-appeal-newsletter": "newsletter" },
      reused: [],
      revisedVariants: []
    };
    run.stageOutputs.pdf_template_publish = {
      artifact: PDF_TEMPLATE_ARTIFACTS.publish,
      published: [{ requestedId: "family-fall-appeal-newsletter", name: "Newsletter", templateId: "tpl_newsletter", version: 1 }],
      failed: []
    };
    run.stageOutputs.pdf_template_library_deposit = {
      artifact: PDF_FAMILY_ARTIFACTS.libraryDeposit,
      attempted: true,
      deposited: [{ templateId: `${TARGET}::pdf_template::family-fall-appeal-newsletter`, version: 1, objectId: "tpl_newsletter" }],
      unchanged: [],
      refused: []
    };
    const outcome = await runCloneStage({ run, node: nodesById.get("pdf_template_family_report")!, stage: "pdf_family_report" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.artifact).toBe(PDF_FAMILY_ARTIFACTS.report);
    expect((outcome.output.templateStorePublication as { published: unknown[] }).published).toHaveLength(1);
    expect((outcome.output.libraryExport as { attempted: boolean }).attempted).toBe(true);
    expect((outcome.output.variants as { outcome: string }[]).map((entry) => entry.outcome)).toEqual(["published"]);
    expect(outcome.output.allFailed).toBe(false);
    expect(outcome.output.partial).toBe(false);
  });
});

// ===================================================================================================
// A10-D1 — a chat-dispatched run (operationWorkflowBindings.ts's deliberately-empty
// pdf_template_family inputMapping — see that module's own A10-D1 comment) never constructs a nested
// pdfTemplateFamilyBrief. Before this fix, cloneConductorRoutes.ts's "pdf_family_plan" case fell
// through to pdfTemplateFamilyPlanStep, which silently returned an EMPTY plan (`entries: []`) rather
// than refusing — indistinguishable, downstream, from "a brief was supplied and legitimately named
// zero variants".
// ===================================================================================================
describe("A10-D1 — pdf_family_plan refuses (clone_source_missing's own shape) when initialInput carries no pdfTemplateFamilyBrief at all", () => {
  const nodesById = new Map(listPdfTemplateStudioNodes().map((node) => [node.id, node]));

  it("refuses with a named blocker instead of completing an empty plan", async () => {
    const run = {
      projectId: TARGET,
      workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
      // Exactly what Platform's chat dispatch sends today: the operation's own flat fields, never a
      // nested brief — see operationWorkflowBindings.ts's pdf_template_family binding.
      initialInput: { targetProjectId: TARGET, familyId: "nonprofit-core", useCase: "nonprofit" },
      stageOutputs: {}
    } as unknown as WorkflowExecutionRecord;

    const outcome = await runCloneStage({ run, node: nodesById.get("pdf_template_intake")!, stage: "pdf_family_plan" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("pdf_template_family_brief_missing");
    expect(outcome.message).toContain("pdfTemplateFamilyBrief");
    // Nothing was silently completed — no stage output to build a false "0 of 0 succeeded" report on.
    expect(run.stageOutputs.pdf_template_intake).toBeUndefined();
  });

  it("still completes normally once a real pdfTemplateFamilyBrief is present", async () => {
    const run = {
      projectId: TARGET,
      workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
      initialInput: { targetProjectId: TARGET, pdfTemplateFamilyBrief: { siteId: TARGET, familyId: "nonprofit-core", useCase: "nonprofit" } },
      stageOutputs: {}
    } as unknown as WorkflowExecutionRecord;
    const outcome = await runCloneStage({ run, node: nodesById.get("pdf_template_intake")!, stage: "pdf_family_plan" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.artifact).toBe(PDF_FAMILY_ARTIFACTS.plan);
  });
});

// ===================================================================================================
// A10-D5 — pdf_template_studio reuses four of clone_conductor's own node ids
// (pdf_template_intake/pdf_template_designer/pdf_template_mint/pdf_template_publish), and those four
// ids ALSO already exist in the shared workspace store (seeded from clone_conductor's own definition
// — workspaceStoreNodes.ts does not include pdfTemplateStudioNodes.ts at all). In store mode (the
// default), resolveConductorNodes used to let the STORED (clone's) metadata.cloneStageDeterministic
// win over the studio's own canonical value, so a pdf_template_studio run actually dispatched
// clone_conductor's OWN "pdf_intake"/"pdf_mint"/"pdf_publish" stages. See executor.ts's
// overlayStoreNode / pinRouteMetadataToCanonical for the fix.
// ===================================================================================================
describe("A10-D5 — resolveConductorNodes hands pdf_template_studio its OWN route keys, not clone_conductor's", () => {
  beforeEach(async () => {
    resetRepositoryManager();
    await repositoryManager.getWorkspaceRepository().ensureWorkspaceNodeSeeds();
  });
  afterEach(() => resetRepositoryManager());

  it("the four id-colliding nodes resolve to the studio's own stage names in STORE mode (the default), even though the store's only row for each id is clone_conductor's", async () => {
    const { resolveConductorNodes } = await import("../../../src/agent/workspace/executor.js");
    const resolved = new Map(
      (await resolveConductorNodes(repositoryManager.getWorkspaceRepository(), PDF_TEMPLATE_STUDIO_WORKFLOW_ID)).map((node) => [node.id, node])
    );
    expect(resolved.get("pdf_template_intake")?.metadata?.cloneStageDeterministic).toBe("pdf_family_plan");
    expect(resolved.get("pdf_template_mint")?.metadata?.cloneStageDeterministic).toBe("pdf_mint_validated");
    expect(resolved.get("pdf_template_publish")?.metadata?.cloneStageDeterministic).toBe("pdf_publish_only");
    // The two studio-only nodes (no store row at all) are unaffected either way.
    expect(resolved.get("pdf_template_library_deposit")?.metadata?.cloneStageDeterministic).toBe("pdf_library_deposit");
    expect(resolved.get("pdf_template_family_report")?.metadata?.cloneStageDeterministic).toBe("pdf_family_report");
  });

  it("the consequence, end to end: a family run's brief actually reaches the plan step through resolveConductorNodes's OWN resolved node, not the canonical literal", async () => {
    const { resolveConductorNodes } = await import("../../../src/agent/workspace/executor.js");
    const resolved = new Map(
      (await resolveConductorNodes(repositoryManager.getWorkspaceRepository(), PDF_TEMPLATE_STUDIO_WORKFLOW_ID)).map((node) => [node.id, node])
    );
    const run = {
      projectId: TARGET,
      workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
      initialInput: { targetProjectId: TARGET, pdfTemplateFamilyBrief: { siteId: TARGET, familyId: "nonprofit-core", useCase: "nonprofit" } },
      stageOutputs: {}
    } as unknown as WorkflowExecutionRecord;
    const intakeNode = resolved.get("pdf_template_intake")!;
    const outcome = await runCloneStage({ run, node: intakeNode, stage: intakeNode.metadata!.cloneStageDeterministic as never });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    // Clone's own "pdf_intake" stage would have produced an envelope with none of these fields, and
    // its own PDF_TEMPLATE_ARTIFACTS.intake artifact — now a DISTINCT string from the family plan's
    // (see pdfTemplateEngine.ts's PDF_TEMPLATE_ARTIFACTS.familyIntake comment, A10-D5).
    expect(outcome.output.artifact).toBe(PDF_FAMILY_ARTIFACTS.plan);
    expect(outcome.output).toHaveProperty("familyId", "nonprofit-core");
    expect(outcome.output).toHaveProperty("entryVariants");
  });

  it("the overlay rule, unit-level: a route-selecting metadata key is pinned to canonical, never won by a stored row", async () => {
    const { __test__ } = await import("../../../src/agent/workspace/executor.js");
    const merged = __test__.overlayStoreNode(
      { id: "n", metadata: { cloneStageDeterministic: "pdf_family_plan", skipWhen: [] } } as never,
      { id: "n", metadata: { cloneStageDeterministic: "pdf_intake" } } as never
    );
    expect(merged.metadata?.cloneStageDeterministic).toBe("pdf_family_plan");
  });
});
