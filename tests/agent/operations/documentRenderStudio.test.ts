import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { getOperationWorkflowBinding, UNBOUND_OPERATION_IMPLEMENTING_TASK } from "../../../src/agent/operations/operationWorkflowBindings.js";
import { applyWorkflowInitialInput } from "../../../src/agent/workspace/workflowInitialInput.js";
import { DOCUMENT_RENDER_WORKFLOW_ID } from "../../../src/agent/workspace/documentRenderWorkflow.js";
import { listDocumentRenderNodes } from "../../../src/agent/workspace/documentRenderNodes.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { buildDocumentRenderBrief } from "../../../src/agent/capture/documentRenderBriefBuilder.js";
import { buildDocumentRenderReportStep, DOCUMENT_RENDER_ARTIFACTS, type DocumentRenderExecuteEnvelope } from "../../../src/agent/capture/documentRenderEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// =================================================================================================
// A8 (Milestone A remainder, runner 3b) — document_render, end to end.
//
// OFFLINE: the tenant's MCP surface is a fetch double. Nothing here renders a real PDF, and nothing
// asserts one was rendered — the point of most of these tests is the opposite: that a run which did
// NOT verify content says so.
// =================================================================================================

const TARGET = "zilberman-a8-render";
const MCP_ENV_VAR = "ZILBERMAN_A8_RENDER_MCP_ENDPOINT";

type WireCall = { verb: string; args: Record<string, unknown> };
let wire: WireCall[];
let documentRenderResponse: Record<string, unknown>;

const installFetchDouble = () => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const ok = (result: unknown) =>
      ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }) }) as unknown as Response;
    if (request.method !== "tools/call") return ok({});
    const verb = String(request.params?.name);
    wire.push({ verb, args: (request.params?.arguments ?? {}) as Record<string, unknown> });
    if (verb === "document_render") return ok(documentRenderResponse);
    throw new Error(`Unexpected verb in this fixture: ${verb}`);
  }) as unknown as typeof fetch;
};

const RENDERED_OK = {
  ok: true,
  outcome: "rendered",
  documentKind: "article",
  templateId: "tpl_article_brochure_v1",
  siteId: `site_${TARGET}`,
  contentItemId: "ci_hello",
  jobId: "job_1",
  status: "complete",
  rendered: true,
  public_path: `/pdf/ci_hello/${"d".repeat(64)}.pdf`,
  attached: true,
  attachment: { nodeId: "n1", field: "media", mode: "replace", href: `/pdf/ci_hello/${"d".repeat(64)}.pdf` },
  pageCount: 4,
  qualityGate: { passed: true, findings: [] },
  qualityGatePassed: true,
  unfilled: [],
  summary: "Rendered and attached (4 pages)."
};

const nodes = new Map(listDocumentRenderNodes().map((node) => [node.id, node]));

const runWith = (initialInput: Record<string, unknown>): WorkflowExecutionRecord =>
  ({ projectId: TARGET, workflowId: DOCUMENT_RENDER_WORKFLOW_ID, initialInput, stageOutputs: {} }) as unknown as WorkflowExecutionRecord;

const stage = async (run: WorkflowExecutionRecord, nodeId: string) => {
  const node = nodes.get(nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  const outcome = await runCloneStage({ run, node, stage: nodeId as never });
  if (outcome.kind === "completed") run.stageOutputs[nodeId] = outcome.output;
  return outcome;
};

const dispatch = (input: Record<string, unknown>) => applyWorkflowInitialInput(DOCUMENT_RENDER_WORKFLOW_ID, input);

const briefRun = (over: Record<string, unknown> = {}) =>
  runWith({
    targetProjectId: TARGET,
    documentRenderBrief: { documentRef: { objectType: "content_item", objectId: "ci_hello", tenantId: TARGET }, ...over }
  });

beforeEach(async () => {
  resetRepositoryManager();
  wire = [];
  documentRenderResponse = { ...RENDERED_OK };
  process.env[MCP_ENV_VAR] = `https://${TARGET}.example/mcp`;
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "A8 render fixture", mcpEndpointEnvVar: MCP_ENV_VAR, authMode: "none", defaultToolPolicy: "allowed" })
  );
  await updateProject(
    repositoryManager.getProjectRepository(),
    TARGET,
    projectUpdateSchema.parse({ objectDialect: { siteObjectId: `site_${TARGET}`, taxonomyRegistryObjectId: `tax_${TARGET}`, objectIdSource: "server_minted" } })
  );
  installFetchDouble();
});

afterEach(() => {
  delete process.env[MCP_ENV_VAR];
  resetRepositoryManager();
});

describe("A8 — the binding", () => {
  it("document_render is no longer in the unbound map, and is bound to a REGISTERED workflow", () => {
    expect(UNBOUND_OPERATION_IMPLEMENTING_TASK.document_render).toBeUndefined();
    expect(getOperationWorkflowBinding("document_render")?.workflowId).toBe(DOCUMENT_RENDER_WORKFLOW_ID);
  });

  it("a Platform-shaped dispatch is CONSTRUCTED into the nested brief the entry node reads", () => {
    const built = dispatch({
      tenantId: TARGET,
      documentRef: { objectType: "content_item", objectId: "ci_hello", tenantId: TARGET },
      templateVersion: "latest"
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const initialInput = built.input as Record<string, unknown>;
    expect(initialInput.documentRenderBrief).toEqual({ documentRef: { objectType: "content_item", objectId: "ci_hello", tenantId: TARGET } });
    // "latest" is the ABSENCE of a pin, never a template id.
    expect((initialInput.documentRenderBrief as Record<string, unknown>).templateId).toBeUndefined();
    expect(initialInput.targetProjectId).toBe(TARGET);
  });

  it("a pinned templateVersion becomes the template id; an unsupported objectType is refused BEFORE a run exists", () => {
    const pinned = buildDocumentRenderBrief({ tenantId: TARGET, documentRef: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET }, templateVersion: "tpl_v7" });
    expect(pinned.ok && pinned.brief.templateId).toBe("tpl_v7");

    const unsupported = buildDocumentRenderBrief({ tenantId: TARGET, documentRef: { objectType: "page", objectId: "pg_1", tenantId: TARGET } });
    expect(unsupported.ok).toBe(false);
    if (unsupported.ok) return;
    expect(unsupported.code).toBe("document_render_object_type_unsupported");

    const crossTenant = buildDocumentRenderBrief({ tenantId: TARGET, documentRef: { objectType: "content_item", objectId: "ci_1", tenantId: "someone-else" } });
    expect(crossTenant.ok).toBe(false);
    if (crossTenant.ok) return;
    expect(crossTenant.code).toBe("document_render_brief_tenant_mismatch");
  });
});

describe("A8 — the run", () => {
  it("renders through the tenant verb, site-scoped by the record's own site object id, and reports pdf_content_verified from the receipt's quality gate", async () => {
    const run = briefRun();
    await stage(run, "document_render_execute");
    const report = await stage(run, "document_render_report");
    expect(report.kind).toBe("completed");
    if (report.kind !== "completed") return;

    expect(wire).toHaveLength(1);
    expect(wire[0].verb).toBe("document_render");
    expect(wire[0].args.site_id).toBe(`site_${TARGET}`); // NEVER the tenantId
    expect(wire[0].args.owner_object_type).toBe("content_item");
    expect(wire[0].args.owner_object_id).toBe("ci_hello");

    expect(report.output.outcome).toBe("rendered");
    expect(report.output.pdfContentVerified).toBe(true);
    expect(report.output.completed).toBe(true);
    expect(report.output.attached).toBe(true);
    expect(report.output.pageCount).toBe(4);
  });

  it("a blocked outcome is a NAMED per-run outcome — never a failure, never a success, and no job was created", async () => {
    for (const reason of ["no_template", "invalid_render_data", "no_mapper_for_kind"]) {
      wire = [];
      documentRenderResponse = { ok: true, outcome: "blocked", documentKind: "newsletter", reason, detail: `blocked: ${reason}` };
      const run = briefRun();
      const executed = await stage(run, "document_render_execute");
      expect(executed.kind).toBe("completed"); // a block is a result, not an error
      const report = await stage(run, "document_render_report");
      if (report.kind !== "completed") throw new Error("expected a completed report");
      expect(report.output.outcome).toBe("blocked");
      expect((report.output.blocked as { reason: string }).reason).toBe(reason);
      // ...and the run never claims the completion criterion.
      expect(report.output.pdfContentVerified).toBe(false);
      expect(report.output.completed).toBe(false);
      expect(report.output.summary as string).toContain(reason);
    }
  });

  it("a completed render whose quality gate is ABSENT is not verified — 'not reported' is never 'passed'", () => {
    const execute: DocumentRenderExecuteEnvelope = {
      artifact: DOCUMENT_RENDER_ARTIFACTS.execute,
      summary: "rendered",
      outcome: "rendered",
      documentRef: { objectType: "content_item", objectId: "ci_hello", tenantId: TARGET },
      documentKind: "article",
      templateId: "tpl_1",
      blocked: null,
      receipt: {
        status: "complete",
        jobId: "job_1",
        publicPath: "/pdf/x/y.pdf",
        attached: true,
        pageCount: 3,
        qualityGatePassed: null,
        qualityGateFindings: [],
        unfilled: [],
        warnings: [],
        summary: null,
        polling: null,
        error: null
      }
    };
    const report = buildDocumentRenderReportStep({ execute });
    expect(report.pdfContentVerified).toBe(false);
    expect(report.completed).toBe(false);
    expect(report.contentVerification.qualityGatePassed).toBeNull();
    expect(report.contentVerification.source).toContain("no quality gate");
  });

  it("a still-pending job is reported as pending and verified:false — never 'probably fine'", async () => {
    documentRenderResponse = {
      ok: true,
      outcome: "rendered",
      documentKind: "article",
      jobId: "job_2",
      status: "pending",
      attached: false,
      unfilled: [],
      polling: { tool: "get_agent_artifact_job_status", input: { site_id: `site_${TARGET}`, request_id: "ci_hello" } },
      summary: "Still rendering."
    };
    const run = briefRun();
    await stage(run, "document_render_execute");
    const report = await stage(run, "document_render_report");
    if (report.kind !== "completed") throw new Error("expected a completed report");
    expect(report.output.renderStatus).toBe("pending");
    expect(report.output.pdfContentVerified).toBe(false);
    expect(report.output.completed).toBe(false);
    expect(report.output.attached).toBe(false);
  });

  it("a run with no brief is refused BY NAME at the dispatch boundary, and calls nothing", async () => {
    const run = runWith({ targetProjectId: TARGET });
    const outcome = await stage(run, "document_render_execute");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("document_render_brief_missing");
    expect(wire).toEqual([]);
  });

  it("a project whose record carries no site object id is refused by name, never called with its tenantId as a stand-in", async () => {
    // A project minted BEFORE the platform scaffold wrote object ids onto the record — the case
    // pdfToolSiteScope.ts exists for. Its own project, so nothing about the fixture above is mutated.
    const legacy = `${TARGET}-legacy`;
    process.env[`${MCP_ENV_VAR}_LEGACY`] = `https://${legacy}.example/mcp`;
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({ projectId: legacy, name: "A8 legacy fixture", mcpEndpointEnvVar: `${MCP_ENV_VAR}_LEGACY`, authMode: "none", defaultToolPolicy: "allowed" })
    );
    const run = runWith({
      targetProjectId: legacy,
      documentRenderBrief: { documentRef: { objectType: "content_item", objectId: "ci_hello", tenantId: legacy } }
    });
    (run as unknown as { projectId: string }).projectId = legacy;
    const outcome = await stage(run, "document_render_execute");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("pdf_tool_site_id_unresolved");
    expect(wire).toEqual([]);
    delete process.env[`${MCP_ENV_VAR}_LEGACY`];
  });
});
