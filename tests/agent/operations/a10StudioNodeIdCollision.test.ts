import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
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
// No existing A7 test caught this, because every one of them drove runCloneStage with the
// CANONICAL node object rather than the one resolveConductorNodes hands the executor.
//
// FIXED (A10-D5): overlayStoreNode (executor.ts) now pins every route-selecting metadata key
// (WORKFLOW_STAGE_ROUTE_METADATA_KEYS: captureStageDeterministic, cloneStageDeterministic) to the
// CANONICAL node's value, discarding any stored value for those keys specifically — a stored row can
// still win on every other field (name/description/prompt/schema/tools/...), but never on which
// stage a node dispatches to. The four collided ids remain shared with clone_conductor (id
// distinctness was the OTHER option the review offered; this fix took the "pin canonical" option
// instead — see executor.ts's own comment on overlayStoreNode for why), but a stored/shared row for
// one of them can no longer redirect pdf_template_studio's dispatch onto clone_conductor's handlers.
// Inverted below — do not delete these tests; they are the regression guard against this exact class
// of defect recurring for any future node-id reuse.
// =================================================================================================
describe("A10-D5 — the deployed pdf_template_studio dispatches clone_conductor's stages, not its own", () => {
  beforeEach(async () => {
    resetRepositoryManager();
    await repositoryManager.getWorkspaceRepository().ensureWorkspaceNodeSeeds();
    // Milestone A remainder — the family-plan stage now resolves the brief's siteId from the
    // project record (pdfToolSiteScope.ts) instead of trusting the brief, so the target project must
    // exist and carry its site object id, exactly as a genesis-minted tenant does.
    process.env.A10_STUDIO_COLLISION_MCP_ENDPOINT = "https://a10-studio-collision.example/mcp";
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({ projectId: "a10-studio-collision", name: "A10 studio collision fixture", mcpEndpointEnvVar: "A10_STUDIO_COLLISION_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "allowed" })
    );
    await updateProject(
      repositoryManager.getProjectRepository(),
      "a10-studio-collision",
      projectUpdateSchema.parse({ objectDialect: { siteObjectId: "site_a10studiocollision", taxonomyRegistryObjectId: "tax_a10studiocollision", objectIdSource: "server_minted" } })
    );
  });
  afterEach(() => {
    delete process.env.A10_STUDIO_COLLISION_MCP_ENDPOINT;
  });

  it("A7's studio nodes are not seeded into the shared store at all — but four of their ids already are, by clone_conductor", () => {
    const seededIds = new Set(workspaceStoreSeedNodes().map((node) => node.id));
    const studioIds = listPdfTemplateStudioNodes().map((node) => node.id);
    const collided = studioIds.filter((id) => seededIds.has(id));
    expect(collided).toEqual(["pdf_template_intake", "pdf_template_designer", "pdf_template_mint", "pdf_template_publish"]);
    // ...and the two that do NOT collide are exactly A7's own new nodes.
    expect(studioIds.filter((id) => !seededIds.has(id))).toEqual(["pdf_template_library_deposit", "pdf_template_family_report"]);
  });

  it("FIXED — resolveConductorNodes now hands the executor pdf_template_studio's OWN route keys for those four nodes, never clone_conductor's", async () => {
    const canonical = new Map(listPdfTemplateStudioNodes().map((node) => [node.id, node]));
    const resolved = new Map((await resolveConductorNodes(repositoryManager.getWorkspaceRepository(), PDF_TEMPLATE_STUDIO_WORKFLOW_ID)).map((node) => [node.id, node]));

    // What A7's code says now MATCHES what a run actually gets — resolved agrees with canonical for
    // every one of the four collided-id nodes, not just the two that never had a store row.
    expect(canonical.get("pdf_template_intake")?.metadata?.cloneStageDeterministic).toBe("pdf_family_plan");
    expect(resolved.get("pdf_template_intake")?.metadata?.cloneStageDeterministic).toBe("pdf_family_plan");
    expect(canonical.get("pdf_template_mint")?.metadata?.cloneStageDeterministic).toBe("pdf_mint_validated");
    expect(resolved.get("pdf_template_mint")?.metadata?.cloneStageDeterministic).toBe("pdf_mint_validated");
    expect(canonical.get("pdf_template_publish")?.metadata?.cloneStageDeterministic).toBe("pdf_publish_only");
    expect(resolved.get("pdf_template_publish")?.metadata?.cloneStageDeterministic).toBe("pdf_publish_only");

    // A7's own two new nodes were always unaffected — no store row, so canonical shows through
    // either way — kept here so this test still names the full five-node picture.
    expect(resolved.get("pdf_template_library_deposit")?.metadata?.cloneStageDeterministic).toBe("pdf_library_deposit");
    expect(resolved.get("pdf_template_family_report")?.metadata?.cloneStageDeterministic).toBe("pdf_family_report");
  });

  it("FIXED — the consequence resolved: the editor's family brief reaches the REAL family-plan step and is honored, never silently discarded", async () => {
    const resolved = new Map((await resolveConductorNodes(repositoryManager.getWorkspaceRepository(), PDF_TEMPLATE_STUDIO_WORKFLOW_ID)).map((node) => [node.id, node]));
    const run = {
      projectId: "a10-studio-collision",
      workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
      // useCase "nonprofit_standard" is the one seeded profile (templateFamilyProfiles.ts), so this
      // brief — if actually read — expands to real variants, not just an accepted-but-unknown-useCase
      // shell. That is the strongest possible proof the brief reaches the real step.
      // No siteId on the brief ON PURPOSE: a chat-dispatched brief never carries one; the stage
      // resolves it from the record and the assertion below proves the injection.
      initialInput: { targetProjectId: "a10-studio-collision", pdfTemplateFamilyBrief: { familyId: "nonprofit-core", useCase: "nonprofit_standard" } },
      stageOutputs: {}
    } as unknown as WorkflowExecutionRecord;

    const intakeNode = resolved.get("pdf_template_intake")!;
    const intake = await runCloneStage({ run, node: intakeNode, stage: intakeNode.metadata!.cloneStageDeterministic as never });
    expect(intake.kind).toBe("completed");
    if (intake.kind !== "completed") return;
    run.stageOutputs.pdf_template_intake = intake.output;

    // The SAME artifact id clone's own "intake" stage uses for its own envelope no longer applies
    // here — pdfTemplateFamilyEngine.ts now stamps its own, distinct id (A10-D5's second half), so
    // this assertion is itself part of the fix's own proof, not just a leftover.
    expect(intake.output.artifact).toBe(PDF_FAMILY_ARTIFACTS.plan);
    // The family fields the editor's brief supplied are genuinely present — reached the real step.
    expect(intake.output).toHaveProperty("familyId", "nonprofit-core");
    expect(intake.output).toHaveProperty("useCase", "nonprofit_standard");
    // The site scope came from the record (objectDialect.siteObjectId), never from the tenantId.
    expect(intake.output).toHaveProperty("siteId", "site_a10studiocollision");
    const entries = intake.output.entries as unknown[];
    expect(entries.length).toBeGreaterThan(0); // real variants planned, not an empty shell
    expect(String(intake.output.summary)).toContain("nonprofit-core");
  });

  it("FIXED — the overlay rule: a stored route-metadata key no longer wins over the canonical one", () => {
    const merged = __test__.overlayStoreNode(
      { id: "n", metadata: { cloneStageDeterministic: "pdf_family_plan", skipWhen: [] } } as never,
      { id: "n", metadata: { cloneStageDeterministic: "pdf_intake" } } as never
    );
    // Canonical wins for the route key specifically — even though this stored row otherwise carries
    // real content (skipWhen is canonical's own field here, absent from stored, so it still survives
    // the merge; only cloneStageDeterministic is pinned).
    expect(merged.metadata?.cloneStageDeterministic).toBe("pdf_family_plan");
  });
});
