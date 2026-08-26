// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — the cross-tenant template library's shapes.
//
// TENANCY SEAM (ADR §5.2 — read this before touching anything downstream of here): the LIBRARY is
// cross-tenant by construction — one templateId can be instantiated into any tenant whose registry
// supports it, and nothing here is keyed by, filtered by, or scoped to a calling project. A CLIENT'S
// MEMORY (src/agent/memory/memoryEnvelope.ts's `artifacts[]`, `type: "template"`, T15.32/#208) is the
// opposite: written to one project's own memoryNamespace, never cross-tenant, and it is #208's job to
// build, not this module's. `sourceProjectId` below is PROVENANCE ONLY — which tenant's clone run
// first minted this template — never an access-control scope. A reader must never filter library
// records by sourceProjectId to decide who may instantiate them; every tenant may attempt to
// instantiate anything in the library, and the ONLY gate is whether ITS OWN live registry can express
// the section types the template depends on (§4.1's "validated against that tenant's live registry").
export type TemplateLibraryObjectType = "section_template" | "template" | "pdf_template";

// Every field ADR §4.1 requires stated, or the template is not publishable (see templateProvenance.ts).
export type TemplateProvenance = {
  sourceUrl: string;
  /** Required when the template was minted from a clone run (true today; #206's demand-driven entry
   *  may one day produce a template with no capture run behind it, at which point this becomes
   *  legitimately absent rather than unstateable — see validateTemplateProvenance's `driven` input). */
  captureRunId?: string;
  /** The vendored capture-engine hashes from src/agent/capture/provenance.ts — CAPTURE_ENGINE_FILES'
   *  own pinned `vendoredSha256` values, read (never recomputed from disk) so this stays a pure
   *  function of already-pinned data, not an I/O-dependent one. */
  engineHashes: Record<string, string>;
  /** The standards-pack version this template was built against (ADR §6.2). Sourced from
   *  STANDARDS_PACK_VERSION (templateProvenance.ts, re-exported from skills/standardsPack.ts — the
   *  ONE pinned constant, also the version on the `structure_studio_standards_pack` skill assigned to
   *  the studio's authoring nodes). Immutable per template version (templateLibraryStore.ts): a later
   *  standards-pack bump never rewrites what an already-published version states here. */
  standardsPack: string;
};

export type TemplateLibraryRecord = {
  /** Stable across versions. See templateIdentity.ts for how it is derived. */
  templateId: string;
  /** Monotonic integer, starting at 1. A published version is immutable — see templateLibraryStore.ts. */
  version: number;
  objectType: TemplateLibraryObjectType;
  name: string;
  /** The recipe body exactly as minted (object_create's `body` for a section_template/template) — the
   *  DATA a tenant instantiates from, never re-derived or re-authored on read. */
  recipe: Record<string, unknown>;
  /** The registered section types this recipe depends on — what a target tenant's live registry must
   *  cover before object_instantiate_template/object_instantiate_section_template can succeed there. */
  sectionTypesUsed: string[];
  provenance: TemplateProvenance;
  /** Which tenant's clone run first minted this template. Provenance only — see the tenancy-seam note
   *  above. Never used to gate who may read or instantiate this record. */
  sourceProjectId: string;
  /** sha256 over the canonical (sorted-key) JSON of {objectType, recipe, sectionTypesUsed} — the ONLY
   *  input to whether a deposit mints a new version, leaves the latest version untouched, or (were it
   *  ever to disagree with a version number already on disk) refuses. Never includes provenance or
   *  publishedAt, so a re-run against the same source with a re-resolved (but unchanged) provenance
   *  detail never mints a spurious new version. */
  contentHash: string;
  /** LEDGER FACT ONLY (DETERMINISM, #200): stamped once, at mint, from wall-clock time. Never read
   *  back into anything a run emits or hashes, and never rewritten on a later "unchanged" deposit of
   *  the same content — see templateLibraryStore.ts's publish(). */
  publishedAt: string;
};

export class TemplateLibraryRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TemplateLibraryRefusal";
  }
}
