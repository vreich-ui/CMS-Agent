// Milestone A remainder — the two builders that close A6 (visual_identity_review_change) and A7
// (pdf_template_family), the pdf-tool site-scope resolver both PDF stages now go through, and the
// registry behavior (idempotence, conflict, pass-through) for each builder — driven through the SAME
// applyWorkflowInitialInput startDryRun applies, so what is asserted here is what a dispatch gets.
import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { buildVisualIdentityBrief, visualIdentityBriefTextFor, VISUAL_IDENTITY_BRIEF_PROVIDED_FIELDS } from "../../../src/agent/workspace/visualIdentityBriefBuilder.js";
import { buildPdfTemplateFamilyBrief } from "../../../src/agent/capture/pdfTemplateFamilyBriefBuilder.js";
import { resolvePdfToolSiteId } from "../../../src/agent/capture/pdfToolSiteScope.js";
import { applyWorkflowInitialInput, getWorkflowInitialInputBuilder } from "../../../src/agent/workspace/workflowInitialInput.js";
import { VISUAL_IDENTITY_WORKFLOW_ID } from "../../../src/agent/workspace/visualIdentityWorkflow.js";
import { PDF_TEMPLATE_STUDIO_WORKFLOW_ID } from "../../../src/agent/workspace/pdfTemplateStudioWorkflow.js";
import { getOperation } from "../../../src/agent/operations/operationCatalog.js";
import { listVisualIdentityNodes } from "../../../src/agent/workspace/visualIdentityNodes.js";
import { listPdfTemplateStudioNodes } from "../../../src/agent/workspace/pdfTemplateStudioNodes.js";

const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as Extract<T, { ok: true }>;
};

describe("visualIdentityBriefBuilder (A6)", () => {
  it("builds projectId/mode/brief/apply from the operation's own tenantId/focus/autoApply, and the brief quotes the focus", () => {
    const built = ok(buildVisualIdentityBrief({ tenantId: "zilberman", focus: "color", autoApply: true }));
    expect(built.brief).toEqual({ projectId: "zilberman", mode: "house", brief: visualIdentityBriefTextFor("color"), apply: true });
    expect(built.brief.brief).toContain("(focus: color)");
    expect(Object.keys(built.brief).sort()).toEqual([...VISUAL_IDENTITY_BRIEF_PROVIDED_FIELDS].sort());
  });

  it("uses the descriptor's own defaults when focus/autoApply are absent (full_review, apply:false) — the same values preflight applies", () => {
    const built = ok(buildVisualIdentityBrief({ tenantId: "zilberman" }));
    expect(built.brief.brief).toBe(visualIdentityBriefTextFor("full_review"));
    expect(built.brief.apply).toBe(false);
    const operation = getOperation("visual_identity_review_change");
    expect(operation.found && operation.descriptor.defaults).toEqual({ autoApply: false, focus: "full_review" });
  });

  it("refuses by name rather than coercing: missing tenantId, a focus outside the enum, a non-boolean autoApply, a projectId naming another tenant", () => {
    expect(buildVisualIdentityBrief({ focus: "color" })).toMatchObject({ ok: false, code: "visual_identity_brief_tenant_missing" });
    expect(buildVisualIdentityBrief({ tenantId: "z", focus: "vibes" })).toMatchObject({ ok: false, code: "visual_identity_brief_focus_invalid" });
    expect(buildVisualIdentityBrief({ tenantId: "z", autoApply: "yes" })).toMatchObject({ ok: false, code: "visual_identity_brief_auto_apply_invalid" });
    expect(buildVisualIdentityBrief({ tenantId: "z", projectId: "other" })).toMatchObject({ ok: false, code: "visual_identity_brief_project_mismatch" });
  });

  it("every field the builder provides is one brand_imagery_writer or visual_standard_materializer actually names, and `mode` + `brief` satisfy the writer's required/anyOf", () => {
    const writer = listVisualIdentityNodes().find((node) => node.id === "brand_imagery_writer")!;
    const schema = writer.inputSchema as { required: string[]; anyOf: Array<{ required: string[] }>; properties: Record<string, unknown> };
    for (const field of ["projectId", "mode", "brief"]) expect(Object.keys(schema.properties)).toContain(field);
    expect(schema.required).toEqual(["mode"]);
    expect(schema.anyOf.some((branch) => branch.required.every((field) => (VISUAL_IDENTITY_BRIEF_PROVIDED_FIELDS as readonly string[]).includes(field)))).toBe(true);
    const materializer = listVisualIdentityNodes().find((node) => node.id === "visual_standard_materializer")!;
    expect(Object.keys((materializer.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("apply");
  });

  describe("through applyWorkflowInitialInput (what startDryRun applies)", () => {
    it("a full operation dispatch is built, keeping the dispatched fields beside what was built", () => {
      const applied = applyWorkflowInitialInput(VISUAL_IDENTITY_WORKFLOW_ID, { tenantId: "zilberman", focus: "imagery", autoApply: false });
      expect(applied.ok && applied.applied).toBe(true);
      expect(applied.ok && applied.input).toMatchObject({ tenantId: "zilberman", focus: "imagery", autoApply: false, projectId: "zilberman", mode: "house", apply: false });
    });

    it("a hand-built writer input (mode + references, no brief/apply) passes through UNCHANGED — an operator run is not a dispatch of this operation", () => {
      const hand = { projectId: "zilberman", mode: "house", references: [{ url: "https://example.test/a.png" }] };
      const applied = applyWorkflowInitialInput(VISUAL_IDENTITY_WORKFLOW_ID, hand);
      expect(applied).toMatchObject({ ok: true, applied: false, input: hand });
    });

    it("BOTH a hand-built result and a full dispatch is refused with the builder's own conflict code", () => {
      const applied = applyWorkflowInitialInput(VISUAL_IDENTITY_WORKFLOW_ID, {
        tenantId: "zilberman", focus: "theme", autoApply: false,
        projectId: "zilberman", mode: "house", brief: "hand-written", apply: true
      });
      expect(applied).toMatchObject({ ok: false, code: "visual_identity_brief_conflict" });
    });

    it("the registered builder declares exactly what the binding declares", () => {
      const builder = getWorkflowInitialInputBuilder(VISUAL_IDENTITY_WORKFLOW_ID)!;
      expect(builder.builderId).toBe("visual_identity_review_change_brief_builder.v1");
      expect(builder.conflictCode).toBe("visual_identity_brief_conflict");
      expect([...builder.requiredOperationFields]).toEqual(["tenantId", "focus", "autoApply"]);
    });
  });
});

describe("pdfTemplateFamilyBriefBuilder (A7)", () => {
  it("builds the nested brief from tenantId/familyId, carrying useCase/sourceUrl only when supplied, and never a siteId", () => {
    const minimal = ok(buildPdfTemplateFamilyBrief({ tenantId: "zilberman", familyId: "nonprofit-core", locale: "en-US" }));
    expect(minimal.tenantId).toBe("zilberman");
    expect(minimal.brief).toEqual({ familyId: "nonprofit-core" });
    const full = ok(buildPdfTemplateFamilyBrief({ tenantId: "zilberman", familyId: "nonprofit-core", useCase: "nonprofit_standard", sourceUrl: "https://zilbermanfilmfoundation.com" }));
    expect(full.brief).toEqual({ familyId: "nonprofit-core", useCase: "nonprofit_standard", sourceUrl: "https://zilbermanfilmfoundation.com" });
    expect("siteId" in full.brief).toBe(false);
  });

  it("refuses by name: missing tenantId, missing familyId, a supplied-but-empty useCase or sourceUrl", () => {
    expect(buildPdfTemplateFamilyBrief({ familyId: "f" })).toMatchObject({ ok: false, code: "pdf_template_family_brief_tenant_missing" });
    expect(buildPdfTemplateFamilyBrief({ tenantId: "z" })).toMatchObject({ ok: false, code: "pdf_template_family_brief_family_missing" });
    expect(buildPdfTemplateFamilyBrief({ tenantId: "z", familyId: "f", useCase: "" })).toMatchObject({ ok: false, code: "pdf_template_family_brief_use_case_invalid" });
    expect(buildPdfTemplateFamilyBrief({ tenantId: "z", familyId: "f", sourceUrl: 42 })).toMatchObject({ ok: false, code: "pdf_template_family_brief_source_url_invalid" });
  });

  it("the descriptor now admits useCase and sourceUrl (additionalProperties:false made them undispatchable before), and locale stays", () => {
    const operation = getOperation("pdf_template_family");
    expect(operation.found).toBe(true);
    const properties = (operation.found ? operation.descriptor.inputSchema : {}) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(properties.properties).sort()).toEqual(["familyId", "locale", "sourceUrl", "tenantId", "useCase"]);
    expect(properties.required).toEqual(["tenantId", "familyId"]);
  });

  it("pdf_template_intake's own inputSchema now names pdfTemplateFamilyBrief (the binding-contract view) or initialInput (the executor envelope)", () => {
    const intake = listPdfTemplateStudioNodes().find((node) => node.id === "pdf_template_intake")!;
    expect((intake.inputSchema as { anyOf: unknown }).anyOf).toEqual([{ required: ["pdfTemplateFamilyBrief"] }, { required: ["initialInput"] }]);
  });

  describe("through applyWorkflowInitialInput", () => {
    it("a full dispatch is built: nested brief, targetProjectId pinned to the tenant, dispatched fields kept", () => {
      const applied = applyWorkflowInitialInput(PDF_TEMPLATE_STUDIO_WORKFLOW_ID, { tenantId: "zilberman", familyId: "nonprofit-core", locale: "en-US" });
      expect(applied.ok && applied.applied).toBe(true);
      expect(applied.ok && applied.input).toEqual({ tenantId: "zilberman", familyId: "nonprofit-core", locale: "en-US", targetProjectId: "zilberman", pdfTemplateFamilyBrief: { familyId: "nonprofit-core" } });
    });

    it("a targetProjectId naming another tenant is refused, never redirected", () => {
      expect(applyWorkflowInitialInput(PDF_TEMPLATE_STUDIO_WORKFLOW_ID, { tenantId: "zilberman", familyId: "f", targetProjectId: "dr-lurie" })).toMatchObject({ ok: false, code: "pdf_template_family_target_project_mismatch" });
    });

    it("a hand-built brief (operator/test surface) passes through unchanged; brief + full dispatch conflicts by name", () => {
      const hand = { targetProjectId: "zilberman", pdfTemplateFamilyBrief: { siteId: "site_zilberman", familyId: "f", useCase: "nonprofit_standard" } };
      expect(applyWorkflowInitialInput(PDF_TEMPLATE_STUDIO_WORKFLOW_ID, hand)).toMatchObject({ ok: true, applied: false, input: hand });
      expect(applyWorkflowInitialInput(PDF_TEMPLATE_STUDIO_WORKFLOW_ID, { ...hand, tenantId: "zilberman", familyId: "f" })).toMatchObject({ ok: false, code: "pdf_template_family_brief_conflict" });
    });
  });
});

describe("resolvePdfToolSiteId — the tenant's Platform site object id, never the tenantId", () => {
  const record = { projectId: "zilberman", objectDialect: { siteObjectId: "site_zilberman", taxonomyRegistryObjectId: "tax_zilberman", objectIdSource: "server_minted" as const } };

  it("resolves from objectDialect.siteObjectId", () => {
    expect(resolvePdfToolSiteId(record)).toEqual({ ok: true, siteId: "site_zilberman" });
    expect(resolvePdfToolSiteId(record, "site_zilberman")).toEqual({ ok: true, siteId: "site_zilberman" });
    expect(resolvePdfToolSiteId(record, "   ")).toEqual({ ok: true, siteId: "site_zilberman" });
  });

  it("refuses by name when the record has no dialect, and when a caller names a different site — the tenantId is never accepted as a stand-in", () => {
    expect(resolvePdfToolSiteId({ projectId: "old-tenant" })).toMatchObject({ ok: false, code: "pdf_tool_site_id_unresolved" });
    expect(resolvePdfToolSiteId({ projectId: "old-tenant", objectDialect: { siteObjectId: "", taxonomyRegistryObjectId: "t", objectIdSource: "server_minted" } })).toMatchObject({ ok: false, code: "pdf_tool_site_id_unresolved" });
    expect(resolvePdfToolSiteId(record, "zilberman")).toMatchObject({ ok: false, code: "pdf_tool_site_id_mismatch" });
  });
});

// =================================================================================================
// THE TRACE — what Platform's resolveCatalogOperation actually sends (defaults merged, inputMapping
// applied — empty for a builder-backed row — tenantId forced last), through the REAL startDryRun, for
// the two operations that could never start from chat before. Mirrors imageTemplateRevisionDispatch's
// platformDispatchInput so a change to either side's contract is caught here, not in production.
import { afterEach, beforeEach } from "vitest";
import { startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { getOperationWorkflowBinding } from "../../../src/agent/operations/operationWorkflowBindings.js";

const TARGET = "milestone-a-dispatch-fixture";
const MCP_ENV_VAR = "MILESTONE_A_DISPATCH_FIXTURE_MCP_ENDPOINT";

function platformDispatchInput(operationId: string, modelInput: Record<string, unknown>): { workflowId: string; input: Record<string, unknown> } {
  const binding = getOperationWorkflowBinding(operationId)!;
  const operation = getOperation(operationId);
  if (!operation.found) throw new Error(`no descriptor for ${operationId}`);
  const merged: Record<string, unknown> = { ...operation.descriptor.defaults, ...modelInput };
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) mapped[binding.inputMapping[key] ?? key] = value;
  mapped[binding.inputMapping.tenantId ?? "tenantId"] = TARGET;
  return { workflowId: binding.workflowId, input: mapped };
}

describe("a chat dispatch of the two repaired operations reaches startDryRun with a built initialInput", () => {
  beforeEach(async () => {
    resetRepositoryManager();
    process.env[MCP_ENV_VAR] = `https://${TARGET}.example/mcp`;
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({ projectId: TARGET, name: "Milestone A dispatch fixture", mcpEndpointEnvVar: MCP_ENV_VAR, authMode: "none", defaultToolPolicy: "allowed" })
    );
    await updateProject(
      repositoryManager.getProjectRepository(),
      TARGET,
      projectUpdateSchema.parse({ objectDialect: { siteObjectId: `site_${TARGET}`, taxonomyRegistryObjectId: `tax_${TARGET}`, objectIdSource: "server_minted" } })
    );
  });
  afterEach(() => {
    delete process.env[MCP_ENV_VAR];
    resetRepositoryManager();
  });

  it("visual_identity_review_change: the run record carries projectId/mode/brief/apply built from the dispatched tenantId/focus/autoApply", async () => {
    const { workflowId, input } = platformDispatchInput("visual_identity_review_change", { focus: "color" });
    expect(workflowId).toBe(VISUAL_IDENTITY_WORKFLOW_ID);
    const run = await startDryRun({ projectId: TARGET, workflowId, input, executionMode: "mock" });
    expect(run.initialInput).toMatchObject({ tenantId: TARGET, focus: "color", autoApply: false, projectId: TARGET, mode: "house", brief: visualIdentityBriefTextFor("color"), apply: false });
  });

  it("pdf_template_family: the run record carries the nested pdfTemplateFamilyBrief (no siteId — the stage resolves it from the record) and targetProjectId pinned to the tenant", async () => {
    const { workflowId, input } = platformDispatchInput("pdf_template_family", { familyId: "nonprofit-core", useCase: "nonprofit_standard" });
    expect(workflowId).toBe(PDF_TEMPLATE_STUDIO_WORKFLOW_ID);
    const run = await startDryRun({ projectId: TARGET, workflowId, input, executionMode: "mock" });
    expect(run.initialInput).toMatchObject({ tenantId: TARGET, familyId: "nonprofit-core", locale: "en-US", targetProjectId: TARGET, pdfTemplateFamilyBrief: { familyId: "nonprofit-core", useCase: "nonprofit_standard" } });
    expect((run.initialInput as { pdfTemplateFamilyBrief: Record<string, unknown> }).pdfTemplateFamilyBrief.siteId).toBeUndefined();
  });

  it("a dispatch the builder refuses never mints a run: a focus outside the enum is a named WorkspaceToolError before any record exists", async () => {
    const { workflowId, input } = platformDispatchInput("visual_identity_review_change", { focus: "vibes" });
    await expect(startDryRun({ projectId: TARGET, workflowId, input, executionMode: "mock" })).rejects.toMatchObject({ code: "visual_identity_brief_focus_invalid" });
    expect(await repositoryManager.getExecutionRepository().listRuns({ projectId: TARGET })).toEqual([]);
  });
});
