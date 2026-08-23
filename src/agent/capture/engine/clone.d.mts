// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export class CloneError extends Error {}

export type CloneSectionTypeSchema = Record<string, unknown> | null;

export type CloneRegistry = {
  sectionTypes: Record<string, CloneSectionTypeSchema>;
  pageTypes: Record<string, { allowed: string[] | "any"; required: string[] }>;
};

export type CloneEmittedPage = { pageRef: string; objectId: string; route: string | null; sectionTypes: string[] };

export type CloneIntake = {
  schemaVersion: "clone-intake.v1";
  captureRunId: string;
  target: string;
  source: { snapshot: unknown; mapping: unknown; theme: unknown };
  emitted: { report: unknown; pages: CloneEmittedPage[] };
  inventory: {
    page: unknown[];
    template: unknown[];
    section_template: unknown[];
    theme: unknown[];
    navigation: unknown[];
    site: Record<string, unknown>;
  };
  registry: CloneRegistry;
  policy: unknown;
};

/** Assembles the clone workspace envelope from already-fetched pieces. Pure — every argument is a
 *  value the CALLER already fetched (an emission report, an inventory listing, a registry_get
 *  response); nothing here reaches out for anything. Throws CloneError when mapping is not a
 *  capture-map.v1 mapping, when componentRegistry reduces to zero section types, or when inventory
 *  does not carry exactly one active site row. */
export function buildCloneIntake(input: {
  captureRunId: string;
  target: string;
  snapshot?: unknown;
  mapping: unknown;
  theme?: unknown;
  emissionReport?: unknown;
  inventory?: Partial<Record<"page" | "template" | "section_template" | "theme" | "navigation" | "site", unknown[]>>;
  componentRegistry: unknown;
  pageTypeRegistry: unknown;
  policy?: unknown;
}): CloneIntake;

export type CloneDesignValidation =
  | { ok: true; normalized: Record<string, unknown> }
  | { ok: false; reason: string; detail: unknown };

/** Total, deterministic re-validation of ONE designed section_template against the live registries.
 *  Never coerces an invalid design into a valid one. */
export function validateSectionTemplateDesign(design: Record<string, unknown>, intake: CloneIntake): CloneDesignValidation;

/** Total, deterministic re-validation of ONE designed template against the live registries. */
export function validateTemplateDesign(design: Record<string, unknown>, intake: CloneIntake): CloneDesignValidation;

export type CloneMintCreate = {
  verb: "object_create";
  objectType: "section_template" | "template";
  requestedId: string;
  body: Record<string, unknown>;
  rationale: string;
  sourceCandidateIds?: string[];
};
export type CloneMintRejected = { kind: string; name: string | null; reason: string; detail: unknown; sourceCandidateIds?: string[] };
export type CloneMintReused = { objectType: string; name: string | null; objectId: string | null };

export type CloneMintPlan = {
  schemaVersion: "clone-mint-plan.v1";
  target: string;
  creates: CloneMintCreate[];
  rejected: CloneMintRejected[];
  reused: CloneMintReused[];
  forbiddenVerbs: string[];
};

/** Mint plan for a batch of designed recipes. Re-validates every design with the exact same
 *  functions an isolated caller would use; one malformed design does not abort the whole batch. */
export function buildRecipeMintPlan(input: {
  intake: CloneIntake;
  design: { sectionTemplates?: unknown[]; templates?: unknown[] };
}): CloneMintPlan;

export type CloneThemeApplied = { colors: Record<string, string>; fonts: Record<string, string> };
export type CloneThemeDroppedReason = "unknown_slot" | "external_reference_forbidden" | "not_a_color" | "no_fallback_stack";
export type CloneThemeDropped = { slot: string; value: unknown; reason: CloneThemeDroppedReason };
export type CloneThemeValidation = { applied: CloneThemeApplied; dropped: CloneThemeDropped[]; missingKeys: string[] };

/** Re-validates a proposed theme token set against the site's own declared brandTokens slots.
 *  Throws CloneError when every proposed token drops (an empty write is a refusal, not a success). */
export function validateThemeProposal(input: {
  proposal: { colors?: Record<string, unknown>; fonts?: Record<string, unknown> };
  siteBody: { brandTokens: { colors?: Record<string, unknown>; fonts?: Record<string, unknown> } };
}): CloneThemeValidation;

export type CloneThemeApplyStep = { verb: string; arguments: Record<string, unknown> };
export type CloneThemeApplyPlan = {
  schemaVersion: "clone-theme-apply.v1";
  siteId: string;
  themeId: string;
  refusal: null | { reason: "theme_not_total"; detail: { missingKeys: string[] } };
  steps: CloneThemeApplyStep[];
};

/** Builds the plan that applies a validated theme to the site. NEVER constructs a
 *  set_site_brand_tokens op directly — the only sanctioned palette writer is the site_apply_theme
 *  verb, called under the caller's own site checkout. When missingKeys is non-empty, refuses
 *  (refusal:{reason:'theme_not_total',...}) with an EMPTY steps array rather than a partial apply. */
export function buildThemeApplyPlan(input: {
  siteId: string;
  themeId: string;
  siteRecord: Record<string, unknown>;
  themeRecord: Record<string, unknown>;
  applied: CloneThemeApplied;
  missingKeys: string[];
}): CloneThemeApplyPlan;

export type CloneRestampOp = { op: "upsert_section"; section: Record<string, unknown>; position: number };
export type CloneRestampEntry = { objectId: string; ops: CloneRestampOp[] };
export type CloneRestampSkipReason = "source_page_missing" | "recipe_rejected_at_mint" | "would_empty_page";
export type CloneRestampSkip = { objectId: string; reason: CloneRestampSkipReason };

/** Builds the ops that restamp the site's already-emitted pages once mint has run. A page is
 *  SKIPPED — never half-restamped — when its source page is missing, its captured section list is
 *  empty, or any of its capture-map candidates depended on a recipe rejected at mint. Throws
 *  CloneError if a produced op would introduce a remote URL into an asset field. */
export function buildRestampOps(input: {
  intake: CloneIntake;
  mintReport: { rejected?: Array<{ sourceCandidateIds?: string[] }> };
}): { restamp: CloneRestampEntry[]; skipped: CloneRestampSkip[] };

export type CloneRunReport = {
  schemaVersion: "clone-run-report.v1";
  mint: unknown;
  theme: unknown;
  restamp: unknown;
  capabilityBacklog: Record<string, unknown[]>;
  reviewQueue: Array<Record<string, unknown>>;
  humanGate: { publishedByThisRun: false; note: string };
};

/** Assembles the terminal clone run report. Summarizes prior stages' already-computed outcomes only
 *  — creates, changes, and publishes nothing. humanGate.publishedByThisRun is unconditionally false. */
export function buildCloneRunReport(input: {
  intake: CloneIntake;
  mintReport: { createdObjects?: Array<{ objectType: string; objectId: string }> };
  themeReport: { applied?: { colors?: Record<string, unknown>; fonts?: Record<string, unknown> } };
  restampReport: { restamp?: CloneRestampEntry[] };
  design?: { unmetNeeds?: Array<{ sectionType?: string }> };
}): CloneRunReport;
