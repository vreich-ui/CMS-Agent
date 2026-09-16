// The capability vocabulary (R1 — capability-readiness hardening). A CLOSED, code-defined registry
// of every capability id an operation descriptor is allowed to name in its own `requiredCapabilities`
// array (operationTypes.ts). Nothing else defines this vocabulary and nothing else may grow it: a
// descriptor requiring a capability not registered here fails loudly at import time
// (operationCatalog.ts's registerOperation(), mirroring the OPERATION_ID_PATTERN / duplicate-key
// discipline that module already enforces for operation ids themselves).
//
// THE DEFECT THIS CLOSES. Before this file existed, `asset_search`, `pdf_render`,
// `visual_identity_read`, `visual_identity_propose`, `site_inventory_read`, `image_search`,
// `image_template_write`, `pdf_template_write` and `pdf_template_publish` appeared ONLY inside the
// six descriptor files (descriptors/*.ts) as bare string literals — nothing defined the vocabulary,
// nothing validated a descriptor's use of it, and nothing said what "available" would even mean for
// one of them. A descriptor could require a capability no tenant could ever satisfy and nothing would
// notice. This file is the vocabulary half of the fix; capabilityReadiness.ts is the derivation half
// — it turns a tenant's real, loaded facts into which of these ids are actually available, never a
// caller's say-so (see that module's own header for why `configuredCapabilities` can no longer widen
// availability on its own).
//
// WHAT `evidence` IS, AND IS NOT. Each entry's `evidence` field is PROSE — a one-sentence statement of
// what real, already-loaded fact about a tenant would make this capability available. It exists so a
// reader (or a later task extending capabilityReadiness.ts's derivation table) has one place that
// states the intended evidence in words, next to the id and its description. It is documentation, not
// executable policy: capabilityReadiness.ts's own REQUIREMENTS table is the actual derivation logic,
// and a test (capabilityReadiness.test.ts) asserts every id below has a matching rule there. Changing
// what counts as evidence for a capability means changing capabilityReadiness.ts; changing this file
// only changes which capability ids exist at all.
//
// POPULATED FROM THE LIVE DESCRIPTORS, NOTHING INVENTED. Every id below is copied from a
// `requiredCapabilities` array in descriptors/*.ts as it stands today — ten ids total (the ninth
// through A10; the tenth, image_annotate, added by T3 of the 2026-09-16 annotate-bridge plan for
// descriptors/imageAnnotation.ts), one shared
// pair (visual_identity_read/visual_identity_propose) used by the one bound operation
// (visualIdentityReviewChange.ts) and the other seven spread across the five unbound ones
// (siteInventory.ts, assetLookupAdopt.ts, documentRender.ts, pdfTemplateFamily.ts,
// imageTemplateRevision.ts, imageAnnotation.ts). Adding an id here with no descriptor requiring it, or a descriptor
// requiring an id not added here, are both refused: the former by nothing (an unused
// vocabulary entry is harmless — see isKnownCapability's own doc comment) and the latter by
// registerOperation()'s new check.

export type CapabilityVocabularyEntry = {
  id: string;
  // One line: what an operation gains by having this capability.
  description: string;
  // One sentence, prose: what real evidence about a tenant would make this capability available. See
  // module header — capabilityReadiness.ts's REQUIREMENTS table is the actual derivation this
  // describes, kept in sync by capabilityReadiness.test.ts's exhaustiveness check.
  evidence: string;
};

// Declaration order mirrors the descriptor files' own read order (siteInventory, then the two
// visual-identity capabilities, then documentRender, pdfTemplateFamily's two, assetLookupAdopt,
// imageTemplateRevision's two) — listCapabilityIds() below sorts before returning, so this order is
// for a human reader only and carries no behavioral meaning.
const CAPABILITY_VOCABULARY: readonly CapabilityVocabularyEntry[] = [
  {
    id: "site_inventory_read",
    description: "Read a tenant's current object inventory (what exists, its type and status) and its change history.",
    evidence: "The project's own tool policy resolves \"object_inventory\" to \"allowed\" for this tenant (effectiveToolPermission), and the project is active."
  },
  {
    id: "visual_identity_read",
    description: "Read a tenant's current visual identity standard (colors, imagery, theme) as a governed object.",
    evidence: "The tenant has a configured object dialect (a visual_identity_standard object has an addressable home) and its tool policy allows \"object_get\", with the project active."
  },
  {
    id: "visual_identity_propose",
    description: "File a proposed change to a tenant's visual identity standard as a new draft object for operator review. Never applies the change itself.",
    evidence: "The tenant has a configured object dialect and its tool policy allows \"object_create\" (the verb a draft proposal object is filed through), with the project active."
  },
  {
    id: "asset_search",
    description: "Search a tenant's existing typed assets (capture artifacts, stored media, content-linked assets) by query.",
    evidence: "The project's own tool policy resolves \"search_artifacts\" to \"allowed\" for this tenant, and the project is active."
  },
  {
    id: "pdf_render",
    description: "Render an existing article or structured document into a PDF artifact via an already-published template.",
    evidence: "The project's own tool policy resolves \"render_article_pdf\" to \"allowed\" for this tenant, and the project is active."
  },
  {
    id: "pdf_template_write",
    description: "Create or revise a family of related PDF templates for a tenant.",
    evidence: "The project's own tool policy resolves \"create_pdf_template\" to \"allowed\" for this tenant, and the project is active."
  },
  {
    id: "pdf_template_publish",
    description: "Publish a validated PDF template family so it can be used to render documents.",
    evidence: "The project's own tool policy resolves \"publish_pdf_template\" to \"allowed\" for this tenant, and the project is active."
  },
  {
    id: "image_search",
    description: "Search for candidate images to place into a web page template.",
    evidence: "The project's own tool policy resolves \"search_images\" to \"allowed\" for this tenant, and the project is active."
  },
  {
    id: "image_annotate",
    description: "Draw a deterministic annotation layer (a caption, a title, a label, a numbered badge) over an image already stored on the tenant plane, saving the result as a NEW image artifact.",
    evidence: "The project's own tool policy resolves \"annotate_image\" to \"allowed\" for this tenant, and the project is active — that is the WRITE verb of the pair image_annotation declares (analyze_image_layout is its read half and gates nothing on its own)."
  },
  {
    id: "image_template_write",
    description: "Revise images and their placements within a batch of page templates (pdf targets today; a \"web\" target is a named per-item gap the run itself reports).",
    evidence: "The project's own tool policy resolves \"create_pdf_template\" to \"allowed\" for this tenant, and the project is active — that is the write verb image_revision_apply performs, through pdfTemplateEngine.ts's own mint stage."
  }
] as const;

const CAPABILITY_BY_ID = new Map<string, CapabilityVocabularyEntry>(CAPABILITY_VOCABULARY.map((entry) => [entry.id, entry]));

// Sorted, deterministic — same discipline as operationCatalog.ts's listOperationIds() (safe to
// snapshot for a diff; no dependence on declaration order).
export function listCapabilityIds(): string[] {
  return [...CAPABILITY_BY_ID.keys()].sort((left, right) => left.localeCompare(right));
}

export function listCapabilities(): CapabilityVocabularyEntry[] {
  return listCapabilityIds().map((id) => ({ ...CAPABILITY_BY_ID.get(id)! }));
}

export function getCapability(id: string): CapabilityVocabularyEntry | undefined {
  const entry = CAPABILITY_BY_ID.get(id);
  return entry ? { ...entry } : undefined;
}

// The membership check registerOperation() enforces at registration time. A capability id not
// registered here can never appear in a descriptor's requiredCapabilities — see operationCatalog.ts.
export function isKnownCapability(id: string): boolean {
  return CAPABILITY_BY_ID.has(id);
}
