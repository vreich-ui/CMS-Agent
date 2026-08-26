// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
//
// T13.2 (CLONE-INTAKE-FIX.md): `clone_intake.v1` is a BOUNDED BRIEFING DOCUMENT for the three AI
// nodes, not a data bus. It carries shapes, slots and vocabulary — never the source snapshot, never
// the full mapping, never full page bodies, never section-type JSON Schemas. The deterministic
// stages have transport and `object_get` the site / theme / page bodies they need, which is why
// `buildCloneIntake` takes `siteBody` and `theme` and `buildRestampOps` takes `pageBodies`.
export class CloneError extends Error {}

/** What a healthy briefing lands under. NOT enforced — `budget.chars` reports the truth either way. */
export const CLONE_INTAKE_TARGET_CHARS: 12000;
/** Enforced. Sits well inside the executor's 48,000-char dependency bound. Over it, the documented
 *  degradation order runs; still over it after every legal drop, buildCloneIntake THROWS. */
export const CLONE_INTAKE_CAP_CHARS: 32000;

/** One section type reduced to what a designer composing a blueprint needs: which fields the type HAS
 *  and which of them it REQUIRES. `fields` is replaced by `fieldCount` only when step 4 of the
 *  documented degradation order had to run (and `budget.truncated` then says so). */
export type CloneSectionTypeContract =
  | { fields: string[]; required: string[] }
  | { fieldCount: number; required: string[] };

export type CloneRegistry = {
  sectionTypes: Record<string, CloneSectionTypeContract>;
  pageTypes: Record<string, { allowed: string[] | "any"; required: string[] }>;
};

// T13.3: renamed from CloneBrandTokens. The briefing calls this field `palette`, not
// `brandTokens`/`tokens` — the executor's per-node prompt redactor
// (OpenAINodeRunner.ts/AnthropicNodeRunner.ts, `/token/i`) replaces any key matching that pattern
// with "[REDACTED]" before the model ever sees it, and `brandTokens`/`tokens` both matched, so
// theme_reconciler's whole palette silently blanked. The real platform field this is read FROM
// (siteBody.brandTokens / theme body.tokens) is unchanged — only the outgoing briefing key names.
export type ClonePalette = { colors: Record<string, unknown>; fonts: Record<string, unknown> };

/** One briefed page: ORDERED shapes, not bodies. `candidateIds` is what makes buildRestampOps'
 *  `recipe_rejected_at_mint` skip reachable — a design can only cite an id the briefing showed it. */
export type CloneBriefingPage = {
  pageRef: string;
  objectId: string;
  route: string | null;
  sourceShape: string[];
  emittedShape: string[];
  gaps: Array<{ gapId: string | null; why: string | null; nearestType: string | null }>;
  candidateIds: string[];
};

export type CloneRecipeIndexEntry = {
  objectId: string | null;
  name: string | null;
  scope: string | null;
  blueprint_type?: string | null;
  applies_to?: unknown;
  slot_count?: number | null;
};

/** Named drops, in the FIXED documented order. `site.palette`, `theme.palette` and
 *  `registry.pageTypes` never appear here: they are never dropped, at any size. */
export type CloneIntakeTruncation = { field: string; kept: number; total: number; reason: string };

// T15.30 (#206; ADR-2026-08-25-structure-studio §3) — the demand-driven entry's own brief shape. One
// of `captureRunId` (clone-driven) or `structureBrief` (demand-driven) is supplied to
// buildCloneIntake; never both, never neither.
export type CloneStructureBriefNeed = {
  pageRef: string;
  kind: "section_template" | "template";
  sourceShape?: string[];
  emittedShape?: string[];
  rationale?: string;
};
export type CloneStructureBrief = {
  sourceUrl?: string;
  needs: CloneStructureBriefNeed[];
  /** OPTIONAL passthrough: existing pages (by objectId) this brief also wants restamped once a
   *  recipe mints, in the same shape a clone-driven run derives from its own mapping. Absent = no
   *  restamp target, the normal demand-driven case ("layout_restamp participates only when the brief
   *  asks"). */
  pages?: Array<{ objectId: string; pageRef?: string; route?: string; sourceShape?: string[]; emittedShape?: string[] }>;
};

export type CloneIntake = {
  artifact: "clone_intake.v1";
  summary: string;
  /** "clone" (captureRunId-driven) or "demand" (structureBrief-driven, T15.30/#206) — the ONE
   *  structural fact every downstream skip predicate and the template-library provenance writer key
   *  off of. */
  entryMode: "clone" | "demand";
  captureRunId: string | null;
  /** Present only on a demand-driven envelope whose brief stated one (`structureBrief.sourceUrl`);
   *  `null` otherwise. Never fabricated — see templateProvenance.ts for what happens when a template
   *  minted from a `sourceUrl: null` demand-driven run is later deposited into the library. */
  sourceUrl: string | null;
  target: string;
  site: { objectId: string | null; palette: ClonePalette };
  theme: { objectId: string | null; name: string | null; palette: Record<string, unknown> };
  registry: CloneRegistry;
  pages: CloneBriefingPage[];
  /** Present ONLY on a demand-driven envelope — the same shape layout_analyst's own
   *  `clone_layout_analysis.v1.mismatches` carries, stated directly from `structureBrief.needs`
   *  rather than derived by comparing a source shape to an emitted one (there is no snapshot to
   *  compare on this entry). recipe_designer reads whichever of the two exists. */
  mismatches?: Array<{ pageRef: string; sourceShape: string[]; emittedShape: string[]; missingRecipeKind: "section_template" | "template"; rationale: string }>;
  recipes: { section_template: CloneRecipeIndexEntry[]; template: CloneRecipeIndexEntry[] };
  budget: { chars: number; cap: number; truncated: CloneIntakeTruncation[] };
  /** T2 (2026-08-26) — present once `applyCloneDelta` has run over this briefing (which
   *  cloneIntakeStep always does; a hand-built fixture may not). `pages` above is NOT narrowed by it:
   *  the theme verdict is acted on (cloneThemeBindStep writes nothing when it says unchanged), the
   *  page rows are drift EVIDENCE only. See applyCloneDelta's own header for why the page half is
   *  recorded rather than decided. */
  delta?: CloneIntakeDelta;
};

/** One page's live-vs-briefing comparison. `liveShape` is `null` only when the live body could not be
 *  read. `shapeDrift` is evidence, never a dispatch decision — a page whose shape matches can still
 *  need a restamp, because a restamp also re-points sections at a recipe minted this run and rewrites
 *  section data, neither of which a shapes-only briefing can see. */
export type CloneDeltaPage = {
  pageRef: string | null;
  objectId: string | null;
  route: string | null;
  liveShape: string[] | null;
  emittedShape: string[];
  sourceShape: string[];
  shapeDrift:
    | "live_body_unreadable"
    | "live_shape_differs_from_briefing"
    | "emitted_shape_differs_from_source"
    | "none";
};

export type CloneIntakeDelta = {
  comparedPages: number;
  pages: CloneDeltaPage[];
  pagesWithShapeDrift: number;
  /** The DECIDED half: whether site_apply_theme would write anything different from what the site's
   *  live palette already holds. `false` makes theme_bind a no-op that still reports the bound state. */
  theme: {
    changed: boolean;
    reason:
      | "no_captured_theme_to_compare"
      | "captured_theme_tokens_differ_from_live_site_palette"
      | "captured_theme_tokens_already_match_live_site_palette";
    /** `null` when the briefing carries no captured theme objectId to compare. */
    capturedThemeDigest: string | null;
    livePaletteDigest: string;
  };
};

/** T2 — compare a built briefing against the target's LIVE page bodies and the site's live palette,
 *  and attach the `delta` ledger. PURE: no clock, no run id, no network. Never throws and never
 *  refuses. Does NOT narrow `intake.pages` and no skip predicate reads it — see the implementation's
 *  own header for why the page half is evidence rather than a gate.
 *
 *  `live.pages` are the object_get bodies of the briefed pages, fetched by the caller
 *  (cloneEngine.cloneIntakeStep). A page absent from that list is recorded as unreadable. */
export function applyCloneDelta(
  intake: CloneIntake,
  live?: { pages?: Array<{ objectId: string; sections?: unknown }> }
): CloneIntake;

/** Assembles the BOUNDED clone briefing from already-fetched pieces. Pure — every argument is a value
 *  the CALLER already fetched (an emission report, an inventory listing, a registry_get response, the
 *  object_get bodies of the site and the captured theme); nothing here reaches out for anything.
 *
 *  `siteBody` is the object_get BODY of the site, not its inventory row: an object_inventory row
 *  carries no brandTokens, and a body without one is refused HERE rather than three stages later.
 *  `theme` is the object_get record (or bare body) of the captured theme.
 *
 *  ENTRY MODE (T15.30/#206): supply exactly one of `captureRunId` (truthy selects clone mode; `mapping`
 *  is then required and read) or `structureBrief` (selects demand mode; validated total and
 *  deterministic, no capture involved).
 *
 *  Throws CloneError when mapping is not a capture-map.v1 mapping (clone mode), when structureBrief is
 *  missing/malformed (demand mode), when componentRegistry reduces to zero section types, when
 *  inventory does not carry exactly one active site row, when siteBody carries no brandTokens, or when
 *  the briefing is still over cap after every documented drop (`intake_cannot_be_bounded`). */
export function buildCloneIntake(input: {
  captureRunId?: string;
  structureBrief?: CloneStructureBrief;
  target: string;
  mapping?: unknown;
  siteBody: unknown;
  theme?: unknown;
  emissionReport?: unknown;
  inventory?: Partial<Record<"page" | "template" | "section_template" | "theme" | "navigation" | "site", unknown[]>>;
  componentRegistry: unknown;
  pageTypeRegistry: unknown;
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

// T13.4 PART B — the substitution ledger vocabulary. Every `substitutions[]` array anywhere in this
// module (validateThemeProposal's, buildRecipeMintPlan's, buildCloneRunReport's) is built exclusively
// from this one shape via the module's own (unexported) substitutionEntry/illegalSubstitutionRejection
// constructors, so it can never drift between kinds or call sites. `chosen` is `null` everywhere THIS
// module produces one — nothing here is authorized to pick a candidate; that is fit_adjudicator's job
// (PART C), and only buildCloneRunReport's own re-validated adjudication result may set it non-null.
export type CloneSubstitutionKind = "section_type" | "font" | "recipe" | "page_type";
export type CloneSubstitution = {
  kind: CloneSubstitutionKind;
  wanted: string;
  chosen: string | null;
  reason: string;
  basis: string;
  fidelityCost: "none" | "minor" | "material";
  substitutable: boolean;
  candidates: unknown[];
};

export type CloneMintPlan = {
  schemaVersion: "clone-mint-plan.v1";
  target: string;
  creates: CloneMintCreate[];
  rejected: CloneMintRejected[];
  reused: CloneMintReused[];
  substitutions: CloneSubstitution[];
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
export type CloneThemeValidation = { applied: CloneThemeApplied; dropped: CloneThemeDropped[]; missingKeys: string[]; substitutions: CloneSubstitution[] };

/** Re-validates a proposed theme token set against the site's own declared slots, read from
 *  `intake.site.palette` — the briefing is the single authority on a site's palette, so a caller
 *  cannot validate a proposal against one site and report against another. Throws CloneError when the
 *  intake carries no site.palette, and when every proposed token drops (an empty write is a
 *  refusal, not a success). */
export function validateThemeProposal(input: {
  proposal: { colors?: Record<string, unknown>; fonts?: Record<string, unknown> };
  intake: Pick<CloneIntake, "site">;
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

/** One page body the caller fetched for restamp. A bare `{objectId, sections}` and a whole object_get
 *  record are both accepted and unwrapped. */
export type CloneRestampPageBody = { objectId?: string | null; object_id?: string | null; body?: unknown; sections?: unknown };

// T13.4 PART C — fit_adjudicator's OWN output envelope (clone_fit_adjudication.v1). Optional
// everywhere it is accepted: every existing caller/test that omits it sees byte-identical output to
// before this argument existed. `chosen`/`basis`/`fidelityCost` on a choice are the MODEL's claim —
// buildRestampOps re-validates a `section_type` choice against its own candidate list before ever
// applying it (see resolveSectionTypeSubstitutions); nothing here trusts the model directly.
export type CloneAdjudicationChoice = { kind: CloneSubstitutionKind; wanted: string; chosen: string; basis?: string; fidelityCost?: "none" | "minor" | "material" };
export type CloneAdjudicationDeclined = { kind: CloneSubstitutionKind; wanted: string; basis?: string; fidelityCost?: "material" };
export type CloneAdjudication = {
  artifact?: "clone_fit_adjudication.v1";
  summary?: string;
  choices?: CloneAdjudicationChoice[];
  declined?: CloneAdjudicationDeclined[];
};

/** A ledger-shaped rejection for an adjudicated `chosen` this engine will not apply (`reason:
 *  'substitution_not_in_candidates'`) — same CloneSubstitution shape, `chosen: null` because it was
 *  NOT applied, with the model's rejected proposal named in `basis`. */
export type CloneIllegalSubstitution = CloneSubstitution & { reason: "substitution_not_in_candidates" };

/** Builds the ops that restamp the site's already-emitted pages once mint has run. The page bodies
 *  arrive as an explicit `pageBodies` argument — the briefing carries page SHAPES only, and this
 *  stage is deterministic engine code WITH transport, so it object_gets what it is about to patch
 *  (which is also more correct: it restamps what the page holds NOW). A page is SKIPPED — never
 *  half-restamped — when no body was supplied for it, when its section list is empty, or when any of
 *  its capture-map candidates depended on a recipe rejected at mint. Throws CloneError if a produced
 *  op would introduce a remote URL into an asset field.
 *
 *  `adjudication` (T13.4 PART C, OPTIONAL): every `choices` entry of `kind: 'section_type'` is
 *  RE-VALIDATED against `mintReport.substitutions`' own `candidates` (never trusted from the model
 *  directly) before a matching section's captured type is stamped with `chosen`; a choice that fails
 *  re-validation is reported in `substitutionRejections`, never applied. `mintReport.substitutions`
 *  MUST be carried through by the caller for this re-validation to have anything to check against —
 *  narrowing the mint envelope down to `{rejected}` alone silently turns every choice into a
 *  `substitution_not_in_candidates` rejection. */
export function buildRestampOps(input: {
  intake: Pick<CloneIntake, "pages">;
  mintReport: { rejected?: Array<{ sourceCandidateIds?: string[] }>; substitutions?: CloneSubstitution[] };
  pageBodies?: CloneRestampPageBody[];
  adjudication?: CloneAdjudication;
}): { restamp: CloneRestampEntry[]; skipped: CloneRestampSkip[]; appliedSubstitutions: Array<{ wanted: string; chosen: string }>; substitutionRejections: CloneIllegalSubstitution[] };

export type CloneRunReport = {
  schemaVersion: "clone-run-report.v1";
  mint: unknown;
  theme: unknown;
  restamp: unknown;
  substitutions: CloneSubstitution[];
  capabilityBacklog: Record<string, unknown[]>;
  reviewQueue: Array<Record<string, unknown>>;
  humanGate: { publishedByThisRun: false; note: string };
};

/** Assembles the terminal clone run report. Summarizes prior stages' already-computed outcomes only
 *  — creates, changes, and publishes nothing. humanGate.publishedByThisRun is unconditionally false.
 *  The site it names in the review queue is `intake.site.objectId`, the same single authority
 *  validateThemeProposal reads its palette from.
 *
 *  `substitutions[]` (T13.4 PART B/C) folds `mintReport.substitutions`, `themeReport.substitutions`,
 *  and (when `adjudication` is supplied) the RE-VALIDATED resolution of each — sourced from
 *  `restampReport.appliedSubstitutions`/`.substitutionRejections`, never adjudication's raw claim a
 *  second time — into ONE ledger a human reads in one place. Every field here is read from the
 *  envelope the caller passes; narrowing `mintReport`/`restampReport` down to only the fields an
 *  earlier caller needed (e.g. `{createdObjects}` / `{restamp}`) silently empties this ledger. */
export function buildCloneRunReport(input: {
  intake: Pick<CloneIntake, "site">;
  mintReport: { createdObjects?: Array<{ objectType: string; objectId: string }>; substitutions?: CloneSubstitution[] };
  themeReport: { applied?: { colors?: Record<string, unknown>; fonts?: Record<string, unknown> }; substitutions?: CloneSubstitution[] };
  restampReport: { restamp?: CloneRestampEntry[]; appliedSubstitutions?: Array<{ wanted: string; chosen: string }>; substitutionRejections?: CloneIllegalSubstitution[] };
  design?: { unmetNeeds?: Array<{ sectionType?: string }> };
  adjudication?: CloneAdjudication;
}): CloneRunReport;
