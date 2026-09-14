import { beforeEach, describe, expect, it } from "vitest";
import { __test__, resolveConductorNodes } from "../../../src/agent/workspace/executor.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { PDF_TEMPLATE_STUDIO_WORKFLOW_ID } from "../../../src/agent/workspace/pdfTemplateStudioWorkflow.js";
import { listPdfTemplateStudioNodes } from "../../../src/agent/workspace/pdfTemplateStudioNodes.js";
import { workspaceStoreSeedNodes } from "../../../src/agent/workspace/workspaceStoreNodes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { PDF_FAMILY_ARTIFACTS } from "../../../src/agent/capture/pdfTemplateFamilyEngine.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// =================================================================================================
// A10-D5 — pdf_template_studio (A7) reuses four node ids clone_conductor already owns in the SHARED
// workspace store, and overlayStoreNode (executor.ts) lets a STORED metadata key WIN over the
// canonical one. In store mode — the DEFAULT (`WORKSPACE_NODES_SOURCE` unset, executor.ts's
// nodeSource()) — the studio therefore dispatches clone_conductor's stages
// (pdf_intake / pdf_mint / pdf_publish) instead of its own
// (pdf_family_plan / pdf_mint_validated / pdf_publish_only).
//
// Confirmed against the LIVE deployed service on 2026-09-14 via a read-only
// workspace.get_graph("pdf_template_studio"): its pdf_template_intake comes back with
// metadata.cloneStageDeterministic "pdf_intake" and updatedAt "2026-08-23", while the two nodes with
// NO clone counterpart (pdf_template_library_deposit, pdf_template_family_report) come back with
// A7's own "2026-09-14".
//
// No existing A7 test catches this, because every one of them drives runCloneStage with the
// CANONICAL node object rather than the one resolveConductorNodes hands the executor.
//
// This test CHARACTERIZES the defect. Invert it when the ids are separated (or metadata ownership is
// pinned canonical for route keys) — do not delete it.
// =================================================================================================
describe("A10-D5 — the deployed pdf_template_studio dispatches clone_conductor's stages, not its own", () => {
  beforeEach(async () => {
    resetRepositoryManager();
    await repositoryManager.getWorkspaceRepository().ensureWorkspaceNodeSeeds();
  });

  it("A7's studio nodes are not seeded into the shared store at all — but four of their ids already are, by clone_conductor", () => {
    const seededIds = new Set(workspaceStoreSeedNodes().map((node) => node.id));
    const studioIds = listPdfTemplateStudioNodes().map((node) => node.id);
    const collided = studioIds.filter((id) => seededIds.has(id));
    expect(collided).toEqual(["pdf_template_intake", "pdf_template_designer", "pdf_template_mint", "pdf_template_publish"]);
    // ...and the two that do NOT collide are exactly A7's own new nodes.
    expect(studioIds.filter((id) => !seededIds.has(id))).toEqual(["pdf_template_library_deposit", "pdf_template_family_report"]);
  });

  it("resolveConductorNodes hands the executor clone_conductor's route keys for those four nodes", async () => {
    const canonical = new Map(listPdfTemplateStudioNodes().map((node) => [node.id, node]));
    const resolved = new Map((await resolveConductorNodes(repositoryManager.getWorkspaceRepository(), PDF_TEMPLATE_STUDIO_WORKFLOW_ID)).map((node) => [node.id, node]));

    // What A7's code says, versus what a run actually gets.
    expect(canonical.get("pdf_template_intake")?.metadata?.cloneStageDeterministic).toBe("pdf_family_plan");
    expect(resolved.get("pdf_template_intake")?.metadata?.cloneStageDeterministic).toBe("pdf_intake");
    expect(canonical.get("pdf_template_mint")?.metadata?.cloneStageDeterministic).toBe("pdf_mint_validated");
    expect(resolved.get("pdf_template_mint")?.metadata?.cloneStageDeterministic).toBe("pdf_mint");
    expect(canonical.get("pdf_template_publish")?.metadata?.cloneStageDeterministic).toBe("pdf_publish_only");
    expect(resolved.get("pdf_template_publish")?.metadata?.cloneStageDeterministic).toBe("pdf_publish");

    // A7's own two new nodes are unaffected — no store row, so canonical shows through.
    expect(resolved.get("pdf_template_library_deposit")?.metadata?.cloneStageDeterministic).toBe("pdf_library_deposit");
    expect(resolved.get("pdf_template_family_report")?.metadata?.cloneStageDeterministic).toBe("pdf_family_report");
  });

  it("the consequence: the editor's family brief is silently discarded and the plan comes back empty", async () => {
    const resolved = new Map((await resolveConductorNodes(repositoryManager.getWorkspaceRepository(), PDF_TEMPLATE_STUDIO_WORKFLOW_ID)).map((node) => [node.id, node]));
    const run = {
      projectId: "a10-studio-collision",
      workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
      initialInput: { targetProjectId: "a10-studio-collision", pdfTemplateFamilyBrief: { siteId: "a10-studio-collision", familyId: "nonprofit-core", useCase: "nonprofit" } },
      stageOutputs: {}
    } as unknown as WorkflowExecutionRecord;

    const intakeNode = resolved.get("pdf_template_intake")!;
    const intake = await runCloneStage({ run, node: intakeNode, stage: intakeNode.metadata!.cloneStageDeterministic as never });
    expect(intake.kind).toBe("completed");
    if (intake.kind !== "completed") return;
    run.stageOutputs.pdf_template_intake = intake.output;

    // A7 REUSES clone's own artifact id for the family plan (PDF_FAMILY_ARTIFACTS.plan ===
    // "pdf_template_intake.v1"), so envelopeOf's artifact check — the ONE guard against building on a
    // wrong upstream envelope — cannot tell the two apart. The clone-shaped envelope carries none of
    // the family fields.
    expect(intake.output.artifact).toBe(PDF_FAMILY_ARTIFACTS.plan);
    expect(intake.output).not.toHaveProperty("familyId");
    expect(intake.output).not.toHaveProperty("entryVariants");
    // Clone's intake reads initialInput.pdfTemplateBrief, which this family run never sets, so the
    // brief the editor supplied is discarded without a word.
    expect(intake.output.entries).toEqual([]);
    expect(String(intake.output.summary)).not.toContain("nonprofit-core");

  });

  it("the overlay rule that causes it: a stored metadata key wins over the canonical one", () => {
    const merged = __test__.overlayStoreNode(
      { id: "n", metadata: { cloneStageDeterministic: "pdf_family_plan", skipWhen: [] } } as never,
      { id: "n", metadata: { cloneStageDeterministic: "pdf_intake" } } as never
    );
    expect(merged.metadata?.cloneStageDeterministic).toBe("pdf_intake");
  });
});
