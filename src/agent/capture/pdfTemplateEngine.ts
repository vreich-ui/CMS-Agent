// T15.34 (#210; ADR-2026-08-25-structure-studio §7) — the PDF-template workspace.
//
// ================================================================================================
// THE DISCIPLINE IS SHARED; THE TRANSPORT IS NOT — AND THIS IS NOT A SECOND PUBLISH PATH.
// ================================================================================================
// A `pdf_template` is NOT a CMS governed object. It lives entirely in pdf-tool's own
// `pdf-template-store` (create_pdf_template / validate_pdf_template / get_pdf_template_validation /
// publish_pdf_template), it never passes through object_publish, and it triggers no production
// release, no build, no deploy. So the three deterministic stages in this module —
// pdfTemplateIntakeStep, pdfTemplateMintStep, pdfTemplatePublishStep — deliberately do NOT reach
// composeWorkflowNodes' shared publishing tail (publish_payload / publication_controller /
// publish_executor / release_executor, publishingTail.ts) and never call object_publish,
// release_to_production, trigger_netlify_build or deploy. ADR-2026-08-25-publish-autonomy's "one
// publish path" invariant governs *CMS object publication*; a pdf_template is not one, so this
// module publishing a pdf_template is not a second instance of that invariant's path — it is a
// different store's own publish verb, reached by a workflow already chartered to reach it.
//
// WHAT IS SHARED, DELIBERATELY, IS THE DISCIPLINE AND THE AUTHORITY READ:
//   - design -> validate -> publish, deterministic authorship, reject-never-coerce — the SAME shape
//     recipe_designer/recipe_mint/publish_executor already hold for CMS structure, applied here to
//     a different backing store.
//   - callProjectTool (cloneEngine.ts, exported for this reuse) and mcpBoundary.ts's wire-boundary
//     discipline — the SAME "resolve the project, guard the verb, cross the wire once, never guess a
//     field name" shape, extended (mcpBoundary.ts's TOOL_WIRE_SPECS) with pdf-tool's own four verbs
//     rather than duplicated.
//   - `publishingPolicy.autonomyMode`, read through the IDENTICAL mechanism every other publish-risk
//     node in this codebase uses: pdf_template_publish (cloneConductorNodes.ts) is declared
//     `riskLevel: "publish"`, which is ALL that is required for the executor's OWN generic
//     publish-risk gate (executor.ts's `isPublishRisk`/`resolvePublishAuthority(run)` — keyed purely
//     on riskLevel, never on node id or which tail composed a node) to refuse dispatch for an
//     operator-withheld or non-autonomous run BEFORE this module's publish step ever runs, and to
//     let it proceed without a human for an autonomous one. No bespoke "is this project autonomous"
//     check is written here, or anywhere in this module — that would be exactly the second approval
//     truth ADR-2026-08-25-structure-studio §4.2 forbids.
//   - the studio's terminal ledger and client memory (ADR §5): a published pdf_template is deposited
//     into the SAME cross-tenant TemplateLibraryStore (#207) under `objectType: "pdf_template"` —
//     already a first-class member of TemplateLibraryObjectType, templateSectionTypes.ts and
//     memoryEnvelope.ts's own `templateArtifactValueSchema` all named it in #207/#208, waiting for
//     this task — and folded into the SAME per-tenant ClientMemoryStore write cloneConductorRoutes.ts
//     already performs at the studio's terminal "report" stage, so "what has this client got" reads
//     one ledger, not two.
//
// WHAT IS NOT SHARED: the wire vocabulary (pdf-tool's own four verbs, not object_create/
// object_publish), the object model (a pdf_template has no CMS objectId, no lock, no checkout/checkin
// lifecycle — pdf-tool owns its own draft/active versioning), and the entry point (this module's
// stages read `run.initialInput.pdfTemplateBrief` directly, never clone_intake's structureBrief/
// captureRunId machinery — clone.mjs, which owns that validation, is a VENDORED file
// (capture/provenance.ts's CAPTURE_ENGINE_FILES) this task must not touch, and a PDF template is not
// site structure in the first place, so it has no business inside that briefing).
import { createHash } from "node:crypto";
import { callProjectTool, resolveCloneAuthority, CloneRefusal, type CloneDeps, type LibraryDepositLedger } from "./cloneEngine.js";
import { TemplateLibraryStore } from "../library/templateLibraryStore.js";
import { TemplateLibraryRefusal, type TemplateLibraryRecord } from "../library/templateLibraryTypes.js";
import { canonicalStringify } from "../library/templateLibraryRecord.js";

export const PDF_TEMPLATE_ARTIFACTS = {
  intake: "pdf_template_intake.v1",
  mint: "pdf_template_mint.v1",
  publish: "pdf_template_publish.v1"
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// ---------------------------------------------------------------------------------------------
// Identity. Deliberately NOT templateIdentity.ts's buildTemplateId — that module's own type
// signature is scoped to `"section_template" | "template"` (#207, out of this task's scope to
// widen), and #207/#208's tenancy-seam discipline it documents applies identically here, so this
// mirrors its EXACT scheme (`${sourceProjectId}::${objectType}::${requestedId}`) rather than
// reaching into a module this task must leave alone.
function buildPdfTemplateId(input: { sourceProjectId: string; requestedId: string }): string {
  const project = input.sourceProjectId.trim();
  const requestedId = input.requestedId.trim();
  if (!project) throw new CloneRefusal("pdf_template_source_project_missing", "buildPdfTemplateId requires a non-empty sourceProjectId.");
  if (!requestedId) throw new CloneRefusal("pdf_template_requested_id_missing", "buildPdfTemplateId requires a non-empty requestedId.");
  return `${project}::pdf_template::${requestedId}`;
}

const slugify = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "template";

const PDF_RENDERERS = ["pdfme", "react-pdf", "typst", "chromium"] as const;
export type PdfRenderer = typeof PDF_RENDERERS[number];
const isRenderer = (value: unknown): value is PdfRenderer => typeof value === "string" && (PDF_RENDERERS as readonly string[]).includes(value);
// pdfme is the ONE renderer the bridge publishes without a validation report on file ("pdfme creates
// then publishes immediately, warn-only on lint issues" — create_pdf_template's own contract).
// Every other renderer MUST go create -> validate -> poll to a PASSED report -> publish, or
// publish_pdf_template itself refuses (HTTP 409 TEMPLATE_VALIDATION_REQUIRED).
const rendererRequiresValidation = (renderer: PdfRenderer): boolean => renderer !== "pdfme";

// ---------------------------------------------------------------------------------------------
// Stage: intake — total, deterministic, pure. Normalizes run.initialInput.pdfTemplateBrief into a
// bounded, validated entry list. No wire calls: this stage exists so pdf_template_designer (AI) and
// pdf_template_mint (deterministic) both read the SAME already-validated shape, exactly as
// clone_intake exists for the structure branch — and so skipPredicates.ts's
// clone_no_pdf_template_entries can gate the designer off a plain structural fact of THIS envelope
// (mirroring clone_no_actionable_mismatches reading layout_analyst's own `mismatches`) rather than
// re-parsing raw initialInput itself.
export type PdfTemplateIntakeEntry = {
  requestedId: string;
  name: string;
  renderer: PdfRenderer;
  label?: string;
  tags: string[];
  sourceUrl?: string;
  purpose?: string;
  contentOutline?: unknown;
  sampleData?: Record<string, unknown>;
};

export type PdfTemplateIntakeEnvelope = {
  artifact: typeof PDF_TEMPLATE_ARTIFACTS.intake;
  summary: string;
  siteId: string | null;
  entries: PdfTemplateIntakeEntry[];
  rejectedEntries: Array<{ index: number; name?: string; reason: string }>;
};

export function pdfTemplateIntakeStep(input: { initialInput: unknown }): PdfTemplateIntakeEnvelope {
  const initial = isRecord(input.initialInput) ? input.initialInput : {};
  const brief = isRecord(initial.pdfTemplateBrief) ? initial.pdfTemplateBrief : undefined;
  if (!brief) {
    return {
      artifact: PDF_TEMPLATE_ARTIFACTS.intake,
      summary: "No pdfTemplateBrief on this run's initialInput; there is no PDF-template work for this run. pdf_template_designer is skipped for this reason (skipPredicates.ts's clone_no_pdf_template_entries).",
      siteId: null,
      entries: [],
      rejectedEntries: []
    };
  }
  const siteId = nonEmptyString(brief.siteId) ? brief.siteId.trim() : null;
  const rawEntries = Array.isArray(brief.entries) ? brief.entries : [];
  const entries: PdfTemplateIntakeEntry[] = [];
  const rejectedEntries: PdfTemplateIntakeEnvelope["rejectedEntries"] = [];
  const seenRequestedIds = new Set<string>();

  rawEntries.forEach((raw, index) => {
    if (!isRecord(raw) || !nonEmptyString(raw.name)) {
      rejectedEntries.push({ index, reason: `pdfTemplateBrief.entries[${index}] requires a non-empty "name" naming this PDF template.` });
      return;
    }
    const name = raw.name.trim();
    let requestedId = `pdf-${slugify(name)}`;
    let suffix = 2;
    while (seenRequestedIds.has(requestedId)) {
      requestedId = `pdf-${slugify(name)}-${suffix}`;
      suffix += 1;
    }
    seenRequestedIds.add(requestedId);
    entries.push({
      requestedId,
      name,
      renderer: isRenderer(raw.renderer) ? raw.renderer : "pdfme",
      label: nonEmptyString(raw.label) ? raw.label.trim() : undefined,
      tags: Array.isArray(raw.tags) ? raw.tags.filter(nonEmptyString).map((tag) => tag.trim()) : [],
      sourceUrl: nonEmptyString(raw.sourceUrl) ? raw.sourceUrl.trim() : undefined,
      purpose: nonEmptyString(raw.purpose) ? raw.purpose.trim() : undefined,
      contentOutline: raw.contentOutline,
      sampleData: isRecord(raw.sampleData) ? raw.sampleData : undefined
    });
  });

  if (!siteId) {
    rejectedEntries.push({ index: -1, reason: "pdfTemplateBrief.siteId is missing or empty; every pdf-tool call is site-scoped and none of this brief's entries can proceed without one." });
  }

  const usableEntries = siteId ? entries : [];
  return {
    artifact: PDF_TEMPLATE_ARTIFACTS.intake,
    summary: `PDF-template brief: ${usableEntries.length} entrie(s) named${siteId ? ` for site "${siteId}"` : ""}${rejectedEntries.length ? `, ${rejectedEntries.length} entrie(s) rejected` : ""}.`,
    siteId,
    entries: usableEntries,
    rejectedEntries
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: mint — re-validates pdf_template_designer's proposals and EXECUTES the survivors as
// pdf-tool draft templates, deterministically: create_pdf_template, then (for every renderer except
// pdfme) validate_pdf_template followed by a bounded, deterministic poll of
// get_pdf_template_validation. Reject-never-coerce, exactly like recipe_mint: a design with no
// usable templateJson, an unrecognized renderer, or a validation report that never reaches PASSED is
// REJECTED with pdf-tool's own reason and left out of `applied` — never retried with different
// content, never silently downgraded to "draft, assume it's fine".
export type PdfTemplateMintApplied = { requestedId: string; name: string; renderer: PdfRenderer; templateId: string; version: number; validated: boolean; label?: string; tags: string[]; sourceUrl?: string; templateJson: Record<string, unknown> };
export type PdfTemplateMintRejected = { requestedId: string; name?: string; code: string; reason: string };
export type PdfTemplateMintEnvelope = {
  artifact: typeof PDF_TEMPLATE_ARTIFACTS.mint;
  summary: string;
  // Carried forward from pdf_template_intake so pdf_template_publish needs only ONE upstream
  // envelope (this one) — mirroring publish_executor's own shape, which reads only publish_payload's
  // output, never reaching past it to clone_intake. Keeps the pdf branch's dependency graph exactly
  // one hop deep at every stage, the same shape the rest of this graph already holds.
  siteId: string | null;
  applied: PdfTemplateMintApplied[];
  rejected: PdfTemplateMintRejected[];
};

type PdfTemplateDesign = { requestedId: string; name?: string; renderer?: unknown; label?: unknown; tags?: unknown; sourceUrl?: unknown; templateJson?: unknown; sampleData?: unknown };

const readDesigns = (design: unknown): PdfTemplateDesign[] => {
  if (!isRecord(design) || !Array.isArray(design.designs)) return [];
  return design.designs.filter((entry): entry is PdfTemplateDesign => isRecord(entry) && nonEmptyString(entry.requestedId));
};

// Bounded, deterministic poll policy — mirrors cloneEngine.ts's OBJECT_CHECKOUT_LOCK_RETRY constants
// in shape (a fixed, named policy the run's own facts never influence) so a validation report that
// never turns terminal fails LOUDLY, named, rather than hanging the run. Real wall-clock delay only
// (deps.sleepImpl is injected in tests so no test ever waits on it) — the delay itself is never
// recorded on anything this stage emits or hashes, exactly like the object_checkout retry it mirrors.
const VALIDATION_POLL_MAX_ATTEMPTS = 6;
const VALIDATION_POLL_INTERVAL_MS = 250;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PASSED_STATUSES = new Set(["PASSED", "passed"]);
const FAILED_STATUSES = new Set(["FAILED", "failed"]);

export async function pdfTemplateMintStep(
  input: { targetProjectId: string; intake: unknown; design: unknown },
  deps: CloneDeps & { sleepImpl?: (ms: number) => Promise<void> } = {}
): Promise<PdfTemplateMintEnvelope> {
  const { projectId } = await resolveCloneAuthority(input.targetProjectId, deps);
  const intake = isRecord(input.intake) && input.intake.artifact === PDF_TEMPLATE_ARTIFACTS.intake ? (input.intake as unknown as PdfTemplateIntakeEnvelope) : undefined;
  if (!intake) {
    throw new CloneRefusal("pdf_template_upstream_artifact_invalid", `Expected pdf_template_intake's stage output to be a ${PDF_TEMPLATE_ARTIFACTS.intake} envelope; found ${isRecord(input.intake) ? `artifact "${String(input.intake.artifact)}"` : "nothing"}.`);
  }
  const siteId = intake.siteId;
  const entriesById = new Map(intake.entries.map((entry) => [entry.requestedId, entry]));
  const designs = readDesigns(input.design);
  const sleep = deps.sleepImpl ?? defaultSleep;

  const applied: PdfTemplateMintApplied[] = [];
  const rejected: PdfTemplateMintRejected[] = [];

  if (!siteId) {
    // intake already named WHY (rejectedEntries carries the reason); mint has nothing to attempt.
    return { artifact: PDF_TEMPLATE_ARTIFACTS.mint, summary: "No usable siteId from pdf_template_intake; nothing minted.", siteId: null, applied, rejected };
  }

  for (const design of designs) {
    const briefEntry = entriesById.get(design.requestedId);
    const name = nonEmptyString(design.name) ? design.name : briefEntry?.name;
    const renderer = isRenderer(design.renderer) ? design.renderer : briefEntry?.renderer;
    const templateJson = isRecord(design.templateJson) && Object.keys(design.templateJson).length > 0 ? design.templateJson : undefined;
    const sampleData = isRecord(design.sampleData) ? design.sampleData : briefEntry?.sampleData;

    if (!briefEntry) {
      rejected.push({ requestedId: design.requestedId, name, code: "pdf_template_design_unrequested", reason: `pdf_template_designer proposed requestedId "${design.requestedId}", which pdf_template_intake never named; a design must correspond to a briefed entry.` });
      continue;
    }
    if (!renderer) {
      rejected.push({ requestedId: design.requestedId, name, code: "pdf_template_renderer_invalid", reason: `No valid renderer (one of ${PDF_RENDERERS.join(", ")}) for "${name ?? design.requestedId}".` });
      continue;
    }
    if (!templateJson) {
      rejected.push({ requestedId: design.requestedId, name, code: "pdf_template_content_missing", reason: `pdf_template_designer proposed no usable templateJson for "${name ?? design.requestedId}"; an empty or non-object template body is never minted.` });
      continue;
    }
    if (rendererRequiresValidation(renderer) && !sampleData) {
      rejected.push({ requestedId: design.requestedId, name, code: "pdf_template_sample_data_missing", reason: `Renderer "${renderer}" requires worst-case sample data to validate ("${name ?? design.requestedId}"), and neither the design nor the brief supplied any.` });
      continue;
    }

    // Deterministic idempotency key: a pure function of the content being created, never of wall
    // clock or a random id — the SAME (siteId, requestedId, renderer, templateJson) always produces
    // the SAME key, so a retried mint of unchanged content is idempotent at the wire, and two
    // independent mints of genuinely different content never collide.
    const idempotencyKey = createHash("sha256")
      .update(canonicalStringify({ siteId, requestedId: design.requestedId, renderer, templateJson }))
      .digest("hex");

    let templateId: string;
    let version: number;
    try {
      const created = await callProjectTool(
        projectId,
        "create_pdf_template",
        { siteId, templateJson, renderer, label: nonEmptyString(design.label) ? design.label : briefEntry.label, tags: briefEntry.tags.length ? briefEntry.tags : undefined, idempotencyKey },
        deps
      );
      const createdTemplateId = typeof created.templateId === "string" ? created.templateId : undefined;
      const createdVersion = typeof created.version === "number" ? created.version : 1;
      if (!createdTemplateId) {
        rejected.push({ requestedId: design.requestedId, name, code: "pdf_template_create_no_id", reason: `create_pdf_template for "${name ?? design.requestedId}" returned no templateId.` });
        continue;
      }
      templateId = createdTemplateId;
      version = createdVersion;
    } catch (error) {
      rejected.push({ requestedId: design.requestedId, name, code: error instanceof CloneRefusal ? error.code : "pdf_template_create_failed", reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    let validated = !rendererRequiresValidation(renderer);
    if (rendererRequiresValidation(renderer)) {
      try {
        const started = await callProjectTool(projectId, "validate_pdf_template", { siteId, templateId, version, data: sampleData }, deps);
        const validationId = typeof started.validationId === "string" ? started.validationId : undefined;
        let terminalStatus: string | undefined;
        let lastReport: Record<string, unknown> | undefined;
        for (let attempt = 1; attempt <= VALIDATION_POLL_MAX_ATTEMPTS; attempt += 1) {
          const report = await callProjectTool(projectId, "get_pdf_template_validation", { siteId, templateId, version, validationId }, deps);
          lastReport = report;
          const status = typeof report.status === "string" ? report.status : undefined;
          if (status && (PASSED_STATUSES.has(status) || FAILED_STATUSES.has(status))) {
            terminalStatus = status;
            break;
          }
          if (attempt < VALIDATION_POLL_MAX_ATTEMPTS) await sleep(VALIDATION_POLL_INTERVAL_MS);
        }
        if (!terminalStatus) {
          rejected.push({ requestedId: design.requestedId, name, code: "pdf_template_validation_timeout", reason: `validate_pdf_template for "${name ?? design.requestedId}" (templateId ${templateId} v${version}) never reached a terminal report after ${VALIDATION_POLL_MAX_ATTEMPTS} bounded poll(s); last known status: ${JSON.stringify(lastReport?.status ?? null)}.` });
          continue;
        }
        if (!PASSED_STATUSES.has(terminalStatus)) {
          rejected.push({ requestedId: design.requestedId, name, code: "pdf_template_validation_failed", reason: `validate_pdf_template for "${name ?? design.requestedId}" (templateId ${templateId} v${version}) reported "${terminalStatus}", not PASSED: ${JSON.stringify(lastReport?.errors ?? lastReport?.detail ?? lastReport?.summary ?? "no further detail on the report")}.` });
          continue;
        }
        validated = true;
      } catch (error) {
        rejected.push({ requestedId: design.requestedId, name, code: error instanceof CloneRefusal ? error.code : "pdf_template_validate_failed", reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    applied.push({ requestedId: design.requestedId, name: name ?? design.requestedId, renderer, templateId, version, validated, label: nonEmptyString(design.label) ? design.label : briefEntry.label, tags: briefEntry.tags, sourceUrl: briefEntry.sourceUrl, templateJson });
  }

  return {
    artifact: PDF_TEMPLATE_ARTIFACTS.mint,
    summary: `PDF-template mint for ${projectId}: ${applied.length} template(s) created and validated, ${rejected.length} rejected.`,
    siteId,
    applied,
    rejected
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: publish — publish_pdf_template for every mint-applied (validated) candidate, deterministic,
// no model call. GATING (operator veto / autonomy policy) happens OUTSIDE this function entirely: the
// executor's generic publish-risk dispatch guard (executor.ts's isPublishRisk/resolvePublishAuthority,
// keyed on this node's OWN riskLevel:"publish" — see cloneConductorNodes.ts's pdf_template_publish)
// refuses to even DISPATCH this stage for an operator-withheld or non-autonomous run. By the time this
// function runs at all, the run's own publish authority has already been checked — this function's
// job is purely "call publish_pdf_template for each candidate", never "decide whether it may".
export type PdfTemplatePublished = { requestedId: string; name: string; templateId: string; version: number };
export type PdfTemplatePublishFailed = { requestedId: string; name: string; templateId: string; version: number; reason: string };
export type PdfTemplatePublishEnvelope = {
  artifact: typeof PDF_TEMPLATE_ARTIFACTS.publish;
  summary: string;
  published: PdfTemplatePublished[];
  failed: PdfTemplatePublishFailed[];
};

export async function pdfTemplatePublishStep(input: { targetProjectId: string; mint: unknown }, deps: CloneDeps = {}): Promise<PdfTemplatePublishEnvelope> {
  const { projectId } = await resolveCloneAuthority(input.targetProjectId, deps);
  const mint = isRecord(input.mint) && input.mint.artifact === PDF_TEMPLATE_ARTIFACTS.mint ? (input.mint as unknown as PdfTemplateMintEnvelope) : undefined;
  if (!mint) {
    throw new CloneRefusal("pdf_template_upstream_artifact_invalid", "pdf_template_publish requires pdf_template_mint's envelope.");
  }
  const siteId = mint.siteId;
  const published: PdfTemplatePublished[] = [];
  const failed: PdfTemplatePublishFailed[] = [];

  if (siteId) {
    for (const entry of mint.applied) {
      if (!entry.validated) {
        failed.push({ requestedId: entry.requestedId, name: entry.name, templateId: entry.templateId, version: entry.version, reason: "not validated at mint (renderer requires a PASSED validation report on file); pdf-tool's own publish_pdf_template would refuse this with TEMPLATE_VALIDATION_REQUIRED." });
        continue;
      }
      try {
        await callProjectTool(projectId, "publish_pdf_template", { siteId, templateId: entry.templateId, version: entry.version }, deps);
        published.push({ requestedId: entry.requestedId, name: entry.name, templateId: entry.templateId, version: entry.version });
      } catch (error) {
        failed.push({ requestedId: entry.requestedId, name: entry.name, templateId: entry.templateId, version: entry.version, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    artifact: PDF_TEMPLATE_ARTIFACTS.publish,
    summary: `PDF-template publish for ${projectId}: ${published.length} template(s) published, ${failed.length} failed.`,
    published,
    failed
  };
}

// ---------------------------------------------------------------------------------------------
// Library deposit — the studio's OWN cross-tenant ledger (#207), for every entry this run actually
// PUBLISHED (never merely minted-as-draft, same "went live in its own store" rule
// depositPublishedTemplatesStep already holds for CMS structure). objectType "pdf_template" was
// already a first-class TemplateLibraryObjectType member (#207) precisely so this task needed no
// library schema change — see templateLibraryTypes.ts, templateSectionTypes.ts.
//
// PROVENANCE: a pdf_template is always deposited with `driven: "demand"` — it is designed from a
// brief, never derived from a captured web snapshot the way a clone-driven section_template/template
// is, so it never states a captureRunId (validateTemplateProvenance only requires one for
// `driven: "clone"`, unchanged, untouched by this task). It still MUST state a sourceUrl to be
// publishable (ADR §4.1's "a template whose provenance cannot be stated is not publishable" is
// universal, not CMS-structure-specific) — an entry whose brief named no sourceUrl deposits nothing
// and is named `refused` in the ledger below, exactly as validateTemplateProvenance already refuses
// it, never silently coerced into a placeholder URL.
export async function depositPublishedPdfTemplatesStep(
  input: { sourceProjectId: string; mint: unknown; published: PdfTemplatePublished[] },
  deps: CloneDeps = {}
): Promise<LibraryDepositLedger> {
  const ledger: LibraryDepositLedger = { deposited: [], unchanged: [], refused: [] };
  if (input.published.length === 0) return ledger;
  const mint = isRecord(input.mint) && input.mint.artifact === PDF_TEMPLATE_ARTIFACTS.mint ? (input.mint as unknown as PdfTemplateMintEnvelope) : undefined;
  if (!mint) return ledger;
  const mintedById = new Map(mint.applied.map((entry) => [entry.requestedId, entry]));

  const store = deps.templateLibraryStore ?? new TemplateLibraryStore();
  for (const entry of input.published) {
    const minted = mintedById.get(entry.requestedId);
    if (!minted) {
      ledger.refused.push({ objectId: entry.templateId, requestedId: entry.requestedId, code: "pdf_template_deposit_source_missing", reason: "publish_executor named this templateId as published, but pdf_template_mint's own applied ledger no longer names it — never deposited without the minted body to deposit." });
      continue;
    }
    try {
      const templateId = buildPdfTemplateId({ sourceProjectId: input.sourceProjectId, requestedId: entry.requestedId });
      const result: { outcome: "minted" | "unchanged"; record: TemplateLibraryRecord } = await store.publish({
        templateId,
        objectType: "pdf_template",
        name: entry.name,
        recipe: minted.templateJson,
        sourceProjectId: input.sourceProjectId,
        provenance: { sourceUrl: minted.sourceUrl, driven: "demand" }
      });
      const row = { templateId: result.record.templateId, version: result.record.version, objectId: entry.templateId };
      if (result.outcome === "minted") ledger.deposited.push(row);
      else ledger.unchanged.push(row);
    } catch (error) {
      const refusal = error instanceof TemplateLibraryRefusal ? { code: error.code, reason: error.message } : { code: "pdf_template_deposit_failed", reason: error instanceof Error ? error.message : String(error) };
      ledger.refused.push({ objectId: entry.templateId, requestedId: entry.requestedId, ...refusal });
    }
  }
  return ledger;
}
