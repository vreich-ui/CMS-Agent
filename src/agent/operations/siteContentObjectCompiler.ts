// P2 v2 -- the step between a drafted page and a site that has one.
//
// `site_content.draft_page` (siteContentDraftingExecutor.ts) ends with drafts in hand and writes
// nothing. This module is the deterministic compilation of those drafts into a CANDIDATE PAGE
// MATERIALIZATION PLAN: which registered section type each drafted unit becomes, whether the page is
// created or patched, and -- for a patch -- exactly which named page-object patch ops would apply the
// change. It is the last step before an applier; it is not the applier.
//
// THIS MODULE NEVER WRITES, NEVER PUBLISHES, NEVER CALLS A TENANT. It is a pure function of
// (drafting result, snapshot, target) -> a plan or named blockers.
//
// ============================================================================================
// THE REAL PAGE CONTRACT (read live from `object_contract("page")` and `object_contract("section")`
// against the Kugel-Platform connector on 2026-09-18). Everything below is enforced against THESE
// facts, not against repo fixtures, captured snapshots, PR prose or code comments -- all three of
// those still encode a stale dialect, and this module has already been wrong twice by trusting them.
//
//  * `page.body_schema.required` is `["route","pageType","title","seo","sections"]`. FIVE fields,
//    `seo` INCLUDED. `seo` is `{title?, description?, ogImage?, robots{index,follow}}`,
//    `additionalProperties: false`. A missing required field is REFUSED by name; nothing here
//    invents one.
//  * `page.patch_ops` is SEVEN ops: set_page_meta, upsert_section, update_section_data, move_section,
//    set_section_visibility, remove_section, set_tracking.
//  * `sections` is an INLINE array on the page body. Its items are a `oneOf` discriminated by a
//    per-variant `type` CONST; a section id must match `^s_[a-z0-9]+$`.
//  * `page.section_types` is the registry: 28 entries, each `{type, component_bound, footprint,
//    data_schema}`. Exactly two -- `card` and `shared_ref` -- carry `component_bound: false` /
//    `footprint: null`. `before_after` IS present, `component_bound: true`, region `flow`.
//  * `page.page_types` is PageType law: six entries, four of which restrict `allowedSections`; `home`
//    additionally requires `["hero"]` and `listing` requires `["lede"]`.
//  * `sectionType` appears ZERO times in the page contract and ZERO times in the section contract, at
//    any depth. `object_contract("section").body_schema` is `{required: ["section"], properties:
//    [section, tracking]}` -- a standalone section object is NOT a `{sectionType, data}` record.
//  * `tracking_attribute` is a ONE-WRITER FUNNEL: the `tracking` key is written ONLY by
//    `set_tracking`; the other six ops refuse it.
//
// WHAT THIS CORRECTS (C2). This module used to declare
// `const SECTION_TYPE_ENUM_PATH = ["properties","sectionType","enum"]` and resolve it against a
// CAPTURED `section` contract. That path does not exist on any live contract, so the only registry
// gate in the compiler was never validation at all -- it returned "unavailable" (or, after the first
// partial fix, a bare name list off the `section` contract) rather than checking anything. The
// registry is now read from `object_contract("page").section_types[]`, STRUCTURED, carrying `type`,
// `component_bound` and `footprint` -- because placement law and placeability both live on the page
// contract, and a name list cannot express either.
//
// PLACEABILITY IS A RULE, NOT A LIST. Any section type whose registry entry carries
// `component_bound: false` is refused as unplaceable unless it is `shared_ref` (the one genuinely
// page-referenceable non-component entry). `card` is NOT hardcoded anywhere here: it is merely
// today's only other instance, and a 29th non-component type added tomorrow is refused by the same
// rule without a code change. Conversely `before_after` carries NO capability gate of its own -- it
// is in the live registry like any other bound type, and gating it on a tenant snapshot is exactly
// what produced false `unsupported_section_type` refusals.
//
// SCHEMA v2 -- WHY THIS REPLACED v1. Platform's real `page` contract does not model a page's sections
// as independently created/patched `section` objects. Sections are INLINE data embedded in the page
// body's own `sections` array, and `object_patch` on a `page` is not a flat field-map replace -- it is
// the fixed set of named ops above. v2 compiles to ONE page-level effect: a create (the full body,
// sections inline) or a patch (one `ops` array). A `section` object DOES exist as its own top-level
// type, but only for `shared_ref`; mutating one is refused by name
// (`unsupported_shared_section_mutation`) rather than half-implemented.
//
// THE REVISE PATH IS REFUSED BY NAME -- CARRY-FORWARD, NOT AN OVERSIGHT. Revising a page's EXISTING
// inline sections requires diffing against `existingPage.fields.sections`. In production that page
// row comes from `siteContextSourceAdapter.ts`'s `object_inventory` listing, which returns SUMMARY
// rows carrying no body at all -- so the diff would see zero existing sections and cheerfully append
// a duplicate of every section the page already has. Rather than ship a path that is silently
// destructive against real data, this module refuses it: `page_revise_path_unsupported` when a caller
// names existing inline sections to patch, and `page_body_unavailable_for_patch` when a patch target's
// snapshot row carries no `sections` array at all. Fixing the adapter so a patch base carries a real
// body is a SEPARATE TASK; the seven-op union below already declares the full live grammar so that
// task adds emission, not vocabulary.
//
// THREE RULES CARRIED OVER FROM v1, UNCHANGED.
//
// 1. A SEMANTIC SECTION KIND IS NOT A REGISTERED SECTION TYPE. The planner's own `sectionType`
//    vocabulary ("about_overview", "our_team", ...) is never a registered type. What may be placed is
//    `object_contract("page").section_types[]`, and nothing else.
// 2. A MISSING FACT IS A REFUSAL, NEVER A DOWNGRADE. See compileSection below.
// 3. ALL OR NOTHING. Any refusal on any unit fails the whole compilation.
//
// IDENTITY (C4). A section's id is the caller's to preallocate: `target.sectionIds` maps a unit's
// `unitKey` to an id that must match Platform's own `^s_[a-z0-9]+$`. PREALLOCATION IS WHAT KEEPS TWO
// CONTENT-IDENTICAL UNITS DISTINCT -- a content digest alone cannot, because two units whose drafts
// are byte-identical hash identically by construction. Where no id is supplied this module mints a
// conformant one deterministically; where the caller preallocated SOME but not all, that is refused
// by name (`preallocated_section_id_missing`) rather than half-honoured, and two units resolving to
// the same id is refused by name (`duplicate_section_id`).
//
// IDEMPOTENCY. `materializationKey` is a content digest of (tenant, page target, each unit's
// unitKey + order + resolved section type + resolved section id + a digest of the draft itself). It
// deliberately does NOT include the snapshot digest, matching v1. Order IS part of the key: a genuine
// reorder is genuinely different content (the page renders in a different sequence) and must never
// dedupe onto the pre-reorder apply as though nothing changed.
import { validateOutput } from "../execution/outputValidator.js";
import { compileCandidate } from "./candidates.js";
import type { ChangeSet } from "./changeSet.js";
import { computeChangeSet } from "./changeSet.js";
import { contentDigest } from "./contentHash.js";
import type { OperationBlocker } from "./operationTypes.js";
import type { PageTypeRule, SectionTypeRegistryEntry, SiteContextObject, SiteSnapshot } from "./siteContext.js";

export const PAGE_MATERIALIZATION_SCHEMA_VERSION = "site-page-materialization.v2" as const;
export type PageMaterializationSchemaVersion = typeof PAGE_MATERIALIZATION_SCHEMA_VERSION;

// Platform's own minted-id pattern, verbatim from `page.body_schema.properties.sections.items.oneOf[].
// properties.id.pattern` (live, 2026-09-18). Both a caller-preallocated id and a minted one must match.
export const SECTION_ID_PATTERN = /^s_[a-z0-9]+$/;

// The five fields `page.body_schema.required` names (live, 2026-09-18). `seo` is one of them; it was
// absent from every prior fixture in this repo, which is exactly why it is pinned here as a constant
// rather than trusted from a snapshot that may still carry the stale four-field shape.
export const PAGE_REQUIRED_FIELDS = ["route", "pageType", "title", "seo", "sections"] as const;

// The ONE registry entry that may be placed on a page despite `component_bound: false`. This is not a
// list of exceptions to grow -- it is the single genuinely page-referenceable non-component type.
const PLACEABLE_WITHOUT_COMPONENT = "shared_ref";

// Named page-object patch ops -- the SEVEN ops `object_contract("page").patch_ops` declares live
// (2026-09-18), translated to this module's own field naming (camelCase internally; the writer that
// actually calls the tenant translates back to the wire's snake_case `section_id` / `to_index`).
// `guard` is deliberately not modelled here: it is an applier/writer concern (a fresh compare-and-set
// token), never something a compile-time plan can freeze.
//
// The union declares the full live grammar. What this module EMITS today is a strict subset --
// `set_page_meta`, `upsert_section` (append only) and `set_tracking` -- because the revise path is
// refused by name (see the header). The remaining ops are the vocabulary the carry-forward task that
// fixes the patch base will emit; they are declared here so that task adds emission, not grammar.
export type PageObjectPatchOp =
  | { op: "set_page_meta"; fields: Record<string, unknown> }
  | { op: "upsert_section"; section: { id: string } & Record<string, unknown>; position?: number }
  | { op: "update_section_data"; sectionId: string; fields: Record<string, unknown> }
  | { op: "move_section"; sectionId: string; toIndex: number }
  | { op: "set_section_visibility"; sectionId: string; visibility: "public" | "hidden" | null }
  | { op: "remove_section"; sectionId: string }
  // THE TRACKING FUNNEL. `tracking_attribute` (live constraint) makes `set_tracking` the ONLY writer
  // of a page's `tracking` key; the other six ops refuse it. It is therefore its own effect here, and
  // a `tracking` key smuggled in through `pageFields` is refused by name
  // (`page_fields_tracking_reserved`) rather than folded into `set_page_meta`, which would be rejected
  // tenant-side anyway.
  // `fields`, not `tracking` -- the live arg_schema is `{op, fields}` where `fields` is the tracking
  // map itself (or null to clear it), plus an optional applier-supplied `guard`.
  | { op: "set_tracking"; fields: Record<string, unknown> | null };

export type SectionMaterializationAction = "create" | "update" | "unchanged";

export type SectionProvenanceEntry = {
  // The caller's own stable handle for this unit -- what `target.sectionIds` is keyed on.
  unitKey: string;
  // The planner's own order value, preserved exactly -- never renumbered.
  order: number;
  plannedSectionType: string;
  componentType: string;
  // The inline section id this plan writes: the caller's preallocated id when one was supplied, else
  // a deterministically minted conformant one.
  sectionId: string;
  sectionIdOrigin: "preallocated" | "minted";
  action: SectionMaterializationAction;
  sourceRunId: string | null;
  sourceExecutionId: string | null;
};

export type PageMaterializationWrite =
  | { kind: "create"; fields: Record<string, unknown> }
  | { kind: "patch"; ops: PageObjectPatchOp[] };

export type PageMaterializationPlan = {
  schemaVersion: PageMaterializationSchemaVersion;
  tenantId: string;
  materializationKey: string;
  page: { objectId: string | null; action: "create" | "patch"; targetContentRevision: number | null };
  // The ONE write effect this plan authorizes. An applier applies exactly this -- never a per-section
  // effect list -- see the module header for why.
  write: PageMaterializationWrite;
  // Per-unit traceability for the operator record. Separate from `write` on purpose -- this is
  // metadata about the plan, not part of what gets sent to the tenant.
  sectionProvenance: SectionProvenanceEntry[];
  // Kept for the operator record and for internal diffing -- never itself sent to a tenant. Exactly
  // one entry: the page's own change set.
  changeSets: ChangeSet[];
};

export type CompileSiteContentObjectsResult =
  | { ok: true; plan: PageMaterializationPlan }
  | { ok: false; blockers: OperationBlocker[] };

export type DraftedSectionInput = {
  // A caller-stable handle for this unit, independent of its position on the page. `target.sectionIds`
  // is keyed on it, and it is what keeps two byte-identical drafts distinct. Defaults to the unit's
  // own `order` rendered as a string when a caller does not supply one, so an existing order-keyed
  // caller keeps working unchanged.
  unitKey?: string;
  order: number;
  sectionType: string;
  draft: Record<string, unknown>;
  runId?: string | null;
  executionId?: string | null;
};

// A change this request names that reaches BEYOND the one page body being compiled. Always refused
// (`cross_object_change_unsupported`); the field exists so that refusal is a deliberate read of an
// explicit request, never a silent guess about what a caller meant.
export type CrossObjectChangeRequest = { objectType: string; objectId: string; reason: string };

export type SiteContentObjectTarget = {
  // The page being built or revised. null creates a new page.
  pageObjectId: string | null;
  // The page object's own top-level fields (route, pageType, title, seo, ...) -- NEVER `sections` and
  // NEVER `tracking`. Both are refused by name: `sections` is assembled here from `drafted`, and
  // `tracking` has exactly one writer (`set_tracking`) per the live `tracking_attribute` constraint.
  pageFields: Record<string, unknown>;
  // The page's tracking configuration, if this request sets one. Compiles to its own `set_tracking`
  // effect on a patch, and travels in the create body on a create (the one-writer funnel constrains
  // the patch-op grammar; `object_create` takes a whole body).
  tracking?: Record<string, unknown>;
  // Caller-preallocated inline section ids, keyed by `unitKey`. Each must match `^s_[a-z0-9]+$`.
  // Supply all of them or none: a partial map is refused (`preallocated_section_id_missing`).
  sectionIds?: Record<string, string>;
  // Existing INLINE section ids to update, keyed by unitKey. Naming any of these refuses the whole
  // request (`page_revise_path_unsupported`) -- see the module header for why the revise path cannot
  // be trusted against a production patch base.
  sectionTargets?: Record<string, string>;
  // What the caller believes the PAGE's contentRevision is. A page's content_revision covers its
  // entire body, inline sections included, as one counter -- so one guard at the page level is what
  // "an approval granted against one revision must not apply to another" actually requires.
  expectedPageContentRevision?: number;
  crossObjectChanges?: readonly CrossObjectChangeRequest[];
};

export type CompileSiteContentObjectsParams = {
  projectId: string;
  drafted: DraftedSectionInput[];
  snapshot: SiteSnapshot;
  target: SiteContentObjectTarget;
};

const blocker = (code: string, message: string, remedy: string, evidence: Record<string, unknown>): OperationBlocker => ({
  code,
  message,
  remedy,
  blocking: true,
  evidence
});

const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

const unitKeyOf = (input: DraftedSectionInput): string => input.unitKey ?? String(input.order);

// THE REGISTRY GATE. Reads `object_contract("page").section_types[]` -- structured, so `component_bound`
// and `footprint` survive. The PAGE contract is the authority (see header); a snapshot carrying only
// the older name-list shape, or only a `section` contract, reads as unavailable and refuses rather
// than silently allowing everything.
const pageSectionRegistry = (snapshot: SiteSnapshot): ReadonlyMap<string, SectionTypeRegistryEntry> | null => {
  const entries = snapshot.contracts.byType.page?.sectionRegistry;
  if (!entries || !entries.length) return null;
  return new Map(entries.map((entry) => [entry.type, entry]));
};

const pageTypeLaw = (snapshot: SiteSnapshot): readonly PageTypeRule[] | null => {
  const rules = snapshot.contracts.byType.page?.pageTypes;
  return rules && rules.length ? rules : null;
};

type SectionCompilation =
  | { ok: true; componentType: string; data: Record<string, unknown> }
  | { ok: false; blocker: OperationBlocker };

// THE ROUTING TABLE. Keyed on the drafting artifact's own discriminator, never on the planner's
// free-text `sectionType`. See the module header, rules 1/2.
//
// `require` performs BOTH registry checks, in order: is this type registered at all
// (`unsupported_section_type`), and may it be PLACED (`section_type_not_placeable`). No type is
// special-cased in either direction -- `before_after` passes because the live registry contains it,
// and `card` fails because its registry entry says `component_bound: false`, not because it is named
// here.
function compileSection(input: DraftedSectionInput, registry: ReadonlyMap<string, SectionTypeRegistryEntry>): SectionCompilation {
  const draft = input.draft;
  const title = asString(draft.title);
  const body = asString(draft.body);
  const unitKey = unitKeyOf(input);

  const refuse = (code: string, message: string, remedy: string, extra: Record<string, unknown> = {}): SectionCompilation => ({
    ok: false,
    blocker: blocker(code, message, remedy, { unitKey, order: input.order, plannedSectionType: input.sectionType, ...extra })
  });

  const require = (componentType: string, data: Record<string, unknown>): SectionCompilation => {
    const entry = registry.get(componentType);
    if (!entry) {
      return refuse(
        "unsupported_section_type",
        `Section "${unitKey}" ("${input.sectionType}") compiles to section type "${componentType}", which this tenant's page contract does not register. Registered: ${[...registry.keys()].sort().join(", ")}.`,
        `Either add "${componentType}" to the platform's section-type registry (a platform code change and deployment), or re-plan this section as one of the registered types.`,
        { componentType }
      );
    }
    if (!entry.componentBound && componentType !== PLACEABLE_WITHOUT_COMPONENT) {
      return refuse(
        "section_type_not_placeable",
        `Section "${unitKey}" compiles to section type "${componentType}", which the page contract registers with \`component_bound: false\` and \`footprint: null\` -- it has no bound component and no region, so it cannot be placed on a page. Only "${PLACEABLE_WITHOUT_COMPONENT}" is placeable without a bound component.`,
        `Re-plan this section as a placeable (component-bound) type. If "${componentType}" is meant to be nested inside another section's data rather than placed on the page, it belongs in that section's own data, not in this plan.`,
        { componentType, componentBound: entry.componentBound, footprint: entry.footprint }
      );
    }
    // The registry entry's own `data_schema` is the live `schema_zod` contract for this type's
    // `data`, and it is STRICT (`additionalProperties: false`). Validating here means a malformed
    // section is a named compile-time refusal instead of a tenant-side write rejection an operator
    // has to reconstruct from a 4xx.
    if (entry.dataSchema) {
      const validation = validateOutput(data, entry.dataSchema);
      if (!validation.ok) {
        return refuse(
          "section_data_invalid",
          `Section "${unitKey}" compiled to "${componentType}", but the data this compiler built does not satisfy that type's registered data schema: ${validation.errors.join("; ")}.`,
          `This is a defect in the routing for "${componentType}" or a malformed draft, not something to force through -- re-draft the section, or correct the routing so it emits what the registered schema declares.`,
          { componentType, errors: validation.errors }
        );
      }
    }
    return { ok: true, componentType, data };
  };

  const narrativeKind = asString(draft.narrativeKind);
  if (narrativeKind) {
    if (!body) return refuse("draft_body_missing", `Section "${unitKey}"'s organization narrative carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    if (narrativeKind === "people") {
      if (!title) return refuse("draft_title_missing", `Section "${unitKey}"'s people profile carries no title, and a bio section's heading has no other source.`, "Re-draft this section; its writer must return a title.");
      return require("bio", { heading: title, body, trustNotes: [] });
    }
    return require("prose", { body });
  }

  if (asString(draft.offeringKind)) {
    if (!body) return refuse("draft_body_missing", `Section "${unitKey}"'s offering description carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    return require("prose", { body });
  }

  const referenceKind = asString(draft.referenceKind);
  if (referenceKind) {
    const items = Array.isArray(draft.items) ? draft.items.filter(isBag) : [];
    if (referenceKind === "faq") {
      const pairs = items.map((item) => ({ q: asString(item.question), a: asString(item.answer) }));
      const incomplete = pairs.findIndex((pair) => !pair.q || !pair.a);
      if (incomplete >= 0) {
        return refuse(
          "faq_item_incomplete",
          `Section "${unitKey}"'s FAQ item ${incomplete} is missing its ${pairs[incomplete]!.q ? "answer" : "question"}. An incomplete item is a malformed draft, not one fewer question.`,
          "Re-draft this section; every FAQ item must carry both a question and an answer."
        );
      }
      if (!pairs.length) {
        return refuse(
          "faq_items_missing",
          `Section "${unitKey}" is an FAQ, but its draft carries no question/answer items -- only prose. An FAQ section renders items, and prose is a different section.`,
          "Re-draft this section so the reference writer returns `items` as question/answer pairs, or re-plan the section as a policy/prose section."
        );
      }
      return require("faq", { ...(title ? { heading: title } : {}), items: pairs.map((pair) => ({ q: pair.q!, a: pair.a! })) });
    }
    if (referenceKind === "process") {
      const steps = items.map((item) => ({ title: asString(item.question), description: asString(item.answer) }));
      const incomplete = steps.findIndex((step) => !step.title || !step.description);
      if (incomplete >= 0) {
        return refuse(
          "process_step_incomplete",
          `Section "${unitKey}"'s process item ${incomplete} is missing its ${steps[incomplete]!.title ? "description" : "title"}. An incomplete item is a malformed draft, not one fewer step.`,
          "Re-draft this section; every process item must carry both a title and its description."
        );
      }
      if (!steps.length) {
        return refuse(
          "process_steps_missing",
          `Section "${unitKey}" is a process, but its draft carries no ordered items -- only prose. A steps section renders ordered items with titles; compiling it as prose instead would publish a different section than the one planned, silently.`,
          "Re-draft this section so the reference writer returns `items` (one per step), or re-plan the section as a policy/prose section."
        );
      }
      return require("steps", { ...(title ? { heading: title } : {}), items: steps.map((step) => ({ title: step.title!, description: step.description! })) });
    }
    if (referenceKind === "comparison") {
      // `before_after` carries NO capability gate of its own -- it is in the live registry
      // (`component_bound: true`, region `flow`) and passes `require` like any other bound type.
      //
      // Its live `data_schema`, however, is NOT the `items: [{before, after}]` text list a comparison
      // draft naturally produces: it is a SINGLE image pair, `{before: {src, alt, label}, after:
      // {src, alt, label}}`, `required: ["before","after"]`, `additionalProperties: false`. A text
      // comparison cannot become one, and a multi-row comparison has nowhere to go. Both are refused
      // by name rather than emitted as a body the tenant's `schema_zod` gate would reject.
      const pairs = items.map((item) => ({ before: item.before, after: item.after }));
      const incomplete = pairs.findIndex((pair) => pair.before === undefined || pair.after === undefined || pair.before === null || pair.after === null);
      if (incomplete >= 0) {
        return refuse(
          "comparison_item_incomplete",
          `Section "${unitKey}"'s comparison item ${incomplete} is missing its ${pairs[incomplete]!.before === undefined || pairs[incomplete]!.before === null ? "before" : "after"} value. An incomplete item is a malformed draft, not one fewer comparison.`,
          "Re-draft this section; every comparison item must carry both a before and an after value."
        );
      }
      if (!pairs.length) {
        return refuse(
          "comparison_items_missing",
          `Section "${unitKey}" is a before/after comparison, but its draft carries no before/after items -- only prose.`,
          "Re-draft this section so the reference writer returns `items` as before/after pairs, or re-plan the section as a policy/prose section."
        );
      }
      if (pairs.length > 1) {
        return refuse(
          "comparison_multiple_pairs_unsupported",
          `Section "${unitKey}" carries ${pairs.length} comparison items, but the registered "before_after" type holds exactly ONE before/after pair (its data schema declares \`before\` and \`after\` as single objects, not an items array).`,
          "Split this into one before_after section per pair, or re-plan the section as a comparison_table."
        );
      }
      const pair = pairs[0]!;
      const media = (value: unknown): Record<string, unknown> | null =>
        isBag(value) && asString(value.src) && asString(value.alt) && asString(value.label) ? value : null;
      const before = media(pair.before);
      const after = media(pair.after);
      if (!before || !after) {
        return refuse(
          "comparison_media_unavailable",
          `Section "${unitKey}"'s comparison item does not carry the image references the registered "before_after" type requires: each side must be \`{src, alt, label}\`. A text-only before/after cannot be materialized as this section type.`,
          "Supply before/after image references for this comparison, or re-plan the section as a prose or comparison_table section.",
          { beforeShape: typeof pair.before, afterShape: typeof pair.after }
        );
      }
      return require("before_after", { ...(title ? { heading: title } : {}), before, after });
    }
    if (!body) return refuse("draft_body_missing", `Section "${unitKey}"'s ${referenceKind} draft carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    return require("prose", { body });
  }

  const revisionMode = asString(draft.mode);
  if (revisionMode) {
    const revised = asString(draft.revisedBody);
    if (!revised) return refuse("draft_body_missing", `Section "${unitKey}"'s ${revisionMode} carries no revised body.`, "Re-draft this section; its writer must return a non-empty revisedBody.");
    return require("prose", { body: revised });
  }

  return refuse(
    "unrecognized_draft_artifact",
    `Section "${unitKey}"'s draft carries none of the discriminators this compiler routes on (narrativeKind, offeringKind, referenceKind, mode), so there is no way to know which section type it is.`,
    "Check that the section was drafted by one of the site-content specialists; a draft from another node needs its own routing entry before it can be compiled."
  );
}

type InlineSectionEntry = { id: string; type: string; data: Record<string, unknown>; visibility?: unknown; notes?: unknown };

const isInlineSectionEntry = (value: unknown): value is InlineSectionEntry => isBag(value) && typeof value.id === "string" && typeof value.type === "string" && isBag(value.data);

// Content-derived section id, matching Platform's own minted-id pattern. Deterministic over (tenant,
// page target, unitKey, sectionType, draft content). Minted ONLY where the caller preallocated
// nothing -- see IDENTITY in the header.
const mintSectionId = (input: { tenantId: string; pageObjectId: string | null; unitKey: string; componentType: string; draftDigest: string }): string => {
  const digest = contentDigest(input).toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = `s_${digest || "0"}`;
  if (!SECTION_ID_PATTERN.test(id)) throw new Error(`mintSectionId produced "${id}", which does not match ${SECTION_ID_PATTERN}; this is a defect in this module, not recoverable input.`);
  return id;
};

export function compileSiteContentObjects(params: CompileSiteContentObjectsParams): CompileSiteContentObjectsResult {
  const { projectId, drafted, snapshot, target } = params;

  if (projectId !== snapshot.tenantId) {
    return {
      ok: false,
      blockers: [
        blocker(
          "foreign_tenant_reference",
          `These drafts were produced for "${projectId}" but the snapshot describes "${snapshot.tenantId}". Compiling one tenant's content against another's contracts is refused.`,
          `Capture a snapshot for "${projectId}" and compile against that.`,
          { draftingProjectId: projectId, snapshotTenantId: snapshot.tenantId }
        )
      ]
    };
  }

  const crossObjectChanges = target.crossObjectChanges ?? [];
  if (crossObjectChanges.length) {
    return {
      ok: false,
      blockers: crossObjectChanges.map((change) =>
        blocker(
          "cross_object_change_unsupported",
          `This request also names a change to ${change.objectType} "${change.objectId}" (${change.reason}). This compiler only ever compiles ONE page body; a change reaching beyond it is refused rather than folded into the page's own write or claimed atomic with it.`,
          `Compile and apply this page on its own, then handle the ${change.objectType} change through whatever already-supported multi-effect contract covers it -- never through this compiler.`,
          { objectType: change.objectType, objectId: change.objectId }
        )
      )
    };
  }

  if (!drafted.length) {
    return { ok: false, blockers: [blocker("no_drafted_sections", "There are no drafted sections to compile.", "Run site_content.draft_page first, and compile only a result that drafted at least one section.", { projectId })] };
  }

  // `sections` is THIS module's own output field, assembled from the compiled units below -- never a
  // pass-through of caller-supplied content. A caller that also puts a `sections` key on
  // `target.pageFields` almost certainly means something by it, and silently overwriting it would
  // discard that meaning without a trace. Refused by name instead, never silently overwritten.
  if ("sections" in target.pageFields) {
    return {
      ok: false,
      blockers: [
        blocker(
          "page_fields_sections_reserved",
          `target.pageFields carries a "sections" key. This compiler assembles "sections" itself from the drafted units -- a caller-supplied value there would be silently overwritten, which is refused instead.`,
          `Remove "sections" from pageFields; the compiled page's sections come entirely from \`drafted\`.`,
          { suppliedKeys: Object.keys(target.pageFields) }
        )
      ]
    };
  }

  // THE TRACKING FUNNEL. `tracking_attribute` (live constraint) makes `set_tracking` the only writer
  // of this key; the other six patch ops refuse it. A `tracking` key inside `pageFields` would be
  // compiled into `set_page_meta`, which the tenant rejects -- so it is refused here, by name, with
  // the supported channel named in the remedy.
  if ("tracking" in target.pageFields) {
    return {
      ok: false,
      blockers: [
        blocker(
          "page_fields_tracking_reserved",
          `target.pageFields carries a "tracking" key. The live \`tracking_attribute\` constraint makes \`set_tracking\` the ONLY writer of a page's tracking configuration -- the other six page patch ops refuse it -- so a tracking value routed through pageFields would compile into \`set_page_meta\` and be rejected by the tenant.`,
          `Remove "tracking" from pageFields and pass it as \`target.tracking\` instead; it compiles to its own \`set_tracking\` effect.`,
          { suppliedKeys: Object.keys(target.pageFields) }
        )
      ]
    };
  }

  const registry = pageSectionRegistry(snapshot);
  if (!registry) {
    return {
      ok: false,
      blockers: [
        blocker(
          "section_type_registry_unavailable",
          `The snapshot for "${snapshot.tenantId}" carries no \`page\` object contract declaring a \`section_types\` registry, so no section type can be validated and nothing can be checked for placeability.`,
          "Capture a snapshot whose `page` contract includes the top-level `section_types` registry (object_contract(\"page\")), then compile again.",
          { tenantId: snapshot.tenantId, capturedTypes: Object.keys(snapshot.contracts.byType) }
        )
      ]
    };
  }

  const sectionTargets = target.sectionTargets ?? {};
  const standaloneSectionIds = new Set((snapshot.objects.byType.section ?? []).map((object) => object.objectId));

  let existingPage: SiteContextObject | undefined;
  if (target.pageObjectId) {
    existingPage = (snapshot.objects.byType.page ?? []).find((object) => object.objectId === target.pageObjectId);
    if (!existingPage) {
      return {
        ok: false,
        blockers: [
          blocker(
            "patch_target_not_in_snapshot",
            `The request names page "${target.pageObjectId}" as its patch target, which this snapshot does not contain.`,
            "Re-capture the snapshot, or drop the page objectId so a new page is compiled instead.",
            { objectId: target.pageObjectId, objectType: "page" }
          )
        ]
      };
    }
    const expected = target.expectedPageContentRevision;
    if (expected !== undefined && expected !== existingPage.contentRevision) {
      return {
        ok: false,
        blockers: [
          blocker(
            "stale_target",
            `Page "${target.pageObjectId}" is at content revision ${existingPage.contentRevision}, not the ${expected} this request was prepared against -- it changed underneath.`,
            "Re-read the page, re-approve against its current revision, and compile again.",
            { objectId: target.pageObjectId, expectedContentRevision: expected, actualContentRevision: existingPage.contentRevision }
          )
        ]
      };
    }
    // CARRY-FORWARD REFUSAL, NOT AN OVERSIGHT -- see the module header. In production a page row comes
    // from `object_inventory`'s SUMMARY listing, which carries no body: `fields.sections` is absent
    // entirely. Compiling a patch against that base would see zero existing sections and append a
    // duplicate of every section the page already has. Refused by name.
    if (!Array.isArray(existingPage.fields.sections)) {
      return {
        ok: false,
        blockers: [
          blocker(
            "page_body_unavailable_for_patch",
            `Page "${target.pageObjectId}" appears in this snapshot without a \`sections\` array, so its current body is unknown. Compiling a patch against a body-less row would append a duplicate of every section the page already holds, silently. Production snapshots come from \`object_inventory\`'s summary listing, which carries no body at all -- so this is the normal production case, not a rare one.`,
            "Capture a snapshot whose page rows carry their real body (an `object_get`-backed read, not the `object_inventory` summary listing), or compile this page as a create instead. Making the production adapter carry page bodies is tracked as its own task.",
            { objectId: target.pageObjectId, carryForward: "site-content patch base needs an object_get-backed page body" }
          )
        ]
      };
    }
  }

  // THE REVISE PATH, REFUSED BY NAME. Naming an existing inline section to rewrite is exactly the path
  // whose base cannot be trusted; it is refused as a whole rather than half-implemented. The seven-op
  // union above already declares `update_section_data` / `move_section` / `set_section_visibility` /
  // `remove_section` so the carry-forward task adds emission, not vocabulary.
  const namedTargets = Object.entries(sectionTargets);
  if (namedTargets.length) {
    return {
      ok: false,
      blockers: namedTargets.map(([unitKey, objectId]) =>
        blocker(
          // A shared/standalone section is called out separately, because it stays refused even after
          // the patch base is fixed -- it needs multi-object atomicity this repository does not have.
          standaloneSectionIds.has(objectId) ? "unsupported_shared_section_mutation" : "page_revise_path_unsupported",
          standaloneSectionIds.has(objectId)
            ? `Unit "${unitKey}" names patch target "${objectId}", which is a standalone/shared section object, not one of a page's own inline sections. This compiler only materializes a page's own inline sections; mutating a shared section is a separate capability that needs its own multi-object atomicity.`
            : `Unit "${unitKey}" names existing inline section "${objectId}" to rewrite. Revising a page's existing sections requires diffing against that page's current body, and this compiler's patch base cannot be trusted to carry one (see \`page_body_unavailable_for_patch\`). Rather than emit a plan that may duplicate or clobber existing content, the revise path is refused outright.`,
          standaloneSectionIds.has(objectId)
            ? "Do not name a shared/standalone section as a patch target. Editing the shared section itself needs a dedicated operation this repository does not yet have."
            : "Compile this page as a create, or wait for the carry-forward task that gives the compiler an `object_get`-backed patch base. Do not work around this by re-supplying the page's existing sections as drafts -- that is the duplication this refusal exists to prevent.",
          { unitKey, objectId, carryForward: "page-revise path: separate task" }
        )
      )
    };
  }

  const ordered = [...drafted].sort((left, right) => left.order - right.order);
  const blockers: OperationBlocker[] = [];

  const duplicateOrders = ordered.filter((entry, index) => index > 0 && entry.order === ordered[index - 1]!.order);
  if (duplicateOrders.length) {
    blockers.push(
      blocker(
        "duplicate_section_order",
        `Two drafted sections share order ${duplicateOrders[0]!.order}, so their position on the page is undecidable.`,
        "Re-draft with distinct section orders; the compiler will not pick one.",
        { orders: ordered.map((entry) => entry.order) }
      )
    );
  }

  const unitKeys = ordered.map(unitKeyOf);
  const duplicateUnitKey = unitKeys.find((key, index) => unitKeys.indexOf(key) !== index);
  if (duplicateUnitKey !== undefined) {
    blockers.push(
      blocker(
        "duplicate_unit_key",
        `Two drafted sections share the unit key "${duplicateUnitKey}", so a preallocated section id could not be attributed to either of them.`,
        "Give each drafted unit its own `unitKey` (or distinct orders, which is what a unit key defaults to).",
        { unitKeys }
      )
    );
  }

  // IDENTITY (C4). Preallocation is all-or-nothing per request: a caller that supplied SOME ids meant
  // to control identity, and minting the rest behind their back is exactly the silent behaviour this
  // kernel refuses everywhere else.
  const preallocated = target.sectionIds ?? {};
  const preallocatedCount = Object.keys(preallocated).length;
  for (const [unitKey, id] of Object.entries(preallocated)) {
    if (!SECTION_ID_PATTERN.test(id)) {
      blockers.push(
        blocker(
          "section_id_malformed",
          `The preallocated section id "${id}" for unit "${unitKey}" does not match Platform's own section id pattern ${SECTION_ID_PATTERN}. An id the page contract rejects is a write that fails at the tenant, not a compile that succeeded.`,
          `Supply an id matching ${SECTION_ID_PATTERN} (lowercase alphanumerics after the "s_" prefix), or omit it entirely and let the compiler mint one.`,
          { unitKey, sectionId: id, pattern: SECTION_ID_PATTERN.source }
        )
      );
    }
    if (!unitKeys.includes(unitKey)) {
      blockers.push(
        blocker(
          "preallocated_section_id_unmatched",
          `A section id was preallocated for unit "${unitKey}", but no drafted unit carries that unit key. An id that matches nothing is a caller believing it controlled a section this plan does not contain.`,
          "Check the unit key spelling, or drop the entry; every preallocated id must name a drafted unit.",
          { unitKey, knownUnitKeys: unitKeys }
        )
      );
    }
  }
  if (preallocatedCount) {
    const missing = unitKeys.filter((key) => !(key in preallocated));
    if (missing.length) {
      blockers.push(
        blocker(
          "preallocated_section_id_missing",
          `Section ids were preallocated for some units but not for ${missing.map((key) => `"${key}"`).join(", ")}. Preallocation is all-or-nothing: a caller that preallocated part of a page meant to control section identity, and minting the rest behind that intent would break the very guarantee preallocation exists for.`,
          "Preallocate an id for every drafted unit, or preallocate none and let the compiler mint all of them.",
          { missingUnitKeys: missing, suppliedUnitKeys: Object.keys(preallocated) }
        )
      );
    }
  }

  type Compiled = { input: DraftedSectionInput; unitKey: string; componentType: string; sectionId: string; sectionIdOrigin: "preallocated" | "minted"; data: Record<string, unknown> };
  const compiled: Compiled[] = [];

  for (const entry of ordered) {
    const unitKey = unitKeyOf(entry);

    if (asString(entry.draft.mode)) {
      blockers.push(
        blocker(
          "revision_without_target",
          `Unit "${unitKey}" is a revision/localization, which rewrites an existing section, but no patch target was named for it.`,
          "Name the existing inline section's id in `sectionTargets` for this unit -- noting that the revise path is itself refused today (`page_revise_path_unsupported`) -- or re-draft the section as new content.",
          { unitKey, order: entry.order }
        )
      );
      continue;
    }

    const section = compileSection(entry, registry);
    if (!section.ok) {
      blockers.push(section.blocker);
      continue;
    }

    const supplied = preallocated[unitKey];
    const sectionId = supplied ?? mintSectionId({
      tenantId: snapshot.tenantId,
      pageObjectId: target.pageObjectId,
      unitKey,
      componentType: section.componentType,
      draftDigest: contentDigest(entry.draft)
    });

    compiled.push({
      input: entry,
      unitKey,
      componentType: section.componentType,
      sectionId,
      sectionIdOrigin: supplied ? "preallocated" : "minted",
      data: section.data
    });
  }

  const seenIds = new Map<string, string>();
  for (const item of compiled) {
    const owner = seenIds.get(item.sectionId);
    if (owner !== undefined) {
      blockers.push(
        blocker(
          "duplicate_section_id",
          `Units "${owner}" and "${item.unitKey}" both resolve to section id "${item.sectionId}". Two sections cannot share an id: one would overwrite the other, and which one is undecidable.`,
          "Give each unit its own section id (preallocate distinct ids, or give the units distinct unit keys so minted ids differ).",
          { sectionId: item.sectionId, unitKeys: [owner, item.unitKey] }
        )
      );
      continue;
    }
    seenIds.set(item.sectionId, item.unitKey);
  }

  // PAGETYPE LAW. `page_types[].allowedSections` and `requiredSections`, read off the live page
  // contract. A page type this snapshot's law does not name is refused rather than waved through.
  const law = pageTypeLaw(snapshot);
  const declaredPageType = asString(target.pageFields.pageType) ?? asString(existingPage?.fields.pageType);
  if (law && declaredPageType) {
    const rule = law.find((candidate) => candidate.id === declaredPageType);
    if (!rule) {
      blockers.push(
        blocker(
          "page_type_unknown",
          `This page declares pageType "${declaredPageType}", which the tenant's page contract does not define. Known page types: ${law.map((candidate) => candidate.id).join(", ")}.`,
          "Use one of the page types the contract defines; a page type the tenant does not know cannot have its section law checked at all.",
          { pageType: declaredPageType, knownPageTypes: law.map((candidate) => candidate.id) }
        )
      );
    } else {
      if (rule.allowedSections !== "any") {
        const allowed = new Set(rule.allowedSections);
        for (const item of compiled) {
          if (!allowed.has(item.componentType)) {
            blockers.push(
              blocker(
                "section_not_allowed_for_page_type",
                `Unit "${item.unitKey}" compiles to "${item.componentType}", which pageType "${rule.id}" (${rule.routePattern}) does not allow. Allowed: ${[...rule.allowedSections].join(", ")}.`,
                `Re-plan this section as one of the types "${rule.id}" allows, or compile this content onto a page type that allows "${item.componentType}".`,
                { unitKey: item.unitKey, componentType: item.componentType, pageType: rule.id, allowedSections: [...rule.allowedSections] }
              )
            );
          }
        }
      }
      // requiredSections is checked against the page's FULL section list -- the units compiled here
      // plus, on a patch, the sections the page already carries.
      const existingTypes = Array.isArray(existingPage?.fields.sections)
        ? (existingPage!.fields.sections as unknown[]).filter(isInlineSectionEntry).map((section) => section.type)
        : [];
      const presentTypes = new Set([...existingTypes, ...compiled.map((item) => item.componentType)]);
      for (const required of rule.requiredSections) {
        if (!presentTypes.has(required)) {
          blockers.push(
            blocker(
              "page_type_required_section_missing",
              `pageType "${rule.id}" (${rule.routePattern}) requires a "${required}" section, and this page would have none.`,
              `Draft a "${required}" section for this page, or compile this content onto a page type that does not require one.`,
              { pageType: rule.id, requiredSection: required, presentSectionTypes: [...presentTypes] }
            )
          );
        }
      }
    }
  }

  if (blockers.length) return { ok: false, blockers };

  const compiledSections = compiled.map((item) => ({ id: item.sectionId, type: item.componentType, data: item.data }));

  const candidatePageFields: Record<string, unknown> = target.pageObjectId
    ? { ...existingPage!.fields, ...target.pageFields, sections: [...(existingPage!.fields.sections as unknown[]), ...compiledSections] }
    : { ...target.pageFields, sections: compiledSections, ...(target.tracking ? { tracking: target.tracking } : {}) };

  // REQUIRED PAGE FIELDS (C3). All five, `seo` included, as NAMED blockers -- one per missing field,
  // never a single lumped "invalid page". Nothing is invented: a missing required field is a refusal.
  const missingRequired = PAGE_REQUIRED_FIELDS.filter((field) => candidatePageFields[field] === undefined || candidatePageFields[field] === null);
  if (missingRequired.length) {
    return {
      ok: false,
      blockers: missingRequired.map((field) =>
        blocker(
          "page_field_required_missing",
          `The page contract requires "${field}", and this request supplies no value for it. The five required page fields are ${PAGE_REQUIRED_FIELDS.join(", ")} (object_contract("page"), read live 2026-09-18).`,
          `Supply "${field}" in target.pageFields. No default is applied for a required field -- a page written without one is a page the tenant refuses, and a value invented here would be a value nobody chose.`,
          { field, requiredFields: [...PAGE_REQUIRED_FIELDS], suppliedKeys: Object.keys(candidatePageFields) }
        )
      )
    };
  }

  const pageCandidateResult = compileCandidate({
    snapshot,
    objectType: "page",
    intent: target.pageObjectId ? `site_content: extend page "${target.pageObjectId}"` : "site_content: create a page from a drafted plan",
    fields: candidatePageFields,
    objectId: target.pageObjectId
  });
  if (!pageCandidateResult.ok) return { ok: false, blockers: pageCandidateResult.blockers };

  const pageChangeSet = computeChangeSet({ snapshot, candidate: pageCandidateResult.candidate });

  const sectionProvenance: SectionProvenanceEntry[] = compiled.map((item) => ({
    unitKey: item.unitKey,
    order: item.input.order,
    plannedSectionType: item.input.sectionType,
    componentType: item.componentType,
    sectionId: item.sectionId,
    sectionIdOrigin: item.sectionIdOrigin,
    action: "create",
    sourceRunId: item.input.runId ?? null,
    sourceExecutionId: item.input.executionId ?? null
  }));

  let write: PageMaterializationWrite;
  if (!target.pageObjectId) {
    write = { kind: "create", fields: candidatePageFields };
  } else {
    const existingCount = (existingPage!.fields.sections as unknown[]).length;
    // `set_page_meta` carries only the top-level fields that actually changed -- never "sections"
    // (a section op's job) and never "tracking" (set_tracking's job, per the one-writer funnel).
    const metaFields = Object.fromEntries(
      pageChangeSet.diffs.filter((diff) => diff.field !== "sections" && diff.field !== "tracking").map((diff) => [diff.field, diff.after])
    );
    const ops: PageObjectPatchOp[] = [];
    if (Object.keys(metaFields).length) ops.push({ op: "set_page_meta", fields: metaFields });
    compiled.forEach((item, index) => {
      ops.push({ op: "upsert_section", section: { id: item.sectionId, type: item.componentType, data: item.data }, position: existingCount + index });
    });
    if (target.tracking) ops.push({ op: "set_tracking", fields: target.tracking });

    // `ops` is never empty here: `drafted` is non-empty (checked above), every unit either pushed a
    // blocker or landed in `compiled`, and we only reach this point with no blockers -- so at least
    // one `upsert_section` is always present. There is no "nothing to do" patch to refuse.
    write = { kind: "patch", ops };
  }

  const materializationKey = contentDigest({
    tenantId: snapshot.tenantId,
    page: { objectId: target.pageObjectId, fields: target.pageFields, tracking: target.tracking ?? null },
    sections: compiled.map((item) => ({
      unitKey: item.unitKey,
      // Order is part of the key on purpose: a genuine reorder renders a different page and must get
      // its own key, never dedupe onto the pre-reorder apply.
      order: item.input.order,
      componentType: item.componentType,
      sectionId: item.sectionId,
      draftDigest: contentDigest(item.input.draft)
    }))
  });

  return {
    ok: true,
    plan: {
      schemaVersion: PAGE_MATERIALIZATION_SCHEMA_VERSION,
      tenantId: snapshot.tenantId,
      materializationKey,
      page: { objectId: target.pageObjectId, action: target.pageObjectId ? "patch" : "create", targetContentRevision: existingPage ? existingPage.contentRevision : null },
      write,
      sectionProvenance,
      changeSets: [pageChangeSet]
    }
  };
}
