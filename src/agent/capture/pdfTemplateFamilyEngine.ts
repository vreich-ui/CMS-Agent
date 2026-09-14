// A7 — the PDF template-family engine: composes the EXISTING PDF branch (pdfTemplateEngine.ts's
// pdfTemplateIntakeStep/pdfTemplateMintStep/pdfTemplatePublishStep/depositPublishedPdfTemplatesStep,
// reused UNCHANGED and imported, never reimplemented) into a standalone family workflow. This module
// adds exactly the three things the existing branch does not have and A7 asks for:
//
//   1. FAMILY EXPANSION + REUSE/REVISION (pdfTemplateFamilyPlanStep). One family design (a seeded
//      profile, templateFamilyProfiles.ts) expands into several concrete variants — newsletter,
//      article, download — each with a DETERMINISTIC requestedId (buildFamilyRequestedId: pure
//      function of familyId+variant, never a name-derived slug with a de-dupe suffix the way the
//      base branch's pdfTemplateIntakeStep computes it). The SAME requestedId therefore names the
//      SAME underlying pdf-tool template on every run: a rerun with an unchanged brief finds that
//      template already in the cross-tenant TemplateLibraryStore (#207) and REUSES it — no design
//      call, no mint call, no duplicate family — and an explicit revision (brief.revise naming the
//      variant) targets that SAME template id for its next version rather than minting a new family.
//
//   2. CONTRACT-VALIDATED RENDERER PAYLOADS (validatePdfRendererPayloadContract /
//      filterDesignsByContract / pdfTemplateFamilyMintStep). pdf_template_designer's proposed
//      template_json is checked against a per-renderer STRUCTURAL contract — pdfme needs a
//      `schemas` array, chromium needs `html`/`css` strings, typst needs a `source` string, every
//      non-pdfme renderer needs sample data — BEFORE it ever reaches create_pdf_template. A design
//      that fails this contract is filtered out and named in `contractRejected`; only the survivors
//      are handed to pdfTemplateMintStep, UNCHANGED, which independently re-validates through
//      pdf-tool's own create -> validate -> poll discipline. This makes publish-before-validation
//      structurally impossible in two independent ways at once: a contract-invalid design never
//      reaches create_pdf_template, and (pdfTemplateMintStep's own, untouched, discipline)
//      pdfTemplatePublishStep only ever iterates `mint.applied`, which pdfTemplateMintStep populates
//      only after a renderer that requires it reaches a PASSED validation report on file.
//
//   3. THE TWO-STEP REPORT (buildPdfTemplateFamilyReportStep). Template-store publication
//      (pdf-tool's own publish_pdf_template — "templateStorePublication" below) and the cross-tenant
//      library/export deposit ("libraryExport" below) are reported as two SEPARATE ledgers, never
//      merged into one object the way the base branch's "pdf_publish" stage does inline
//      (cloneConductorRoutes.ts) — see pdfTemplateStudioNodes.ts's own header for why the studio
//      workflow dispatches them as two separate NODES rather than reusing that merged stage.
//      Every variant the family attempted is named exactly once in `variants[]` with one of a fixed
//      set of outcomes — "reused" | "published" | "contract_rejected" | "mint_rejected" |
//      "publish_failed" | "library_export_refused" | "family_plan_rejected" — so a failed variant
//      can never be folded into an "all done" summary, and `partial`/`allFailed` are computed from
//      that same ledger, never asserted separately.
import { TemplateLibraryStore } from "../library/templateLibraryStore.js";
import { resolveFamilyProfile, DEFAULT_TEMPLATE_FAMILY_USE_CASE } from "../library/templateFamilyProfiles.js";
import type { LibraryDepositLedger, CloneDeps } from "./cloneEngine.js";
import {
  PDF_TEMPLATE_ARTIFACTS,
  pdfTemplateMintStep,
  type PdfTemplateIntakeEntry,
  type PdfTemplateMintEnvelope,
  type PdfTemplatePublishEnvelope,
  type PdfRenderer
} from "./pdfTemplateEngine.js";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const PDF_RENDERERS = ["pdfme", "react-pdf", "typst", "chromium"] as const;
const isRenderer = (value: unknown): value is PdfRenderer => typeof value === "string" && (PDF_RENDERERS as readonly string[]).includes(value);
const slugify = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "x";

export const PDF_FAMILY_ARTIFACTS = {
  // The plan envelope is deliberately SHAPE-compatible with the base branch's own
  // pdf_template_intake.v1 (PDF_TEMPLATE_ARTIFACTS.intake) — see this module's header point 1 — so
  // pdfTemplateFamilyMintStep and pdfTemplatePublishStep (reused, unmodified) accept it without any
  // shape translation. It is, as of A10-D5, a DISTINCT artifact STRING from PDF_TEMPLATE_ARTIFACTS.
  // intake (PDF_TEMPLATE_ARTIFACTS.familyIntake) — reusing the exact same string used to mean the
  // two shapes could never be told apart by cloneConductorRoutes.ts's envelopeOf artifact check
  // (both stages, until A10-D5, also shared clone_conductor's own node ids — see
  // pdfTemplateStudioNodes.ts's header) — pdfTemplateMintStep accepts both.
  plan: PDF_TEMPLATE_ARTIFACTS.familyIntake,
  libraryDeposit: "pdf_template_family_library_deposit.v1",
  report: "pdf_template_family_report.v1"
} as const;

// Deterministic, idempotent: the SAME (familyId, variant) always names the SAME requestedId, which
// (via buildFamilyLibraryTemplateId below, mirroring pdfTemplateEngine.ts's buildPdfTemplateId — see
// depositPublishedPdfTemplatesStep's own comment on why it cannot reach into templateIdentity.ts)
// always names the SAME cross-tenant library templateId. This determinism IS the reuse/revision
// mechanism: a rerun computes the exact same id and finds the exact same library record; an explicit
// revision targets that same id's NEXT version rather than minting a new one.
export function buildFamilyRequestedId(input: { familyId: string; variant: string }): string {
  return `family-${slugify(input.familyId)}-${slugify(input.variant)}`;
}

export function buildFamilyLibraryTemplateId(input: { sourceProjectId: string; requestedId: string }): string {
  return `${input.sourceProjectId.trim()}::pdf_template::${input.requestedId.trim()}`;
}

export type PdfTemplateFamilyReuseEntry = { variant: string; requestedId: string; templateId: string; version: number; name: string };

export type PdfTemplateFamilyPlanEnvelope = {
  artifact: typeof PDF_FAMILY_ARTIFACTS.plan;
  summary: string;
  siteId: string | null;
  entries: PdfTemplateIntakeEntry[];
  rejectedEntries: Array<{ index: number; name?: string; reason: string }>;
  familyId: string | null;
  useCase: string | null;
  // Every entry in `entries` by its own requestedId, so a later stage (the report) can recover which
  // VARIANT a requestedId names without re-deriving it from the id string.
  entryVariants: Record<string, string>;
  reused: PdfTemplateFamilyReuseEntry[];
  revisedVariants: string[];
};

// ---------------------------------------------------------------------------------------------
// Stage: family plan — total, deterministic except for one bounded read per variant against the
// cross-tenant TemplateLibraryStore (never a tenant/pdf-tool call). Normalizes
// initialInput.pdfTemplateFamilyBrief, expands it against a seeded profile
// (templateFamilyProfiles.ts), and decides — PER VARIANT, before any design turn is spent — whether
// this run REUSES an already-published template unchanged or needs a fresh design.
export async function pdfTemplateFamilyPlanStep(
  input: { initialInput: unknown; targetProjectId: string },
  deps: { templateLibraryStore?: TemplateLibraryStore } = {}
): Promise<PdfTemplateFamilyPlanEnvelope> {
  const initial = isRecord(input.initialInput) ? input.initialInput : {};
  const brief = isRecord(initial.pdfTemplateFamilyBrief) ? initial.pdfTemplateFamilyBrief : undefined;
  const empty = (
    summary: string,
    rejectedEntries: PdfTemplateFamilyPlanEnvelope["rejectedEntries"] = [],
    siteId: string | null = null,
    familyId: string | null = null,
    useCase: string | null = null
  ): PdfTemplateFamilyPlanEnvelope => ({
    artifact: PDF_FAMILY_ARTIFACTS.plan,
    summary,
    siteId,
    entries: [],
    rejectedEntries,
    familyId,
    useCase,
    entryVariants: {},
    reused: [],
    revisedVariants: []
  });

  if (!brief) {
    return empty("No pdfTemplateFamilyBrief on this run's initialInput; there is no PDF-template-family work for this run.");
  }

  const siteId = nonEmptyString(brief.siteId) ? brief.siteId.trim() : null;
  const familyId = nonEmptyString(brief.familyId) ? brief.familyId.trim() : null;
  const useCase = nonEmptyString(brief.useCase) ? brief.useCase.trim() : DEFAULT_TEMPLATE_FAMILY_USE_CASE;
  const profile = resolveFamilyProfile(useCase);

  const rejectedEntries: PdfTemplateFamilyPlanEnvelope["rejectedEntries"] = [];
  if (!siteId) rejectedEntries.push({ index: -1, reason: "pdfTemplateFamilyBrief.siteId is missing or empty; every pdf-tool call is site-scoped and none of this family's variants can proceed without one." });
  if (!familyId) rejectedEntries.push({ index: -1, reason: "pdfTemplateFamilyBrief.familyId is missing or empty; a family needs a stable identity for reuse/revision to target." });
  if (!profile) rejectedEntries.push({ index: -1, reason: `Unknown useCase "${useCase}"; no seeded family profile matches it (see templateFamilyProfiles.ts's TEMPLATE_FAMILY_PROFILES).` });

  if (!siteId || !familyId || !profile) {
    return empty(`PDF-template-family brief incomplete: ${rejectedEntries.length} problem(s).`, rejectedEntries, siteId, familyId, useCase);
  }

  const overridesRaw = Array.isArray(brief.variants) ? brief.variants : [];
  const overridesByVariant = new Map<string, Record<string, unknown>>();
  for (const raw of overridesRaw) {
    if (isRecord(raw) && nonEmptyString(raw.variant)) overridesByVariant.set(raw.variant.trim(), raw);
  }
  const reviseSet = new Set<string>(
    Array.isArray(brief.revise) ? brief.revise.filter(nonEmptyString).map((value: string) => value.trim()) : []
  );
  const sourceUrl = nonEmptyString(brief.sourceUrl) ? brief.sourceUrl.trim() : undefined;

  const profileVariantNames = profile.map((entry) => entry.variant);
  const extraVariantNames = [...overridesByVariant.keys()].filter((name) => !profileVariantNames.includes(name));
  const variantNames = [...profileVariantNames, ...extraVariantNames];

  const store = deps.templateLibraryStore ?? new TemplateLibraryStore();
  const entries: PdfTemplateIntakeEntry[] = [];
  const entryVariants: Record<string, string> = {};
  const reused: PdfTemplateFamilyReuseEntry[] = [];
  const revisedVariants: string[] = [];

  for (const variantName of variantNames) {
    const base = profile.find((entry) => entry.variant === variantName);
    const override = overridesByVariant.get(variantName);
    const name = nonEmptyString(override?.name) ? String(override!.name).trim() : base?.name;
    if (!name) {
      rejectedEntries.push({ index: -1, name: variantName, reason: `Variant "${variantName}" has no name — a variant outside the seeded profile must supply one via pdfTemplateFamilyBrief.variants.` });
      continue;
    }
    const renderer: PdfRenderer = isRenderer(override?.renderer) ? (override!.renderer as PdfRenderer) : (base?.renderer ?? "pdfme");
    const purpose = nonEmptyString(override?.purpose) ? String(override!.purpose).trim() : base?.purpose;
    const tags = Array.isArray(override?.tags) ? override!.tags.filter(nonEmptyString).map((tag: string) => tag.trim()) : base ? [...base.tags] : [];
    const requestedId = buildFamilyRequestedId({ familyId, variant: variantName });
    const templateId = buildFamilyLibraryTemplateId({ sourceProjectId: input.targetProjectId, requestedId });
    const forceRevise = reviseSet.has(variantName);

    let existing: Awaited<ReturnType<TemplateLibraryStore["getLatest"]>>;
    try {
      existing = await store.getLatest(templateId);
    } catch {
      // A lookup failure never blocks the family — worst case it designs a variant that turns out
      // unchanged, which the library's own idempotent publish() still resolves to "unchanged" (see
      // depositPublishedPdfTemplatesStep). It never silently skips a variant on an unproven "exists".
      existing = undefined;
    }

    if (existing && !forceRevise) {
      reused.push({ variant: variantName, requestedId, templateId, version: existing.version, name });
      continue;
    }
    if (existing && forceRevise) revisedVariants.push(variantName);

    entryVariants[requestedId] = variantName;
    entries.push({
      requestedId,
      name,
      renderer,
      label: nonEmptyString(override?.label) ? String(override!.label).trim() : undefined,
      tags,
      sourceUrl,
      purpose,
      contentOutline: override?.contentOutline,
      sampleData: isRecord(override?.sampleData) ? (override!.sampleData as Record<string, unknown>) : undefined
    });
  }

  return {
    artifact: PDF_FAMILY_ARTIFACTS.plan,
    summary: `PDF template family "${familyId}" (${useCase}): ${entries.length} variant(s) to design, ${reused.length} reused unchanged${rejectedEntries.length ? `, ${rejectedEntries.length} problem(s)` : ""}.`,
    siteId,
    entries,
    rejectedEntries,
    familyId,
    useCase,
    entryVariants,
    reused,
    revisedVariants
  };
}

// ---------------------------------------------------------------------------------------------
// Contract validation — see this module's header point 2. Pure, total, deterministic: no wire call,
// no tenant call. Every check here is a STRUCTURAL fact about the payload a renderer actually needs;
// it never second-guesses content quality, wording, or layout — pdf-tool's own validate_pdf_template
// (still run, unchanged, inside pdfTemplateMintStep below) is the authority on whether a
// structurally-valid payload actually renders.
export type PdfRendererContractResult = { ok: true } | { ok: false; code: string; reason: string };

export function validatePdfRendererPayloadContract(input: { renderer: PdfRenderer; templateJson: unknown; sampleData?: unknown }): PdfRendererContractResult {
  const { renderer, templateJson } = input;
  if (!isRecord(templateJson) || Object.keys(templateJson).length === 0) {
    return { ok: false, code: "pdf_template_contract_content_missing", reason: `Renderer "${renderer}" template payload must be a non-empty object.` };
  }
  if (renderer === "pdfme") {
    if (!Array.isArray(templateJson.schemas)) {
      return { ok: false, code: "pdf_template_contract_pdfme_schema_invalid", reason: 'A pdfme template payload requires a "schemas" array; none was found.' };
    }
  } else if (renderer === "chromium") {
    const html = templateJson.html;
    const css = templateJson.css;
    if (typeof html !== "string" || !html.trim()) {
      return { ok: false, code: "pdf_template_contract_chromium_html_invalid", reason: 'A chromium template payload requires a non-empty "html" string.' };
    }
    if (typeof css !== "string") {
      return { ok: false, code: "pdf_template_contract_chromium_css_invalid", reason: 'A chromium template payload requires a "css" string (may be empty).' };
    }
  } else if (renderer === "typst") {
    const source = templateJson.source;
    if (typeof source !== "string" || !source.trim()) {
      return { ok: false, code: "pdf_template_contract_typst_source_invalid", reason: 'A typst template payload requires a non-empty "source" string.' };
    }
  }
  // react-pdf: no further published shape to check beyond "a non-empty object" — see this module's
  // header; pdf-tool's own validate_pdf_template remains the authority for that renderer.
  if (renderer !== "pdfme") {
    if (!isRecord(input.sampleData) || Object.keys(input.sampleData).length === 0) {
      return { ok: false, code: "pdf_template_contract_sample_data_missing", reason: `Renderer "${renderer}" requires non-empty sample data to satisfy its render contract before minting.` };
    }
  }
  return { ok: true };
}

export type PdfTemplateFamilyContractRejection = { requestedId: string; name?: string; code: string; reason: string };

// Splits pdf_template_designer's raw designs into contract-valid survivors (passed through
// byte-identical — this function never rewrites a design) and named rejections. `intake` is
// OPTIONAL but, when supplied, resolves a design's renderer/sampleData with the EXACT SAME fallback
// pdfTemplateMintStep itself applies (design's own field, else the briefed intake entry's) — this
// must match that fallback exactly, or a design that STATES no renderer explicitly (relying on the
// brief's own default, e.g. every nonprofit_standard variant's seeded "pdfme") would sail through
// this contract gate unchecked and only be judged for the first time by pdf-tool's own
// create_pdf_template, which is exactly the "not merely discouraged" gap this stage exists to close.
// A design with NO resolvable renderer at all (neither its own field nor a matching brief entry) is
// still passed through UNCHECKED here (there is genuinely no renderer to validate against) so
// pdfTemplateMintStep's own "no valid renderer" rejection fires exactly as it already does; this
// function only ever ADDS rejections, never removes the ones downstream already names.
export function filterDesignsByContract(design: unknown, intake?: unknown): { validDesigns: unknown[]; contractRejected: PdfTemplateFamilyContractRejection[] } {
  const designs = isRecord(design) && Array.isArray(design.designs) ? design.designs : [];
  const entries = isRecord(intake) && Array.isArray(intake.entries) ? (intake.entries as PdfTemplateIntakeEntry[]) : [];
  const entriesById = new Map(entries.filter((entry) => nonEmptyString(entry?.requestedId)).map((entry) => [entry.requestedId, entry]));
  const validDesigns: unknown[] = [];
  const contractRejected: PdfTemplateFamilyContractRejection[] = [];
  for (const raw of designs) {
    if (!isRecord(raw) || !nonEmptyString(raw.requestedId)) continue;
    const briefEntry = entriesById.get(raw.requestedId);
    const renderer = isRenderer(raw.renderer) ? raw.renderer : briefEntry?.renderer;
    if (!renderer) {
      validDesigns.push(raw);
      continue;
    }
    const sampleData = isRecord(raw.sampleData) ? raw.sampleData : briefEntry?.sampleData;
    const check = validatePdfRendererPayloadContract({ renderer, templateJson: raw.templateJson, sampleData });
    if (check.ok) validDesigns.push(raw);
    else contractRejected.push({ requestedId: raw.requestedId, name: nonEmptyString(raw.name) ? raw.name : undefined, code: check.code, reason: check.reason });
  }
  return { validDesigns, contractRejected };
}

export type PdfTemplateFamilyMintEnvelope = PdfTemplateMintEnvelope & { contractRejected: PdfTemplateFamilyContractRejection[] };

// Reuses pdfTemplateMintStep UNCHANGED — this wrapper's only job is to keep a contract-invalid
// design from ever reaching it. A design pdfTemplateMintStep itself then rejects (bad renderer, no
// sample data pdf-tool's own validate fails, ...) is STILL reported, merged after the contract
// rejections, so `rejected` in the returned envelope names every reason a variant did not mint —
// contract or pdf-tool's own — with nothing dropped.
export async function pdfTemplateFamilyMintStep(
  input: { targetProjectId: string; intake: unknown; design: unknown },
  deps: CloneDeps & { sleepImpl?: (ms: number) => Promise<void> } = {}
): Promise<PdfTemplateFamilyMintEnvelope> {
  const { validDesigns, contractRejected } = filterDesignsByContract(input.design, input.intake);
  const source = isRecord(input.design) ? input.design : {};
  const filteredDesign = { ...source, designs: validDesigns };
  const minted = await pdfTemplateMintStep({ targetProjectId: input.targetProjectId, intake: input.intake, design: filteredDesign }, deps);
  return {
    ...minted,
    rejected: [...contractRejected.map(({ requestedId, name, code, reason }) => ({ requestedId, name, code, reason })), ...minted.rejected],
    contractRejected
  };
}

// ---------------------------------------------------------------------------------------------
// The terminal report — see this module's header point 3. Deterministic, engine-authored: every
// field is read back from the plan/mint/publish/library envelopes already produced upstream, in
// THIS run; nothing here is re-judged or re-derived from raw initialInput.
export type PdfTemplateFamilyVariantOutcome =
  | "reused"
  | "published"
  | "contract_rejected"
  | "mint_rejected"
  | "publish_failed"
  | "library_export_refused"
  | "family_plan_rejected";

export type PdfTemplateFamilyVariantLedgerEntry = {
  variant: string;
  requestedId: string;
  outcome: PdfTemplateFamilyVariantOutcome;
  detail?: string;
};

export type PdfTemplateFamilyReport = {
  artifact: typeof PDF_FAMILY_ARTIFACTS.report;
  summary: string;
  familyId: string | null;
  useCase: string | null;
  reused: PdfTemplateFamilyReuseEntry[];
  revisedVariants: string[];
  // STEP A — pdf-tool's own template-store publication (publish_pdf_template). Deliberately a
  // SEPARATE block from `libraryExport` below — see this module's header point 3.
  templateStorePublication: { published: PdfTemplatePublishEnvelope["published"]; failed: PdfTemplatePublishEnvelope["failed"] };
  // STEP B — the cross-tenant library deposit (#207), a DIFFERENT store than pdf-tool's own and a
  // DIFFERENT step than STEP A: a template can be published in pdf-tool's store and still be
  // refused here (an unstateable provenance), and this block never implies STEP A happened for an
  // entry it does not name.
  libraryExport: { attempted: true; deposited: LibraryDepositLedger["deposited"]; unchanged: LibraryDepositLedger["unchanged"]; refused: LibraryDepositLedger["refused"] } | { attempted: false };
  variants: PdfTemplateFamilyVariantLedgerEntry[];
  // true iff at least one attempted variant succeeded (reused or published) AND at least one failed
  // — the honest middle ground between "all done" and "nothing worked". Computed from `variants`
  // alone, never asserted independently of it.
  partial: boolean;
  allFailed: boolean;
};

export function buildPdfTemplateFamilyReportStep(input: {
  plan: PdfTemplateFamilyPlanEnvelope;
  mint?: PdfTemplateFamilyMintEnvelope;
  publish?: PdfTemplatePublishEnvelope;
  library?: LibraryDepositLedger;
}): PdfTemplateFamilyReport {
  const { plan, mint, publish, library } = input;
  const variants: PdfTemplateFamilyVariantLedgerEntry[] = [];

  for (const reuse of plan.reused) {
    variants.push({ variant: reuse.variant, requestedId: reuse.requestedId, outcome: "reused", detail: `Reused existing templateId "${reuse.templateId}" v${reuse.version} unchanged; not redesigned.` });
  }

  const contractRejectedById = new Map((mint?.contractRejected ?? []).map((entry) => [entry.requestedId, entry]));
  const mintRejectedById = new Map((mint?.rejected ?? []).filter((entry) => !contractRejectedById.has(entry.requestedId)).map((entry) => [entry.requestedId, entry]));
  const appliedById = new Map((mint?.applied ?? []).map((entry) => [entry.requestedId, entry]));
  const publishedById = new Map((publish?.published ?? []).map((entry) => [entry.requestedId, entry]));
  const publishFailedById = new Map((publish?.failed ?? []).map((entry) => [entry.requestedId, entry]));
  const libraryRefusedByRequestedId = new Map((library?.refused ?? []).map((entry) => [entry.requestedId, entry]));

  for (const [requestedId, variantName] of Object.entries(plan.entryVariants)) {
    const contractRejection = contractRejectedById.get(requestedId);
    if (contractRejection) {
      variants.push({ variant: variantName, requestedId, outcome: "contract_rejected", detail: contractRejection.reason });
      continue;
    }
    const mintRejection = mintRejectedById.get(requestedId);
    if (mintRejection) {
      variants.push({ variant: variantName, requestedId, outcome: "mint_rejected", detail: mintRejection.reason });
      continue;
    }
    if (!appliedById.has(requestedId)) {
      // Neither contract-rejected, mint-rejected, nor applied: the branch never reached this
      // variant at all (e.g. the run halted before mint) — named honestly rather than omitted.
      variants.push({ variant: variantName, requestedId, outcome: "mint_rejected", detail: "No mint outcome recorded for this variant; the run did not reach a mint decision." });
      continue;
    }
    if (publishedById.has(requestedId)) {
      const libraryRefusal = libraryRefusedByRequestedId.get(requestedId);
      if (libraryRefusal) {
        variants.push({ variant: variantName, requestedId, outcome: "library_export_refused", detail: libraryRefusal.reason });
      } else {
        variants.push({ variant: variantName, requestedId, outcome: "published" });
      }
      continue;
    }
    const publishFailure = publishFailedById.get(requestedId);
    if (publishFailure) {
      variants.push({ variant: variantName, requestedId, outcome: "publish_failed", detail: publishFailure.reason });
      continue;
    }
    variants.push({ variant: variantName, requestedId, outcome: "publish_failed", detail: "No publish outcome recorded for this variant; the run did not reach a publish decision." });
  }

  for (const rejection of plan.rejectedEntries) {
    variants.push({ variant: rejection.name ?? "(family-level)", requestedId: "(family-level)", outcome: "family_plan_rejected", detail: rejection.reason });
  }

  const succeeded = variants.filter((entry) => entry.outcome === "reused" || entry.outcome === "published").length;
  const failed = variants.length - succeeded;
  const partial = succeeded > 0 && failed > 0;
  const allFailed = variants.length > 0 && succeeded === 0;

  return {
    artifact: PDF_FAMILY_ARTIFACTS.report,
    summary: `PDF template family "${plan.familyId ?? "(none)"}": ${succeeded} variant(s) reused/published, ${failed} failed/rejected, of ${variants.length} named.`,
    familyId: plan.familyId,
    useCase: plan.useCase,
    reused: plan.reused,
    revisedVariants: plan.revisedVariants,
    templateStorePublication: { published: publish?.published ?? [], failed: publish?.failed ?? [] },
    libraryExport: library ? { attempted: true, deposited: library.deposited, unchanged: library.unchanged, refused: library.refused } : { attempted: false },
    variants,
    partial,
    allFailed
  };
}
