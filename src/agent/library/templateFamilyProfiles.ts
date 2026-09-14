// A7 — seeded PDF template-family profiles. One family DESIGN produces several RELATED variants
// (newsletter / article / download, ...) instead of requiring a caller to describe each document
// from scratch every time. Deterministic, pure data: no tenant call, no model call, no clock. A
// profile names WHAT to design (a renderer default, a purpose, tags) — pdf_template_designer (the
// one model judgment reused verbatim from the existing PDF branch, cloneConductorNodes.ts) still
// decides HOW to lay each variant out; this module never proposes template_json content itself.
//
// "nonprofit_standard" is the one seeded profile the A7 acceptance criteria name directly ("three
// standard nonprofit templates reach a reviewable family diff"). Adding a further profile here is
// additive: it requires no change to the workflow graph, the deterministic routes, or any existing
// test — pdfTemplateFamilyEngine.ts's pdfTemplateFamilyPlanStep resolves a profile by name alone.
export type PdfFamilyRenderer = "pdfme" | "react-pdf" | "typst" | "chromium";

export type PdfFamilyVariantProfile = {
  // Stable short name inside a family — "newsletter", "article", "download". Combined with the
  // family's own id to form a deterministic, idempotent requestedId (pdfTemplateFamilyEngine.ts's
  // buildFamilyRequestedId) so the SAME family+variant always names the SAME underlying pdf-tool
  // template across runs — the identity a revision reuses instead of minting a duplicate.
  variant: string;
  name: string;
  renderer: PdfFamilyRenderer;
  purpose: string;
  tags: string[];
};

export const TEMPLATE_FAMILY_PROFILES: Readonly<Record<string, readonly PdfFamilyVariantProfile[]>> = {
  nonprofit_standard: [
    {
      variant: "newsletter",
      name: "Newsletter",
      renderer: "pdfme",
      purpose: "A recurring, multi-page newsletter issue for supporters — the family's periodical variant.",
      tags: ["newsletter"]
    },
    {
      variant: "article",
      name: "Article Brief",
      renderer: "pdfme",
      purpose: "A single-article export brief, suitable for one story, update or press item.",
      tags: ["article", "brief"]
    },
    {
      variant: "download",
      name: "Downloadable Guide",
      renderer: "pdfme",
      purpose: "A longer-form downloadable guide or report for the public — the family's evergreen variant.",
      tags: ["download", "guide"]
    }
  ]
};

export const DEFAULT_TEMPLATE_FAMILY_USE_CASE = "nonprofit_standard";

// undefined (never a thrown error, never a guessed fallback) when the caller names a useCase this
// build has no seeded profile for — the caller (pdfTemplateFamilyPlanStep) turns that into a named,
// non-blocking rejectedEntries reason rather than silently substituting a different profile.
export function resolveFamilyProfile(useCase: string | undefined): readonly PdfFamilyVariantProfile[] | undefined {
  const key = useCase && useCase.trim() ? useCase.trim() : DEFAULT_TEMPLATE_FAMILY_USE_CASE;
  return TEMPLATE_FAMILY_PROFILES[key];
}

export function listTemplateFamilyUseCases(): string[] {
  return Object.keys(TEMPLATE_FAMILY_PROFILES).sort();
}
