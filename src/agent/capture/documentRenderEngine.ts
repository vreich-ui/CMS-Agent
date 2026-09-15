// A8 (Milestone A remainder, runner 3b) — document_render: render an EXISTING owned document to PDF
// through an already-published template, and report what actually happened.
//
// TWO deterministic stages, zero model calls — the same posture imageTemplateRevisionEngine.ts holds
// for A9: choosing nothing and composing one tenant verb is mechanical.
//
//   document_render_execute — calls the tenant's own `document_render` verb once and classifies its
//                             answer. Platform's verb is deliberately total: a kind it has no
//                             mapper for, a site with no default template, and render data that
//                             fails the template's own contract each come back `outcome: "blocked"`
//                             with a NAMED reason and NO job created (document-render.ts: "every
//                             blocked outcome is ok:true — a legitimate, informative result"). This
//                             stage keeps those three as named per-run outcomes; they are never
//                             re-labelled as failures, and never dressed up as success either.
//   document_render_report  — terminal. `pdfContentVerified` is READ from the receipt's own quality
//                             gate, never asserted: the descriptor's single completion criterion
//                             (pdf_content_verified) is a claim about the RENDERED bytes, and the
//                             only evidence this run has for it is what pdf-tool's own inspection
//                             reported back through `qualityGate`/`qualityGatePassed`. A receipt
//                             that carries no gate at all yields `false` with the absence stated,
//                             never an optimistic default.
//
// WHY ONE NODE AND NOT A RENDER/VERIFY PAIR: the platform verb already runs the create → poll →
// inspect → attach pipeline render_article_pdf uses and returns its receipt, quality gate included
// (mcp-tool-handlers.ts callDocumentRender). A second "verify" node would either re-inspect an
// artifact platform has already inspected, or invent an independent verdict — the first is waste,
// the second is a second source of truth. The report stage reads the one verdict that exists.
import { callProjectTool, CloneRefusal, type CloneDeps } from "./cloneEngine.js";

export const DOCUMENT_RENDER_ARTIFACTS = {
  execute: "document_render.execute.v1",
  report: "document_render.report.v1"
} as const;

// The three reasons Platform's own verb names, verbatim (document-render.ts's
// DocumentRenderBlockedReason). A reason outside this set is still reported — as itself, under
// `blocked.reason` — but this list is what the report's prose is written against.
export const DOCUMENT_RENDER_BLOCKED_REASONS = ["no_template", "no_mapper_for_kind", "invalid_render_data"] as const;

export type DocumentRenderRef = { objectType: string; objectId: string; tenantId: string; revision?: string };

export type DocumentRenderBrief = {
  documentRef: DocumentRenderRef;
  /** Omitted => the verb's own default ("article"). Never invented here. */
  documentKind?: string;
  /** Omitted => the site's own configured default for this kind. Set only when the operation asked
   *  for a pinned version by name; "latest" is the absence of a pin, not a template id. */
  templateId?: string;
  /** Default true, matching the verb's own default: the point of rendering an owned document is that
   *  the document ends up carrying it. */
  attach?: boolean;
};

export type DocumentRenderReceiptView = {
  status: string | null;
  jobId: string | null;
  publicPath: string | null;
  attached: boolean;
  pageCount: number | null;
  qualityGatePassed: boolean | null;
  qualityGateFindings: unknown[];
  unfilled: string[];
  warnings: string[];
  summary: string | null;
  polling: Record<string, unknown> | null;
  error: { code?: string; message: string } | null;
};

export type DocumentRenderExecuteEnvelope = {
  artifact: typeof DOCUMENT_RENDER_ARTIFACTS.execute;
  summary: string;
  outcome: "rendered" | "blocked";
  documentRef: DocumentRenderRef;
  documentKind: string | null;
  templateId: string | null;
  blocked: { reason: string; detail: string; errors?: unknown[]; missingAssetIds?: string[] } | null;
  receipt: DocumentRenderReceiptView | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter(nonEmptyString) : []);

function readReceipt(result: Record<string, unknown>): DocumentRenderReceiptView {
  const qualityGate = isRecord(result.qualityGate) ? result.qualityGate : undefined;
  // `qualityGatePassed` is the receipt's own flag; `qualityGate.passed` is the gate's. Read both,
  // prefer the flag, and stay NULL when neither exists — "not reported" is not "passed".
  const passed =
    typeof result.qualityGatePassed === "boolean"
      ? result.qualityGatePassed
      : qualityGate && typeof qualityGate.passed === "boolean"
        ? qualityGate.passed
        : null;
  return {
    status: nonEmptyString(result.status) ? result.status : null,
    jobId: nonEmptyString(result.jobId) ? result.jobId : null,
    publicPath: nonEmptyString(result.public_path) ? result.public_path : null,
    attached: result.attached === true,
    pageCount: typeof result.pageCount === "number" ? result.pageCount : null,
    qualityGatePassed: passed,
    qualityGateFindings: qualityGate && Array.isArray(qualityGate.findings) ? qualityGate.findings : [],
    unfilled: stringList(result.unfilled),
    warnings: stringList(result.warnings),
    summary: nonEmptyString(result.summary) ? result.summary : null,
    polling: isRecord(result.polling) ? (result.polling as Record<string, unknown>) : null,
    error: isRecord(result.error) ? ({ ...(nonEmptyString(result.error.code) ? { code: result.error.code } : {}), message: nonEmptyString(result.error.message) ? result.error.message : "pdf-tool reported an error with no message." }) : null
  };
}

/**
 * Stage 1. ONE tenant call. `siteId` is the tenant's Platform site object id — resolved by the
 * caller through pdfToolSiteScope.ts, never the tenantId (pdf-tool refuses that with
 * artifact_site_mismatch).
 */
export async function documentRenderExecuteStep(
  input: { targetProjectId: string; siteId: string; brief: DocumentRenderBrief },
  deps: CloneDeps = {}
): Promise<DocumentRenderExecuteEnvelope> {
  const { documentRef } = input.brief;
  if (!nonEmptyString(documentRef?.objectId) || !nonEmptyString(documentRef?.objectType)) {
    throw new CloneRefusal(
      "document_render_owner_missing",
      "document_render needs the owning object's type and id; a render with no document to render is never attempted."
    );
  }

  const result = await callProjectTool(
    input.targetProjectId,
    "document_render",
    {
      siteId: input.siteId,
      ownerObjectType: documentRef.objectType,
      ownerObjectId: documentRef.objectId,
      ...(nonEmptyString(input.brief.documentKind) ? { documentKind: input.brief.documentKind } : {}),
      ...(nonEmptyString(input.brief.templateId) ? { templateId: input.brief.templateId } : {}),
      ...(input.brief.attach === false ? { attach: false } : {})
    },
    deps
  );

  const documentKind = nonEmptyString(result.documentKind) ? result.documentKind : null;

  if (result.outcome === "blocked") {
    const reason = nonEmptyString(result.reason) ? result.reason : "unnamed_block";
    const detail = nonEmptyString(result.detail) ? result.detail : "Platform blocked this render and named no detail.";
    return {
      artifact: DOCUMENT_RENDER_ARTIFACTS.execute,
      summary: `document_render blocked (${reason}) for ${documentRef.objectType} "${documentRef.objectId}": ${detail} No job was created and nothing was attached.`,
      outcome: "blocked",
      documentRef,
      documentKind,
      templateId: nonEmptyString(result.templateId) ? result.templateId : null,
      blocked: {
        reason,
        detail,
        ...(Array.isArray(result.errors) ? { errors: result.errors } : {}),
        ...(Array.isArray(result.missingAssetIds) ? { missingAssetIds: stringList(result.missingAssetIds) } : {})
      },
      receipt: null
    };
  }

  // Anything that is not a named block is the rendered branch — and its receipt is reported as it
  // is, `status: "pending"` and `status: "failed"` included. Neither is a success; the report stage
  // below is what says so, from these fields alone.
  const receipt = readReceipt(result);
  return {
    artifact: DOCUMENT_RENDER_ARTIFACTS.execute,
    summary: receipt.summary ?? `document_render returned status "${receipt.status ?? "unknown"}" for ${documentRef.objectType} "${documentRef.objectId}".`,
    outcome: "rendered",
    documentRef,
    documentKind,
    templateId: nonEmptyString(result.templateId) ? result.templateId : null,
    blocked: null,
    receipt
  };
}

export type DocumentRenderReport = {
  artifact: typeof DOCUMENT_RENDER_ARTIFACTS.report;
  summary: string;
  outcome: "rendered" | "blocked";
  documentRef: DocumentRenderRef;
  documentKind: string | null;
  templateId: string | null;
  renderStatus: string | null;
  publicPath: string | null;
  attached: boolean;
  pageCount: number | null;
  /** The descriptor's ONLY completion criterion. True exclusively when a completed render's own
   *  quality gate reported `passed` — never when the gate is absent, never when the job is still
   *  pending, never when the render was blocked. */
  pdfContentVerified: boolean;
  contentVerification: { source: string; qualityGatePassed: boolean | null; findings: unknown[] };
  unfilled: string[];
  blocked: { reason: string; detail: string } | null;
  /** True when this run did what it was asked to do: a completed render whose content the gate
   *  passed. Everything else — blocked, pending, failed, gate not reported, gate failed — is false,
   *  and the summary says which. */
  completed: boolean;
};

/**
 * Stage 2, terminal. PURE: reads the execute envelope and nothing else. No clock, no store, no
 * network — the same discipline buildImageTemplateRevisionReportStep holds.
 */
export function buildDocumentRenderReportStep(input: { execute: DocumentRenderExecuteEnvelope }): DocumentRenderReport {
  const { execute } = input;
  const receipt = execute.receipt;
  const gatePassed = receipt?.qualityGatePassed ?? null;
  const rendered = execute.outcome === "rendered" && receipt?.status === "complete";
  const pdfContentVerified = rendered && gatePassed === true;

  const source = !receipt
    ? "no receipt — the render was blocked before any job was created"
    : receipt.status !== "complete"
      ? `no verdict — the render reported status "${receipt.status ?? "unknown"}", so its content was never inspected`
      : gatePassed === null
        ? "the completed render carried no quality gate, so nothing is known about its content"
        : `pdf-tool's own content quality gate on the rendered artifact (${receipt.publicPath ?? "no public path reported"})`;

  const summary = execute.outcome === "blocked"
    ? `document_render did not run: ${execute.blocked?.reason ?? "blocked"} — ${execute.blocked?.detail ?? ""}`.trim()
    : pdfContentVerified
      ? `Rendered ${execute.documentRef.objectType} "${execute.documentRef.objectId}"${receipt?.pageCount ? ` (${receipt.pageCount} pages)` : ""} and its content passed pdf-tool's quality gate${receipt?.attached ? " and was attached to the document" : " (not attached)"}.`
      : rendered
        ? `Rendered ${execute.documentRef.objectType} "${execute.documentRef.objectId}", but its content is NOT verified: ${source}. The PDF exists; the completion criterion is not met.`
        : `document_render reported status "${receipt?.status ?? "unknown"}" — nothing is verified and ${receipt?.attached ? "something was attached" : "nothing was attached"}. ${receipt?.summary ?? ""}`.trim();

  return {
    artifact: DOCUMENT_RENDER_ARTIFACTS.report,
    summary,
    outcome: execute.outcome,
    documentRef: execute.documentRef,
    documentKind: execute.documentKind,
    templateId: execute.templateId,
    renderStatus: receipt?.status ?? null,
    publicPath: receipt?.publicPath ?? null,
    attached: receipt?.attached === true,
    pageCount: receipt?.pageCount ?? null,
    pdfContentVerified,
    contentVerification: { source, qualityGatePassed: gatePassed, findings: receipt?.qualityGateFindings ?? [] },
    unfilled: receipt?.unfilled ?? [],
    blocked: execute.blocked ? { reason: execute.blocked.reason, detail: execute.blocked.detail } : null,
    completed: pdfContentVerified
  };
}
