// P2 v2 -- the step between a drafted page and a site that has one.
//
// `site_content.draft_page` (siteContentDraftingExecutor.ts) ends with drafts in hand and writes
// nothing. This module is the deterministic compilation of those drafts into a CANDIDATE PAGE
// MATERIALIZATION PLAN: which supported component type each drafted section becomes, whether the
// page is created or patched, and -- for a patch -- exactly which named page-object patch ops would
// apply the change. It is the last step before an applier; it is not the applier.
//
// THIS MODULE NEVER WRITES, NEVER PUBLISHES, NEVER CALLS A TENANT. It is a pure function of
// (drafting result, snapshot, target) -> a plan or named blockers.
//
// SCHEMA v2 -- WHY THIS REPLACED v1. Platform's real `page` object contract (object_contract, read
// 2026-09-18) does not model a page's sections as independently created/patched `section` objects.
// Sections are INLINE data embedded in the page body's own `sections` array
// (`{id: "s_...", visibility, notes, type, data}`), and `object_patch` on a `page` is not a flat
// field-map replace -- it is a fixed set of named ops: `set_page_meta` (top-level page fields only;
// "sections are edited only via section ops" per the live contract), `upsert_section`,
// `update_section_data`, `move_section`, `set_section_visibility`, `remove_section`. v1 treated every
// drafted section as its own separately-creatable/patchable `section` object with a flat field map --
// a shape that does not exist for the default (inline) case Platform actually serves. v2 compiles to
// ONE page-level effect: a create (the full body, sections inline) or a patch (one `ops` array built
// from the named ops above). A `section` object DOES exist as its own top-level type in Platform's
// registry, but only for `shared_ref` -- a section stored independently and referenced across pages --
// and nothing in this repo's fixtures or captured snapshots shows one in real use; mutating one is
// refused by name (`unsupported_shared_section_mutation`) rather than half-implemented, so a future
// wave can add proper multi-object atomicity for that case without this one having guessed at it.
//
// THREE RULES CARRIED OVER FROM v1, UNCHANGED.
//
// 1. A SEMANTIC SECTION KIND IS NOT A COMPONENT TYPE. The planner's own `sectionType` vocabulary
//    ("about_overview", "our_team", ...) is never a registered component type. What a tenant accepts
//    is `contract.sectionTypes` (siteContext.ts) -- the tenant's registered component vocabulary,
//    carried on the `section` object contract this module reads via `supportedComponentTypes` below.
//
// CORRECTION (2026-09-18, post-merge adversarial review of PR #387): this module originally read the
// registry off `properties.sectionType.enum` inside the section contract's `body_schema` -- a shape
// that does not exist on the live contract and made `supportedComponentTypes` return null on every
// real compile (`section_type_registry_unavailable`, unconditionally). A live read of
// `object_contract` for BOTH `page` and `section` (2026-09-18) shows the real registry is a TOP-LEVEL
// `section_types` key -- `[{ type, component_bound, data_schema, editor, footprint }, ...]` -- a
// SIBLING of `body_schema`, never a path inside it; the live `section` contract's own `body_schema` is
// instead `{ tracking, section: { oneOf: [ ...one variant per section type... ] } }`, which has no
// `sectionType` property at all. `contract.sectionTypes` (siteContext.ts) is that registry, extracted
// by siteContextSourceAdapter.ts from the real top-level key; the fixtures in this module's own test
// file now carry a literal excerpt of that live response (tests/agent/operations/fixtures/
// liveObjectContractCapture.ts) rather than a hand-imagined shape.
//
// 2. A MISSING FACT IS A REFUSAL, NEVER A DOWNGRADE. Unchanged from v1 -- see compileSection below.
//
// 3. ALL OR NOTHING. Any refusal on any section fails the whole compilation.
//
// IDEMPOTENCY. `materializationKey` is a content digest of (tenant, page target, each section's
// order + resolved component type + a digest of the draft itself). It deliberately does NOT include
// the snapshot digest, matching v1 -- see that reasoning preserved below. Section ids this module
// mints (for a create, or for a brand-new section on a patch) are ALSO content-derived
// (mintSectionId), so replaying the identical request against the identical snapshot mints the
// identical id -- required for the plan itself to be a stable, replayable idempotency key, independent
// of whatever the writer's own replay behaviour turns out to be (object_create's idempotency_key
// replay is best-effort; object_patch has none at all -- see the applier's header).
import type { Candidate } from "./candidates.js";
import { compileCandidate } from "./candidates.js";
import type { ChangeSet } from "./changeSet.js";
import { computeChangeSet } from "./changeSet.js";
import { contentDigest } from "./contentHash.js";
import type { OperationBlocker } from "./operationTypes.js";
import type { SiteContextObject, SiteSnapshot } from "./siteContext.js";

export const PAGE_MATERIALIZATION_SCHEMA_VERSION = "site-page-materialization.v2" as const;
export type PageMaterializationSchemaVersion = typeof PAGE_MATERIALIZATION_SCHEMA_VERSION;

const MINTED_SECTION_ID_PATTERN = /^s_[a-z0-9]+$/;

// Named page-object patch ops -- verbatim shape of Platform's live `object_patch(page)` arg_schemas
// (object_contract, read 2026-09-18), translated to this module's own field naming (camelCase
// internally; the writer that actually calls the tenant translates back to the wire's snake_case
// `section_id` / `to_index`). `guard` is deliberately not modelled here: it is an applier/writer
// concern (a fresh compare-and-set token), never something a compile-time plan can freeze.
export type PageObjectPatchOp =
  | { op: "set_page_meta"; fields: Record<string, unknown> }
  | { op: "upsert_section"; section: { id: string } & Record<string, unknown>; position?: number }
  | { op: "update_section_data"; sectionId: string; fields: Record<string, unknown> }
  | { op: "move_section"; sectionId: string; toIndex: number }
  | { op: "set_section_visibility"; sectionId: string; visibility: "public" | "hidden" | null }
  | { op: "remove_section"; sectionId: string };

export type SectionMaterializationAction = "create" | "update" | "unchanged";

export type SectionProvenanceEntry = {
  // The planner's own order value, preserved exactly -- never renumbered.
  order: number;
  plannedSectionType: string;
  componentType: string;
  // The inline section id this plan writes or patches -- minted here (mintSectionId) for a create or
  // a brand-new section on a patch; the existing inline id, unchanged, for an update.
  sectionId: string;
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
  // Per-section traceability for the operator record: which run/execution produced each section's
  // draft, what it compiled to, and which named op (or none, if unchanged) carries it. Separate from
  // `write` on purpose -- this is metadata about the plan, not part of what gets sent to the tenant.
  sectionProvenance: SectionProvenanceEntry[];
  // Kept for the operator record and for internal diffing (computeChangeSet's diffs are what
  // `set_page_meta.fields` is built from) -- never itself sent to a tenant. Exactly one entry: the
  // page's own change set.
  changeSets: ChangeSet[];
};

export type CompileSiteContentObjectsResult =
  | { ok: true; plan: PageMaterializationPlan }
  | { ok: false; blockers: OperationBlocker[] };

export type DraftedSectionInput = {
  order: number;
  sectionType: string;
  draft: Record<string, unknown>;
  runId?: string | null;
  executionId?: string | null;
};

export type SiteContentObjectTarget = {
  // The page being built or revised. null creates a new page.
  pageObjectId: string | null;
  // The page object's own top-level fields (pageType, slug, title, seo, ...) -- NEVER `sections`.
  // Sections are derived from `drafted` + `sectionTargets` below; a caller that supplies `sections`
  // here is refused (`page_fields_must_not_include_sections`) rather than silently overridden, so a
  // caller cannot believe it controlled section placement through a channel this module ignores.
  pageFields: Record<string, unknown>;
  // Existing INLINE section ids to update, keyed by the planner order they correspond to -- an id
  // that must appear in the target page's own current `fields.sections[].id`, not a standalone
  // `section` object. An order absent from this map creates a new inline section.
  sectionTargets?: Record<number, string>;
  // What the caller believes the PAGE's contentRevision is. A page's content_revision covers its
  // entire body, inline sections included, as one counter (Platform's own model -- a body write of
  // any kind bumps it) -- so one guard at the page level is what "an approval granted against one
  // revision must not apply to another" actually requires; there is no separate per-section revision
  // to check.
  expectedPageContentRevision?: number;
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

// Reads the tenant's registered component-type vocabulary off `contract.sectionTypes` -- the real
// top-level `section_types` registry (see this module's header, "CORRECTION" note, for the live
// evidence this replaced a fictional `body_schema` path with).
const supportedComponentTypes = (snapshot: SiteSnapshot): readonly string[] | null => {
  const types = snapshot.contracts.byType.section?.sectionTypes;
  return types && types.length ? types : null;
};

type SectionCompilation =
  | { ok: true; componentType: string; data: Record<string, unknown> }
  | { ok: false; blocker: OperationBlocker };

// THE ROUTING TABLE -- unchanged from v1. Keyed on the drafting artifact's own discriminator, never
// on the planner's free-text `sectionType`. See the module header, rule 1/2.
function compileSection(input: DraftedSectionInput, supported: readonly string[]): SectionCompilation {
  const draft = input.draft;
  const title = asString(draft.title);
  const body = asString(draft.body);

  const refuse = (code: string, message: string, remedy: string): SectionCompilation => ({
    ok: false,
    blocker: blocker(code, message, remedy, { order: input.order, plannedSectionType: input.sectionType })
  });

  const require = (componentType: string, data: Record<string, unknown>): SectionCompilation =>
    supported.includes(componentType)
      ? { ok: true, componentType, data }
      : refuse(
          "unsupported_section_type",
          `Section ${input.order} ("${input.sectionType}") compiles to component type "${componentType}", which this tenant's section contract does not declare. Declared: ${supported.join(", ")}.`,
          `Either add "${componentType}" to the tenant's component registry (a platform code change and deployment), or re-plan this section as one of the declared types.`
        );

  const narrativeKind = asString(draft.narrativeKind);
  if (narrativeKind) {
    if (!body) return refuse("draft_body_missing", `Section ${input.order}'s organization narrative carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    if (narrativeKind === "people") {
      if (!title) return refuse("draft_title_missing", `Section ${input.order}'s people profile carries no title, and a bio section's heading has no other source.`, "Re-draft this section; its writer must return a title.");
      return require("bio", { heading: title, body, trustNotes: [] });
    }
    return require("prose", { body });
  }

  if (asString(draft.offeringKind)) {
    if (!body) return refuse("draft_body_missing", `Section ${input.order}'s offering description carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
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
          `Section ${input.order}'s FAQ item ${incomplete} is missing its ${pairs[incomplete]!.q ? "answer" : "question"}. An incomplete item is a malformed draft, not one fewer question.`,
          "Re-draft this section; every FAQ item must carry both a question and an answer."
        );
      }
      if (!pairs.length) {
        return refuse(
          "faq_items_missing",
          `Section ${input.order} is an FAQ, but its draft carries no question/answer items -- only prose. An FAQ section renders items, and prose is a different section.`,
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
          `Section ${input.order}'s process item ${incomplete} is missing its ${steps[incomplete]!.title ? "description" : "title"}. An incomplete item is a malformed draft, not one fewer step.`,
          "Re-draft this section; every process item must carry both a title and its description."
        );
      }
      if (!steps.length) {
        return refuse(
          "process_steps_missing",
          `Section ${input.order} is a process, but its draft carries no ordered items -- only prose. A steps section renders ordered items with titles; compiling it as prose instead would publish a different section than the one planned, silently.`,
          "Re-draft this section so the reference writer returns `items` (one per step), or re-plan the section as a policy/prose section."
        );
      }
      return require("steps", { ...(title ? { heading: title } : {}), items: steps.map((step) => ({ title: step.title!, description: step.description! })) });
    }
    if (!body) return refuse("draft_body_missing", `Section ${input.order}'s ${referenceKind} draft carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    return require("prose", { body });
  }

  const revisionMode = asString(draft.mode);
  if (revisionMode) {
    const revised = asString(draft.revisedBody);
    if (!revised) return refuse("draft_body_missing", `Section ${input.order}'s ${revisionMode} carries no revised body.`, "Re-draft this section; its writer must return a non-empty revisedBody.");
    return require("prose", { body: revised });
  }

  return refuse(
    "unrecognized_draft_artifact",
    `Section ${input.order}'s draft carries none of the discriminators this compiler routes on (narrativeKind, offeringKind, referenceKind, mode), so there is no way to know which component type it is.`,
    "Check that the section was drafted by one of the site-content specialists; a draft from another node needs its own routing entry before it can be compiled."
  );
}

type InlineSectionEntry = { id: string; type: string; data: Record<string, unknown>; visibility?: unknown; notes?: unknown };

const isInlineSectionEntry = (value: unknown): value is InlineSectionEntry => isBag(value) && typeof value.id === "string" && typeof value.type === "string" && isBag(value.data);

// The page's own current inline sections, straight off its `fields.sections` array -- never off
// `snapshot.objects.byType.section`, which (per the module header) holds only standalone `shared_ref`
// targets, not a page's own content.
const inlineSectionsOf = (page: SiteContextObject | undefined): InlineSectionEntry[] => {
  const raw = page?.fields.sections;
  return Array.isArray(raw) ? raw.filter(isInlineSectionEntry) : [];
};

// Content-derived section id, matching Platform's own minted-id pattern (`^s_[a-z0-9]+$`) so this
// module never has to distinguish "an id we minted" from "an id the server minted" downstream.
// Deterministic over (tenant, page target, order, componentType, draft content): replaying the
// identical request against the identical snapshot mints the identical id -- see IDEMPOTENCY above.
const mintSectionId = (input: { tenantId: string; pageObjectId: string | null; order: number; componentType: string; draftDigest: string }): string => {
  const digest = contentDigest(input).toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = `s_${digest || "0"}`;
  if (!MINTED_SECTION_ID_PATTERN.test(id)) throw new Error(`mintSectionId produced "${id}", which does not match ${MINTED_SECTION_ID_PATTERN}; this is a defect in this module, not recoverable input.`);
  return id;
};

// Field-level diff over two flat maps, restricted to the keys the CALLER named in `after` (never a
// key present only in `before`) -- omission means "leave as-is", not "clear", matching every other
// refusal-over-guess rule in this kernel. There is therefore no "remove" case to refuse here: a
// caller cannot express one through this shape at all.
const changedFields = (before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> => {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) changed[key] = value;
  }
  return changed;
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

  if (!drafted.length) {
    return { ok: false, blockers: [blocker("no_drafted_sections", "There are no drafted sections to compile.", "Run site_content.draft_page first, and compile only a result that drafted at least one section.", { projectId })] };
  }

  if ("sections" in target.pageFields) {
    return {
      ok: false,
      blockers: [
        blocker(
          "page_fields_must_not_include_sections",
          "target.pageFields carries a \"sections\" key. Sections are derived from `drafted` and `sectionTargets`, never from pageFields, so a caller-supplied value here would be silently ignored.",
          "Remove \"sections\" from pageFields; name existing inline sections to patch via `sectionTargets` instead.",
          { projectId }
        )
      ]
    };
  }

  const supported = supportedComponentTypes(snapshot);
  if (!supported) {
    return {
      ok: false,
      blockers: [
        blocker(
          "section_type_registry_unavailable",
          `The snapshot for "${snapshot.tenantId}" carries no section contract declaring which component types exist, so no section type can be validated.`,
          "Capture a snapshot that includes the `section` object type, then compile again.",
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
  }
  const existingInline = inlineSectionsOf(existingPage);
  const existingInlineById = new Map(existingInline.map((entry) => [entry.id, entry]));

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

  type Compiled = { input: DraftedSectionInput; componentType: string; sectionId: string; action: SectionMaterializationAction; op: PageObjectPatchOp | null; candidate: Candidate };
  const compiled: Compiled[] = [];
  let newSectionsAppended = 0;

  for (const entry of ordered) {
    const targetId = sectionTargets[entry.order];

    if (targetId && !target.pageObjectId) {
      blockers.push(
        blocker(
          "section_target_without_page",
          `Section ${entry.order} names patch target "${targetId}", but no existing page is being patched (target.pageObjectId is null) -- there is no page whose inline sections it could belong to.`,
          "Either drop the page objectId to create a new page (with no sectionTargets), or supply the existing page's objectId.",
          { order: entry.order, objectId: targetId }
        )
      );
      continue;
    }

    let existingEntry: InlineSectionEntry | undefined;
    if (targetId) {
      existingEntry = existingInlineById.get(targetId);
      const isSharedRefEntry = existingEntry?.type === "shared_ref";
      if (!existingEntry || isSharedRefEntry) {
        if (isSharedRefEntry || standaloneSectionIds.has(targetId)) {
          blockers.push(
            blocker(
              "unsupported_shared_section_mutation",
              `Section ${entry.order} names patch target "${targetId}", which is a standalone/shared section (a \`shared_ref\` on this page, or a top-level \`section\` object), not one of this page's own inline sections. This compiler only materializes a page's own inline sections; mutating a shared section is a separate, not-yet-implemented capability that needs its own multi-object atomicity.`,
              "Do not name a shared/standalone section as a patch target. If the intent is genuinely to edit the shared section itself, that needs a dedicated operation this repository does not yet have.",
              { order: entry.order, objectId: targetId }
            )
          );
        } else {
          blockers.push(
            blocker(
              "patch_target_not_in_snapshot",
              `Section ${entry.order} names patch target "${targetId}", which does not appear among page "${target.pageObjectId}"'s inline sections in this snapshot.`,
              "Re-capture the snapshot, or drop the target so the section is created instead.",
              { order: entry.order, objectId: targetId }
            )
          );
        }
        continue;
      }
    }

    if (asString(entry.draft.mode) && !targetId) {
      blockers.push(
        blocker(
          "revision_without_target",
          `Section ${entry.order} is a revision/localization, which rewrites an existing section, but no patch target was named for that order.`,
          "Name the existing inline section's id in `sectionTargets` for this order, or re-draft the section as new content.",
          { order: entry.order }
        )
      );
      continue;
    }

    const section = compileSection(entry, supported);
    if (!section.ok) {
      blockers.push(section.blocker);
      continue;
    }

    // Validate the compiled {sectionType, data} shape against the tenant's section contract --
    // exactly the check v1 ran, reused unchanged: it is the same component/data registry regardless
    // of whether the section ends up inline or (one day) standalone.
    const candidateResult = compileCandidate({
      snapshot,
      objectType: "section",
      intent: `site_content: ${existingEntry ? "revise" : "create"} the "${entry.sectionType}" section at order ${entry.order}`,
      fields: { sectionType: section.componentType, data: section.data },
      objectId: null
    });
    if (!candidateResult.ok) {
      blockers.push(...candidateResult.blockers);
      continue;
    }

    if (!existingEntry) {
      const sectionId = mintSectionId({ tenantId: snapshot.tenantId, pageObjectId: target.pageObjectId, order: entry.order, componentType: section.componentType, draftDigest: contentDigest(entry.draft) });
      const position = target.pageObjectId ? existingInline.length + newSectionsAppended : undefined;
      newSectionsAppended += 1;
      compiled.push({
        input: entry,
        componentType: section.componentType,
        sectionId,
        action: "create",
        op: target.pageObjectId ? { op: "upsert_section", section: { id: sectionId, type: section.componentType, data: section.data }, ...(position !== undefined ? { position } : {}) } : null,
        candidate: candidateResult.candidate
      });
      continue;
    }

    const typeUnchanged = existingEntry.type === section.componentType;
    const removedFields = typeUnchanged ? Object.keys(existingEntry.data).filter((key) => !(key in section.data)) : [];
    const dataChanged = JSON.stringify(existingEntry.data) !== JSON.stringify(section.data);

    if (typeUnchanged && !dataChanged) {
      compiled.push({ input: entry, componentType: section.componentType, sectionId: existingEntry.id, action: "unchanged", op: null, candidate: candidateResult.candidate });
      continue;
    }

    if (typeUnchanged && !removedFields.length) {
      // A pure merge -- update_section_data can express it exactly, and does not need every field
      // resent, only what changed.
      compiled.push({
        input: entry,
        componentType: section.componentType,
        sectionId: existingEntry.id,
        action: "update",
        op: { op: "update_section_data", sectionId: existingEntry.id, fields: changedFields(existingEntry.data, section.data) },
        candidate: candidateResult.candidate
      });
      continue;
    }

    // The component type changed, or a field the existing data carried is absent from the new data.
    // `update_section_data` MERGES and cannot clear a field (the same limitation the v1 applier
    // refused a "remove" diff for); `upsert_section` REPLACES the whole section and can express
    // either change faithfully, at the same id and (implicitly) the same position.
    compiled.push({
      input: entry,
      componentType: section.componentType,
      sectionId: existingEntry.id,
      action: "update",
      op: { op: "upsert_section", section: { id: existingEntry.id, type: section.componentType, data: section.data } },
      candidate: candidateResult.candidate
    });
  }

  if (blockers.length) return { ok: false, blockers };

  const candidatePageFields: Record<string, unknown> = target.pageObjectId
    ? { ...existingPage!.fields, ...target.pageFields, sections: existingPage!.fields.sections }
    : { ...target.pageFields, sections: compiled.map((item) => ({ id: item.sectionId, type: item.componentType, data: item.candidate.fields.data })) };

  const pageCandidateResult = compileCandidate({
    snapshot,
    objectType: "page",
    intent: target.pageObjectId ? `site_content: revise page "${target.pageObjectId}"` : "site_content: create a page from a drafted plan",
    fields: candidatePageFields,
    objectId: target.pageObjectId
  });
  if (!pageCandidateResult.ok) return { ok: false, blockers: pageCandidateResult.blockers };

  const pageChangeSet = computeChangeSet({ snapshot, candidate: pageCandidateResult.candidate });

  const sectionProvenance: SectionProvenanceEntry[] = compiled.map((item) => ({
    order: item.input.order,
    plannedSectionType: item.input.sectionType,
    componentType: item.componentType,
    sectionId: item.sectionId,
    action: item.action,
    sourceRunId: item.input.runId ?? null,
    sourceExecutionId: item.input.executionId ?? null
  }));

  let write: PageMaterializationWrite;
  if (!target.pageObjectId) {
    write = { kind: "create", fields: candidatePageFields };
  } else {
    // `set_page_meta` carries only the top-level fields that actually changed (never "sections" --
    // candidatePageFields pins it to the page's own current value for a patch, so computeChangeSet
    // never reports it as moved).
    const metaFields = Object.fromEntries(pageChangeSet.diffs.filter((diff) => diff.field !== "sections").map((diff) => [diff.field, diff.after]));
    const ops: PageObjectPatchOp[] = [];
    if (Object.keys(metaFields).length) ops.push({ op: "set_page_meta", fields: metaFields });
    for (const item of compiled) if (item.op) ops.push(item.op);

    if (!ops.length) {
      return {
        ok: false,
        blockers: [
          blocker(
            "no_effective_changes",
            `Compiling page "${target.pageObjectId}" against these drafts produced no page-meta change and no section that is new, retyped, or edited -- there is nothing for a patch to do.`,
            "Confirm the drafts actually differ from what the page already holds, or that pageFields names a field that changed.",
            { objectId: target.pageObjectId }
          )
        ]
      };
    }
    write = { kind: "patch", ops };
  }

  const materializationKey = contentDigest({
    tenantId: snapshot.tenantId,
    page: { objectId: target.pageObjectId, fields: target.pageFields },
    sections: compiled.map((item) => ({ order: item.input.order, componentType: item.componentType, sectionId: item.sectionId, draftDigest: contentDigest(item.input.draft) }))
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
