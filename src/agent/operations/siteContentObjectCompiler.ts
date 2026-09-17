// P2 — the step between a drafted page and a site that has one.
//
// `site_content.draft_page` (siteContentDraftingExecutor.ts) ends with drafts in hand and writes
// nothing. This module is the deterministic compilation of those drafts into CANDIDATE SITE
// OBJECTS: which supported section type each drafted section becomes, whether it creates a new
// section or patches an existing one, what the page's ordered section references are, and what
// field-level change set each of those would save. It is the last step before an applier; it is not
// the applier.
//
// THIS MODULE NEVER WRITES, NEVER PUBLISHES, NEVER CALLS A TENANT. It is a pure function of
// (drafting result, snapshot, target) -> change sets or named blockers. Every write-shaped word
// below is a declaration in the same sense changeSet.ts's `effects` already are, and changeSet.ts
// only ever declares a "save" — the draft/applied/published lifecycle is somebody else's authority
// and this module does not model it.
//
// THREE RULES IT EXISTS TO ENFORCE.
//
// 1. A SEMANTIC SECTION KIND IS NOT A COMPONENT TYPE. The planner returns `sectionType` strings like
//    "about_overview" or "our_team" — its own vocabulary for what a section is FOR. Those are not
//    registered platform component types and never were. What a tenant actually accepts is the
//    enum in its own `section` object contract, read off the snapshot (SECTION_TYPE_ENUM_PATH
//    below) — never a list maintained in this file. The routing table here maps the DRAFT ARTIFACT
//    (organization_narrative.v1 / offering_description.v1 / reference_content.v1 /
//    content_revision.v1) and its own discriminator onto a component type, and then checks that
//    type against the tenant's enum. A type the tenant does not declare is refused by name.
//
// 2. A MISSING FACT IS A REFUSAL, NEVER A DOWNGRADE. `steps` needs ordered items with titles; a
//    process draft that produced only prose cannot become a `steps` section, and quietly making it
//    a `prose` section instead would ship a different page than the one the recipe asked for, with
//    nothing in the record saying so. Same for an FAQ draft with no `items`. Both refuse by name and
//    say what would fix them.
//
// 3. ALL OR NOTHING. Any refusal on any section fails the whole compilation. A page half-built from
//    the sections that happened to map is the exact shape of damage an operator cannot see and
//    cannot undo: the missing section is invisible, the page reads as finished, and the next replay
//    has no way to tell what it already wrote. #381 made the drafting step all-or-nothing on
//    supplement pairing for the same reason; this is that rule one stage further down, where the
//    consequences are durable rather than conversational.
//
// IDEMPOTENCY. `materializationKey` is a content digest of (tenant, page target, each section's
// order + resolved component type + a digest of the draft itself). Replaying the same request
// against the same snapshot produces the identical key and the identical `changeSetId`s
// (changeSet.ts derives those from content too), so an applier that has journalled a key can
// recognise a duplicate rather than minting a second page. It deliberately does NOT include the
// snapshot digest: a replay against a moved snapshot is the same INTENT, and staleness is a
// separate question with a separate answer (`isChangeSetStale`, and `stale_target` below).
import type { Candidate } from "./candidates.js";
import { compileCandidate } from "./candidates.js";
import type { ChangeSet } from "./changeSet.js";
import { computeChangeSet } from "./changeSet.js";
import { contentDigest } from "./contentHash.js";
import type { OperationBlocker } from "./operationTypes.js";
import type { SiteContextObject, SiteSnapshot } from "./siteContext.js";

// Where a tenant's own `section` contract declares which component types it accepts. Read, never
// assumed: a tenant whose contract does not carry this enum gets `section_type_registry_unavailable`
// and no compilation at all, because the alternative is writing a section type nothing renders.
const SECTION_TYPE_ENUM_PATH = ["properties", "sectionType", "enum"] as const;

export type CompiledSectionAction = "create" | "patch";

export type CompiledSection = {
  // The planner's own order value, preserved exactly — never renumbered, never made contiguous.
  order: number;
  // What the planner called this section, kept for the operator record.
  plannedSectionType: string;
  // The component type it compiles to, which the tenant's own contract declares.
  componentType: string;
  action: CompiledSectionAction;
  // null for a create.
  objectId: string | null;
  // For a patch: the contentRevision the SNAPSHOT saw on this target, which an applier passes back
  // as its expected revision so the write lands only while the object is still where this plan was
  // computed against. null for a create, and for a patch whose target carried no revision.
  targetContentRevision: number | null;
  changeSetId: string;
  // The dispatch that produced the draft this section was compiled from, straight through from the
  // drafting result (#382). This is the whole traceability chain in one field: an operator reading a
  // created section can ask which run wrote it.
  sourceRunId: string | null;
  sourceExecutionId: string | null;
};

export type SiteContentObjectPlan = {
  tenantId: string;
  materializationKey: string;
  page: { objectId: string | null; action: CompiledSectionAction; targetContentRevision: number | null; changeSetId: string };
  sections: CompiledSection[];
  // Page change set first, then one per section in ascending planner order. An applier consumes this
  // order; nothing here applies it.
  changeSets: ChangeSet[];
};

export type CompileSiteContentObjectsResult =
  | { ok: true; plan: SiteContentObjectPlan }
  | { ok: false; blockers: OperationBlocker[] };

// The drafted outcomes this module reads. Deliberately a structural subset of
// SiteContentDraftingResult's own `drafted` outcome rather than an import of it: the compiler needs
// four fields and should not break when the drafting result grows a fifth.
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
  // Fields for the page object itself — pageType, slug, title and whatever else this tenant's page
  // contract requires. Passed through and validated against that contract; never defaulted here.
  pageFields: Record<string, unknown>;
  // Existing section object ids to PATCH, keyed by the planner order they correspond to. An order
  // absent from this map creates a new section.
  sectionTargets?: Record<number, string>;
  // What the caller believes each patch target's contentRevision is. A mismatch against the snapshot
  // is `stale_target` — an approval granted against one revision must not apply to another.
  expectedContentRevisions?: Record<string, number>;
};

export type CompileSiteContentObjectsParams = {
  // The tenant the drafting ran for. Checked against the snapshot: compiling one tenant's drafts
  // against another tenant's contracts is `foreign_tenant_reference`, never a best effort.
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

// The component types this tenant's own section contract declares. Returns null — never a default
// list — when the contract does not carry the enum, so the caller refuses instead of guessing.
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

type SectionCompilation =
  | { ok: true; componentType: string; data: Record<string, unknown> }
  | { ok: false; blocker: OperationBlocker };

// THE ROUTING TABLE. Keyed on the drafting artifact's own discriminator — the field each specialist
// node's outputSchema REQUIRES (siteContentSpecialistNodes.ts), so a draft that reached here always
// carries one. Never keyed on the planner's semantic `sectionType`, which is free text.
//
// Where a richer component exists but needs facts a draft does not carry, the plainer one is chosen
// deliberately and the reason is written down — an offering draft is prose, not `product_preview`,
// because `product_preview` resolves live product objects by id and this module has no product id
// and will not invent one.
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

  // organization_narrative.v1 — an organization narrative is body copy; a person is a bio block.
  const narrativeKind = asString(draft.narrativeKind);
  if (narrativeKind) {
    if (!body) return refuse("draft_body_missing", `Section ${input.order}'s organization narrative carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    if (narrativeKind === "people") {
      if (!title) return refuse("draft_title_missing", `Section ${input.order}'s people profile carries no title, and a bio section's heading has no other source.`, "Re-draft this section; its writer must return a title.");
      // trustNotes is required by the bio contract and is a list of CREDENTIAL lines. An empty list
      // is the honest value when the draft supplied none — inventing a credential is the one thing
      // this module must never do.
      return require("bio", { heading: title, body, trustNotes: [] });
    }
    return require("prose", { body });
  }

  // offering_description.v1 — product/service/program/event. All four are body copy here: the
  // commerce-bound components (`product_preview`, `pricing_table`) resolve `prod_…` objects by id,
  // which a description draft does not carry and this module will not guess.
  if (asString(draft.offeringKind)) {
    if (!body) return refuse("draft_body_missing", `Section ${input.order}'s offering description carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    return require("prose", { body });
  }

  // reference_content.v1 — the discriminator decides the component, and two of the four need
  // structure the draft may not have produced.
  const referenceKind = asString(draft.referenceKind);
  if (referenceKind) {
    const items = Array.isArray(draft.items) ? draft.items.filter(isBag) : [];
    if (referenceKind === "faq") {
      const pairs = items.map((item) => ({ q: asString(item.question), a: asString(item.answer) }));
      // An item missing either half is a MALFORMED draft (reference_content.v1 requires both on
      // every item), not a shorter FAQ. Dropping it would ship a section with fewer questions than
      // the writer produced and nothing anywhere saying which one went missing — the item-level
      // version of the downgrade rule 2 forbids.
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
          `Section ${input.order} is an FAQ, but its draft carries no question/answer items — only prose. An FAQ section renders items, and prose is a different section.`,
          "Re-draft this section so the reference writer returns `items` as question/answer pairs, or re-plan the section as a policy/prose section."
        );
      }
      return require("faq", { ...(title ? { heading: title } : {}), items: pairs.map((pair) => ({ q: pair.q!, a: pair.a! })) });
    }
    if (referenceKind === "process") {
      const steps = items.map((item) => ({ title: asString(item.question), description: asString(item.answer) }));
      // Same rule as the FAQ above: an item the writer produced incompletely is refused, never
      // quietly shortened into a step list missing a stage.
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
          `Section ${input.order} is a process, but its draft carries no ordered items — only prose. A steps section renders ordered items with titles; compiling it as prose instead would publish a different section than the one planned, silently.`,
          "Re-draft this section so the reference writer returns `items` (one per step), or re-plan the section as a policy/prose section."
        );
      }
      return require("steps", { ...(title ? { heading: title } : {}), items: steps.map((step) => ({ title: step.title!, description: step.description! })) });
    }
    // policy and evidence_story are body copy.
    if (!body) return refuse("draft_body_missing", `Section ${input.order}'s ${referenceKind} draft carries no body.`, "Re-draft this section; its writer must return a non-empty body.");
    return require("prose", { body });
  }

  // content_revision.v1 — a revision/localization replaces an existing section's body. It only
  // compiles against a patch target; the create path is refused in compileSiteContentObjects, which
  // is where the target map is known.
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

export function compileSiteContentObjects(params: CompileSiteContentObjectsParams): CompileSiteContentObjectsResult {
  const { projectId, drafted, snapshot, target } = params;
  const blockers: OperationBlocker[] = [];

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
    return {
      ok: false,
      blockers: [blocker("no_drafted_sections", "There are no drafted sections to compile.", "Run site_content.draft_page first, and compile only a result that drafted at least one section.", { projectId })]
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

  const existingSections = snapshot.objects.byType.section ?? [];
  const sectionTargets = target.sectionTargets ?? {};
  const expectedRevisions = target.expectedContentRevisions ?? {};

  // Ascending planner order, whatever those numbers are — 0,1,2 is one valid case, not the shape.
  const ordered = [...drafted].sort((left, right) => left.order - right.order);
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

  const compiled: Array<{
    input: DraftedSectionInput;
    componentType: string;
    candidate: Candidate;
    changeSet: ChangeSet;
    action: CompiledSectionAction;
    objectId: string | null;
    targetContentRevision: number | null;
  }> = [];

  for (const entry of ordered) {
    const targetObjectId = sectionTargets[entry.order] ?? null;
    let existing: SiteContextObject | undefined;
    if (targetObjectId) {
      existing = existingSections.find((object) => object.objectId === targetObjectId);
      if (!existing) {
        blockers.push(
          blocker(
            "patch_target_not_in_snapshot",
            `Section ${entry.order} names patch target "${targetObjectId}", which this snapshot does not contain.`,
            "Re-capture the snapshot, or drop the target so the section is created instead.",
            { order: entry.order, objectId: targetObjectId }
          )
        );
        continue;
      }
      const expected = expectedRevisions[targetObjectId];
      if (expected !== undefined && expected !== existing.contentRevision) {
        blockers.push(
          blocker(
            "stale_target",
            `Section ${entry.order}'s target "${targetObjectId}" is at content revision ${existing.contentRevision}, not the ${expected} this request was prepared against — it changed underneath.`,
            "Re-read the target, re-approve against its current revision, and compile again. An approval granted against one revision does not carry to another.",
            { order: entry.order, objectId: targetObjectId, expectedContentRevision: expected, actualContentRevision: existing.contentRevision }
          )
        );
        continue;
      }
    }

    if (asString(entry.draft.mode) && !targetObjectId) {
      blockers.push(
        blocker(
          "revision_without_target",
          `Section ${entry.order} is a revision/localization, which rewrites an existing section, but no patch target was named for that order.`,
          "Name the existing section's object id in `sectionTargets` for this order, or re-draft the section as new content.",
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

    const candidateResult = compileCandidate({
      snapshot,
      objectType: "section",
      intent: `site_content: ${targetObjectId ? "revise" : "create"} the "${entry.sectionType}" section at order ${entry.order}`,
      fields: { sectionType: section.componentType, data: section.data },
      objectId: targetObjectId
    });
    if (!candidateResult.ok) {
      blockers.push(...candidateResult.blockers);
      continue;
    }

    compiled.push({
      input: entry,
      componentType: section.componentType,
      candidate: candidateResult.candidate,
      changeSet: computeChangeSet({ snapshot, candidate: candidateResult.candidate }),
      action: targetObjectId ? "patch" : "create",
      objectId: targetObjectId,
      targetContentRevision: existing ? existing.contentRevision : null
    });
  }

  // ALL OR NOTHING — see rule 3 in this module's header. One refused section refuses the page.
  if (blockers.length) return { ok: false, blockers };

  // The page's ordered section references. A created section has no id yet, so it is referenced by
  // the position it will occupy; the applier substitutes the minted id. Referencing a "pending" slot
  // is honest — inventing an id for an object that does not exist is the failure this avoids.
  const sectionRefs = compiled.map((item, index) => ({
    order: item.input.order,
    ...(item.objectId ? { section: item.objectId } : { pendingSectionIndex: index })
  }));

  const pageCandidateResult = compileCandidate({
    snapshot,
    objectType: "page",
    intent: target.pageObjectId ? `site_content: revise page "${target.pageObjectId}"` : "site_content: create a page from a drafted plan",
    fields: { ...target.pageFields, sections: sectionRefs },
    objectId: target.pageObjectId
  });
  if (!pageCandidateResult.ok) return { ok: false, blockers: pageCandidateResult.blockers };

  let pageTargetContentRevision: number | null = null;
  if (target.pageObjectId) {
    const existingPage = (snapshot.objects.byType.page ?? []).find((object) => object.objectId === target.pageObjectId);
    // A patch target the snapshot does not contain is refused for the same reason a section's is:
    // compiling it anyway diffs against an empty `before`, so every field reads as an addition and
    // the plan claims to revise a page that may not exist. Same check, same code, both levels.
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
    pageTargetContentRevision = existingPage.contentRevision;
    const expected = expectedRevisions[target.pageObjectId];
    if (expected !== undefined && expected !== existingPage.contentRevision) {
      return {
        ok: false,
        blockers: [
          blocker(
            "stale_target",
            `Page "${target.pageObjectId}" is at content revision ${existingPage.contentRevision}, not the ${expected} this request was prepared against.`,
            "Re-read the page, re-approve against its current revision, and compile again.",
            { objectId: target.pageObjectId, expectedContentRevision: expected, actualContentRevision: existingPage.contentRevision }
          )
        ]
      };
    }
  }

  const pageChangeSet = computeChangeSet({ snapshot, candidate: pageCandidateResult.candidate });

  // See IDEMPOTENCY in the module header: intent only, deliberately not the snapshot digest.
  const materializationKey = contentDigest({
    tenantId: snapshot.tenantId,
    page: { objectId: target.pageObjectId, fields: target.pageFields },
    sections: compiled.map((item) => ({
      order: item.input.order,
      componentType: item.componentType,
      objectId: item.objectId,
      draftDigest: contentDigest(item.input.draft)
    }))
  });

  return {
    ok: true,
    plan: {
      tenantId: snapshot.tenantId,
      materializationKey,
      page: {
        objectId: target.pageObjectId,
        action: target.pageObjectId ? "patch" : "create",
        targetContentRevision: pageTargetContentRevision,
        changeSetId: pageChangeSet.changeSetId
      },
      sections: compiled.map((item) => ({
        order: item.input.order,
        plannedSectionType: item.input.sectionType,
        componentType: item.componentType,
        action: item.action,
        objectId: item.objectId,
        targetContentRevision: item.targetContentRevision,
        changeSetId: item.changeSet.changeSetId,
        sourceRunId: item.input.runId ?? null,
        sourceExecutionId: item.input.executionId ?? null
      })),
      changeSets: [pageChangeSet, ...compiled.map((item) => item.changeSet)]
    }
  };
}
