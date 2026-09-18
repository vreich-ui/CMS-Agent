// C1 (Wave 1) — a second, incompatible compiler for the drafted-page-to-site-objects step
// siteContentObjectCompiler.ts (v1, current) already covers, built because v1's OWN modeling of
// Platform's page dialect is wrong, not because the step it performs is wrong.
//
// WHAT V1 GOT WRONG, WITH EVIDENCE. v1 compiles every drafted section into its OWN candidate
// `section` object (its own change set, its own create/patch decision) and references it from the
// page's `sections` array as `{order, section: <id>}`, or — before an id exists — `{order,
// pendingSectionIndex: <n>}` for the applier to resolve later (siteContentObjectCompiler.ts,
// current; siteContentObjectApplier.ts's resolvePageSections). Real Platform page bodies do not
// look like that: a page carries its sections INLINE, each `{id, type, data}`, directly inside its
// own `sections` array, alongside its own top-level `route`/`pageType`/`title` — see, in THIS repo,
// tests exercising the real capture/clone object wire (not a compiler's own fixture):
//   tests/agent/capture/cloneAdjudicationWiring.test.ts:122 — body: { route, sections: [{id,type,data}] }
//   tests/agent/capture/cloneLockLeakAudit.test.ts:199       — same shape
//   tests/agent/capture/cloneEngineRefusals.test.ts:198,251  — body: { route, sections: [{type}] }
//   tests/agent/capture/cloneRestampLockRetry.test.ts:96     — body: { route, sections: [{id,type,data}] }
//   tests/agent/capture/determinismHarness.test.ts:416       — body: { route, sections: [{type,data}] }
//   tests/agent/capture/gapReplayHarness.test.ts:163          — a captured page's own top-level pageType
//   tests/agent/capture/emitMediaResumption.test.ts:135       — body: { route, title }
// `seo` is NOT independently re-derived from one of those call sites here; it is carried on this
// task's own stated authority that it belongs on a page body, and should be re-confirmed against a
// live object_contract("page") response before a writer adapter trusts it as anything more than
// optional. Say so wherever this module's output is read, rather than implying it was captured the
// same way route/pageType/title/sections were.
//
// THIS MODULE NEVER WRITES, NEVER PUBLISHES, NEVER CALLS A TENANT — the same discipline as v1's own
// header, in full. It is a pure function of (drafted units, captured snapshot, target, preallocated
// section identities) -> one page change set or named blockers.
//
// IDENTITY IS ALLOCATED, NEVER MINTED HERE. Every compiled section needs an `id` before this module
// can even assemble the page's `sections` array — there is no "pendingSectionIndex" placeholder in
// v2, because the applier-side rewrite that resolves one is exactly the multi-object machinery this
// module exists to not need. That id comes from `sectionIds`, keyed by each unit's own `unitKey` — a
// stable identity the CALLER assigns once, when a section is first drafted, and never derives from
// this unit's content or its display `order`. Two consequences of keying by `unitKey` rather than
// content or position:
//   - two units whose drafted content is byte-identical still get distinct ids, because they are
//     still two INTENDED sections, not one deduplicated by coincidence of content.
//   - a page whose sections are reordered (order values reassigned) keeps every unit's original id,
//     because the lookup never used `order` in the first place.
// This module never allocates a `unitKey` -> id pair itself, deterministically or otherwise: an id
// it invented would still need to reconcile with whatever id an actual object_create eventually
// mints, and reconciliation is exactly the class of bug a pure compiler should not introduce. A unit
// with no entry in `sectionIds` is refused by name (`section_identity_not_preallocated` below),
// never silently assigned one.
//
// SCOPE, DELIBERATELY NARROW FOR THIS WAVE. `target.mode` is a closed union of exactly one value,
// "create": this module compiles a brand-new page from a set of drafted section units, and nothing
// else. Naming any other mode, or supplying `crossObjectChanges` (a change to something besides this
// page), is refused by name as an unsupported task mode — never attempted as a partial best effort,
// and never silently folded into the page's own patch. Revising an existing page's sections, and any
// multi-object change that is not itself a single page body, are carry-forward work for a later
// wave; a caller who needs them today gets a named blocker pointing at that gap, not a wrong answer.
//
// RICH TEXT IS NOT PLAIN TEXT, AND THIS MODULE DOES NOT CONVERT BETWEEN THEM. A `content_revision.v1`
// draft (mode: "revise"/"localize") can revise copy that started life anywhere — an article's plain
// body, another page's rich-text section — and its own output schema carries no field saying which.
// Compiling one into a page section without an explicit signal would be exactly the "fabricated
// interchangeability" this task's brief warns against. This module therefore requires the draft to
// declare `bodyFormat: "richText"` itself before a revision/localization draft becomes a page
// section at all — never assumed, never coerced from a plain-text draft. A `mode: "localize"` draft
// must also carry its own `targetLocale` — the explicit destination a localized section is FOR, not
// inferred from where it happens to land.
//
// ALL OR NOTHING. Every unit is compiled and every blocker collected before this module returns; one
// bad unit refuses the whole page, and the caller sees every problem in the batch at once rather than
// fixing them one refusal at a time (siteContentObjectCompiler.ts's rule 3, kept whole).
import type { ChangeSet } from "./changeSet.js";
import { computeChangeSet } from "./changeSet.js";
import { compileCandidate } from "./candidates.js";
import { contentDigest } from "./contentHash.js";
import type { OperationBlocker } from "./operationTypes.js";
import type { SiteSnapshot } from "./siteContext.js";

export const SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION = "site-page-materialization.v2" as const;

// Where a tenant's captured capabilities declare which component types exist — the SAME read v1
// uses (siteContentObjectCompiler.ts's SECTION_TYPE_ENUM_PATH), for the same reason: it is the one
// place this kernel already has a tenant's real component registry. v2 reads it purely for
// CAPABILITY DISCOVERY (is "before_after" declared? is a type known at all?) — it never creates a
// standalone `section` object from it, and never will.
const SECTION_TYPE_ENUM_PATH = ["properties", "sectionType", "enum"] as const;

// A component type this compiler refuses to place as a page's own top-level section REGARDLESS of
// whether the tenant's capability declares it — not a capability gap, a placement rule: `card` is a
// child of a composing component (`content_grid`, `composition`), never a page's own direct section,
// and a tenant declaring the type at all says nothing about where it is legal to stand alone.
const PAGE_LEVEL_DISALLOWED_TYPES: ReadonlySet<string> = new Set(["card"]);

export type SitePageSectionV2 = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

export type CompiledPageUnitV2 = {
  unitKey: string;
  order: number;
  plannedSectionType: string;
  componentType: string;
  sectionId: string;
  sourceRunId: string | null;
  sourceExecutionId: string | null;
};

export type SitePageMaterializationV2Plan = {
  schemaVersion: typeof SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION;
  tenantId: string;
  materializationKey: string;
  page: { action: "create"; changeSetId: string };
  units: CompiledPageUnitV2[];
  changeSet: ChangeSet;
};

export type CompilePagePlanV2Result = { ok: true; plan: SitePageMaterializationV2Plan } | { ok: false; blockers: OperationBlocker[] };

export type DraftedPageUnitV2 = {
  // Stable across a reorder — see IDENTITY in the module header. Never derived from `order` or from
  // `draft`'s own content.
  unitKey: string;
  order: number;
  sectionType: string;
  draft: Record<string, unknown>;
  runId?: string | null;
  executionId?: string | null;
};

export type SitePageMaterializationV2Target = {
  // Closed to "create" for this wave — see SCOPE in the module header.
  mode: "create";
  // route, pageType, title, and whatever else this tenant's page contract requires (seo included,
  // per this task's brief — see the module header's caveat on that field). Never defaulted here: a
  // missing required field is `required_field_missing` from compileCandidate, not invented content.
  pageFields: Record<string, unknown>;
};

export type CrossObjectChangeRequest = {
  objectType: string;
  objectId: string;
  reason: string;
};

export type CompilePagePlanV2Params = {
  projectId: string;
  units: DraftedPageUnitV2[];
  snapshot: SiteSnapshot;
  target: SitePageMaterializationV2Target;
  // unitKey -> the section id already allocated for it. Never generated by this module — see
  // IDENTITY above.
  sectionIds: Record<string, string>;
  // A named, explicit escape hatch for "this would also need to change something besides this
  // page" — see SCOPE above. Always refused today; the field exists so that refusal is a deliberate
  // read of an explicit request, never a silent guess about what a caller meant.
  crossObjectChanges?: readonly CrossObjectChangeRequest[];
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

const supportedComponentTypes = (snapshot: SiteSnapshot): readonly string[] | null => {
  const contract = snapshot.contracts.byType.section;
  if (!contract) return null;
  let cursor: unknown = contract.schema;
  for (const key of SECTION_TYPE_ENUM_PATH) {
    if (!isBag(cursor)) return null;
    cursor = cursor[key];
  }
  if (!Array.isArray(cursor)) return null;
  const types = cursor.filter((entry): entry is string => typeof entry === "string");
  return types.length ? types : null;
};

type UnitCompilation = { ok: true; componentType: string; data: Record<string, unknown> } | { ok: false; blocker: OperationBlocker };

// THE ROUTING TABLE. Mirrors siteContentObjectCompiler.ts's own — same drafting artifacts, same
// discriminators, same refuse-don't-downgrade rule for structured content — extended with the
// `comparison` -> `before_after` route (see PAGE_LEVEL_DISALLOWED_TYPES above for the different,
// unconditional kind of refusal `card` gets) and the rich-text/localization gates a revision must
// clear before it becomes a page section (see RICH TEXT IS NOT PLAIN TEXT in the module header).
function compileUnit(unit: DraftedPageUnitV2, supported: readonly string[]): UnitCompilation {
  const draft = unit.draft;
  const title = asString(draft.title);
  const body = asString(draft.body);

  const refuse = (code: string, message: string, remedy: string): UnitCompilation => ({
    ok: false,
    blocker: blocker(code, message, remedy, { unitKey: unit.unitKey, order: unit.order, plannedSectionType: unit.sectionType })
  });

  const require = (componentType: string, data: Record<string, unknown>): UnitCompilation => {
    if (PAGE_LEVEL_DISALLOWED_TYPES.has(componentType)) {
      return refuse(
        "unplaceable_standalone_section",
        `Section "${unit.unitKey}" (order ${unit.order}) would compile to component type "${componentType}", which never stands alone as a page's own section — it exists only as a child of a composing component. This is a placement rule, not a capability gap: declaring "${componentType}" supported elsewhere does not make it a legal top-level page section.`,
        `Re-plan this section as a component type this compiler may place directly on a page; nesting "${componentType}" inside a composing component is a path this compiler does not build.`
      );
    }
    return supported.includes(componentType)
      ? { ok: true, componentType, data }
      : refuse(
          "unsupported_section_type",
          `Section "${unit.unitKey}" (order ${unit.order}, "${unit.sectionType}") compiles to component type "${componentType}", which this tenant's captured section contract does not declare. Declared: ${supported.join(", ")}.`,
          `Either capture a snapshot after "${componentType}" is registered for this tenant, or re-plan this section as one of the declared types.`
        );
  };

  const narrativeKind = asString(draft.narrativeKind);
  if (narrativeKind) {
    if (!body) return refuse("draft_body_missing", `Section "${unit.unitKey}"'s organization narrative carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    if (narrativeKind === "people") {
      if (!title) return refuse("draft_title_missing", `Section "${unit.unitKey}"'s people profile carries no title, and a bio section's heading has no other source.`, "Re-draft this section; its writer must return a title.");
      return require("bio", { heading: title, body, trustNotes: [] });
    }
    // A short featured teaser resolves to the real registered `card` component — correctly
    // identifying WHAT it is — but `card` is never placeable as a page's own top-level section (see
    // PAGE_LEVEL_DISALLOWED_TYPES above), so `require` refuses it unconditionally, capability aside.
    if (narrativeKind === "spotlight") {
      if (!title) return refuse("draft_title_missing", `Section "${unit.unitKey}"'s spotlight carries no title.`, "Re-draft this section; its writer must return a title.");
      return require("card", { heading: title, body });
    }
    return require("prose", { body });
  }

  if (asString(draft.offeringKind)) {
    if (!body) return refuse("draft_body_missing", `Section "${unit.unitKey}"'s offering description carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
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
          `Section "${unit.unitKey}"'s FAQ item ${incomplete} is missing its ${pairs[incomplete]!.q ? "answer" : "question"}. An incomplete item is a malformed draft, not one fewer question.`,
          "Re-draft this section; every FAQ item must carry both a question and an answer."
        );
      }
      if (!pairs.length) {
        return refuse(
          "faq_items_missing",
          `Section "${unit.unitKey}" is an FAQ, but its draft carries no question/answer items — only prose. An FAQ section renders items, and prose is a different section.`,
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
          `Section "${unit.unitKey}"'s process item ${incomplete} is missing its ${steps[incomplete]!.title ? "description" : "title"}. An incomplete item is a malformed draft, not one fewer step.`,
          "Re-draft this section; every process item must carry both a title and its description."
        );
      }
      if (!steps.length) {
        return refuse(
          "process_steps_missing",
          `Section "${unit.unitKey}" is a process, but its draft carries no ordered items — only prose. A steps section renders ordered items with titles; compiling it as prose instead would publish a different section than the one planned, silently.`,
          "Re-draft this section so the reference writer returns `items` (one per step), or re-plan the section as a policy/prose section."
        );
      }
      return require("steps", { ...(title ? { heading: title } : {}), items: steps.map((step) => ({ title: step.title!, description: step.description! })) });
    }

    if (referenceKind === "comparison") {
      // `before_after` — a component type gated PURELY on capability, unlike `card`'s unconditional
      // placement refusal above. A tenant that has not registered it yet gets `unsupported_section_type`
      // exactly like any other undeclared type, never a special-cased allowance.
      const pairs = items.map((item) => ({ before: asString(item.before), after: asString(item.after) }));
      const incomplete = pairs.findIndex((pair) => !pair.before || !pair.after);
      if (incomplete >= 0) {
        return refuse(
          "comparison_item_incomplete",
          `Section "${unit.unitKey}"'s comparison item ${incomplete} is missing its ${pairs[incomplete]!.before ? "after" : "before"} value. An incomplete item is a malformed draft, not one fewer comparison.`,
          "Re-draft this section; every comparison item must carry both a before and an after value."
        );
      }
      if (!pairs.length) {
        return refuse(
          "comparison_items_missing",
          `Section "${unit.unitKey}" is a before/after comparison, but its draft carries no before/after items — only prose.`,
          "Re-draft this section so the reference writer returns `items` as before/after pairs, or re-plan the section as a policy/prose section."
        );
      }
      return require("before_after", { ...(title ? { heading: title } : {}), items: pairs.map((pair) => ({ before: pair.before!, after: pair.after! })) });
    }

    if (!body) return refuse("draft_body_missing", `Section "${unit.unitKey}"'s ${referenceKind} draft carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    return require("prose", { body });
  }

  const revisionMode = asString(draft.mode);
  if (revisionMode) {
    const revised = asString(draft.revisedBody);
    if (!revised) return refuse("draft_body_missing", `Section "${unit.unitKey}"'s ${revisionMode} carries no revised body.`, "Re-draft this section; its writer must return a non-empty revisedBody.");
    // RICH TEXT IS NOT PLAIN TEXT — see module header. An unlabelled revision is refused, never
    // assumed safe for a rich-text page section.
    const bodyFormat = asString(draft.bodyFormat);
    if (bodyFormat !== "richText") {
      return refuse(
        "content_revision_format_unconfirmed",
        `Section "${unit.unitKey}"'s ${revisionMode} does not declare bodyFormat: "richText" (got ${bodyFormat ? `"${bodyFormat}"` : "nothing"}). A page section renders rich text; an article's plain body is a different format, and this compiler will not assume an unlabelled revision is safe to place in one.`,
        `Have the reviser declare bodyFormat: "richText" explicitly before this draft is compiled into a page section, or route this revision to wherever its plain-text destination actually is.`
      );
    }
    if (revisionMode === "localize" && !asString(draft.targetLocale)) {
      return refuse(
        "localization_destination_missing",
        `Section "${unit.unitKey}" is a localize revision but carries no targetLocale — the explicit destination a localized section is FOR cannot be inferred from where it happens to land.`,
        "Re-draft this section with targetLocale set, naming the locale this content is actually for."
      );
    }
    return require("prose", { body: revised });
  }

  return refuse(
    "unrecognized_draft_artifact",
    `Section "${unit.unitKey}"'s draft carries none of the discriminators this compiler routes on (narrativeKind, offeringKind, referenceKind, mode), so there is no way to know which component type it is.`,
    "Check that the section was drafted by one of the site-content specialists; a draft from another node needs its own routing entry before it can be compiled."
  );
}

export function compilePagePlanV2(params: CompilePagePlanV2Params): CompilePagePlanV2Result {
  const { projectId, units, snapshot, target, sectionIds, crossObjectChanges } = params;

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

  if (target.mode !== "create") {
    return {
      ok: false,
      blockers: [
        blocker(
          "unsupported_task_mode",
          `compilePagePlanV2 supports only "create" in this wave; "${String(target.mode)}" was requested.`,
          `Revising an existing page is not yet supported by this compiler — carry-forward work for a later wave. Compile a new page, or use the v1 compiler (siteContentObjectCompiler.ts) if its multi-object model already covers the revision you need.`,
          { requestedMode: target.mode }
        )
      ]
    };
  }

  if (crossObjectChanges && crossObjectChanges.length) {
    return {
      ok: false,
      blockers: crossObjectChanges.map((change) =>
        blocker(
          "cross_object_change_unsupported",
          `This request also names a change to ${change.objectType} "${change.objectId}" (${change.reason}). This compiler only ever compiles ONE page body; a change reaching beyond it is refused rather than folded into the page's own patch or claimed atomic with it.`,
          `Compile and apply this page on its own, then handle the ${change.objectType} change through whatever already-supported multi-effect contract covers it — never through this compiler.`,
          { objectType: change.objectType, objectId: change.objectId }
        )
      )
    };
  }

  if (!units.length) {
    return {
      ok: false,
      blockers: [blocker("no_drafted_sections", "There are no drafted sections to compile.", "Run site_content.draft_page first, and compile only a result that drafted at least one section.", { projectId })]
    };
  }

  // `sections` is THIS module's own output field, assembled from the compiled units below — never a
  // pass-through of caller-supplied content. A caller that also puts a `sections` key on
  // `target.pageFields` almost certainly means something by it (existing sections to keep? a typo
  // for a different field?), and silently overwriting it with the compiled array would discard that
  // meaning without a trace. Refused by name instead.
  if ("sections" in target.pageFields) {
    return {
      ok: false,
      blockers: [
        blocker(
          "page_fields_sections_reserved",
          `target.pageFields already carries a "sections" key. This compiler assembles "sections" itself from the compiled units — a caller-supplied value there would be silently overwritten, which is refused instead.`,
          `Remove "sections" from pageFields; the compiled page's sections come entirely from \`units\`.`,
          { suppliedKeys: Object.keys(target.pageFields) }
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
          "Capture a snapshot that includes the `section` object type's contract, then compile again.",
          { tenantId: snapshot.tenantId, capturedTypes: Object.keys(snapshot.contracts.byType) }
        )
      ]
    };
  }

  const ordered = [...units].sort((left, right) => left.order - right.order);
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

  const duplicateKeys = ordered.filter((entry, index) => ordered.findIndex((candidate) => candidate.unitKey === entry.unitKey) !== index);
  if (duplicateKeys.length) {
    blockers.push(
      blocker(
        "duplicate_unit_key",
        `Two or more drafted sections share unitKey "${duplicateKeys[0]!.unitKey}" — each drafted section needs its own stable identity, or their preallocated ids collide.`,
        "Assign each drafted section a distinct unitKey before compiling.",
        { unitKey: duplicateKeys[0]!.unitKey }
      )
    );
  }

  const compiled: Array<{ unit: DraftedPageUnitV2; componentType: string; data: Record<string, unknown>; sectionId: string }> = [];

  for (const unit of ordered) {
    const sectionId = sectionIds[unit.unitKey];
    if (!sectionId) {
      blockers.push(
        blocker(
          "section_identity_not_preallocated",
          `Section "${unit.unitKey}" (order ${unit.order}) has no preallocated section id in \`sectionIds\`. This compiler mints no ids of its own — see IDENTITY in the module header.`,
          `Allocate a stable id for unitKey "${unit.unitKey}" and pass it in \`sectionIds\` before compiling.`,
          { unitKey: unit.unitKey, order: unit.order }
        )
      );
      continue;
    }

    const result = compileUnit(unit, supported);
    if (!result.ok) {
      blockers.push(result.blocker);
      continue;
    }

    compiled.push({ unit, componentType: result.componentType, data: result.data, sectionId });
  }

  if (blockers.length) return { ok: false, blockers };

  const duplicateSectionIds = compiled.filter((entry, index) => compiled.findIndex((candidate) => candidate.sectionId === entry.sectionId) !== index);
  if (duplicateSectionIds.length) {
    return {
      ok: false,
      blockers: [
        blocker(
          "duplicate_preallocated_section_id",
          `Preallocated section id "${duplicateSectionIds[0]!.sectionId}" is assigned to more than one drafted section — two distinct intended units must never share one identity.`,
          "Assign each unitKey its own, distinct preallocated section id.",
          { sectionId: duplicateSectionIds[0]!.sectionId }
        )
      ]
    };
  }

  const inlineSections: SitePageSectionV2[] = compiled.map((entry) => ({ id: entry.sectionId, type: entry.componentType, data: entry.data }));

  const pageCandidateResult = compileCandidate({
    snapshot,
    objectType: "page",
    intent: "site_content: create a page (v2 — one inline page body, no standalone section objects)",
    fields: { ...target.pageFields, sections: inlineSections },
    objectId: null
  });
  if (!pageCandidateResult.ok) return { ok: false, blockers: pageCandidateResult.blockers };

  const changeSet = computeChangeSet({ snapshot, candidate: pageCandidateResult.candidate });

  // IDENTITY IS ALLOCATED, NOT DERIVED (see module header): `sectionId` is included per unit
  // alongside its content digest, so two units with byte-identical drafts still contribute distinct
  // entries to this digest, and the digest is stable across a reorder because it is keyed on
  // `unitKey`/`sectionId`, never on `order`'s position in the array.
  const materializationKey = contentDigest({
    schemaVersion: SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION,
    tenantId: snapshot.tenantId,
    pageFields: target.pageFields,
    units: compiled.map((entry) => ({
      unitKey: entry.unit.unitKey,
      componentType: entry.componentType,
      sectionId: entry.sectionId,
      draftDigest: contentDigest(entry.unit.draft)
    }))
  });

  return {
    ok: true,
    plan: {
      schemaVersion: SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION,
      tenantId: snapshot.tenantId,
      materializationKey,
      page: { action: "create", changeSetId: changeSet.changeSetId },
      units: compiled.map((entry) => ({
        unitKey: entry.unit.unitKey,
        order: entry.unit.order,
        plannedSectionType: entry.unit.sectionType,
        componentType: entry.componentType,
        sectionId: entry.sectionId,
        sourceRunId: entry.unit.runId ?? null,
        sourceExecutionId: entry.unit.executionId ?? null
      })),
      changeSet
    }
  };
}

// -------------------------------------------------------------------------------------------
// VERSION GUARD — keeping the v1/v2 boundary from ever being crossed by coincidence.
//
// A v1 SiteContentObjectPlan (siteContentObjectCompiler.ts) carries no `schemaVersion` field at
// all — it was never versioned, because until this module there was only ever one shape. A plan
// CARRYING this module's exact schemaVersion literal is unambiguous, and the two directions this
// boundary must never be crossed both reduce to checking that one literal:
//   - a v2 plan must never be fed to the v1 applier (applySiteContentPlan,
//     siteContentObjectApplier.ts), which reads plan.changeSets/plan.sections in the multi-object
//     shape and would either throw on a v2 plan's different shape or, worse, partially succeed
//     against fields that happen to coincide.
//   - a v1 plan must never be read by anything expecting this module's plan shape, on the theory
//     that "it's a compiled plan, close enough" — there is no such thing as "close enough" between
//     one page-plus-N-objects and one page.
// -------------------------------------------------------------------------------------------

export function isSitePageMaterializationV2Plan(value: unknown): value is SitePageMaterializationV2Plan {
  return isBag(value) && value.schemaVersion === SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION;
}

/** Refuses anything that is not exactly a v2 plan — including a v1 SiteContentObjectPlan, which has no schemaVersion at all. */
export function assertSitePageMaterializationV2Plan(value: unknown, context = "plan"): asserts value is SitePageMaterializationV2Plan {
  if (isSitePageMaterializationV2Plan(value)) return;
  const gotVersion = isBag(value) ? value.schemaVersion : undefined;
  throw new Error(
    `Expected a "${SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION}" plan for ${context}, but got schemaVersion=${JSON.stringify(gotVersion)}. ` +
      `A v1 SiteContentObjectPlan (siteContentObjectCompiler.ts) carries no schemaVersion field and is never a v2 plan by coincidence — this refusal is deliberate.`
  );
}

/** Refuses a v2 plan specifically — the guard a v1-shaped consumer (e.g. applySiteContentPlan) should run before trusting an untyped value is its own v1 shape. */
export function assertNotSitePageMaterializationV2Plan(value: unknown, context = "plan"): void {
  if (!isSitePageMaterializationV2Plan(value)) return;
  throw new Error(
    `A "${SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION}" plan was passed as ${context}, where a v1 SiteContentObjectPlan is expected. ` +
      `The v1 applier (applySiteContentPlan, siteContentObjectApplier.ts) models every section as its own object and reads plan.changeSets/plan.sections in that shape; ` +
      `feeding it a v2 plan (one page body with inline sections) would fail confusingly or apply the wrong effects. Refused.`
  );
}
