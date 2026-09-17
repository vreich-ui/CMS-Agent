// P2 acceptance — the drafted page -> candidate site objects step.
//
// The section-type list and page types in these fixtures are the ones the LIVE platform component
// and page_type registries returned on 2026-09-17 (registry_get), not invented names. The per-field
// `data` schema of each component is a second registry this compiler does not validate against
// (see the compiler's header); the fixture's `data` is therefore permissive, and these tests pin
// the routing, the create/patch decision, ordering, idempotency and every refusal — not the shape
// of a component's data.
import { describe, expect, it } from "vitest";

import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import type { SiteContextObject, SiteObjectFieldContract } from "../../../src/agent/operations/siteContext.js";
import { compileSiteContentObjects } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import type { DraftedSectionInput } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import { createInMemorySiteContextSource, DEFAULT_REGISTRIES } from "./fixtures/inMemorySiteContextSource.js";
import type { FixtureTenantData } from "./fixtures/inMemorySiteContextSource.js";

// Verbatim from the live component registry, 2026-09-17.
const LIVE_COMPONENT_TYPES = [
  "hero", "prose", "lede", "checklist", "bio", "content_grid", "newsletter_signup", "contact_form",
  "cta_banner", "faq", "link_list", "product_preview", "steps", "composition", "content_split",
  "pricing_table", "media", "brand_row", "stats", "timeline", "comparison_table", "testimonial",
  "search", "content_embed", "form_confirmation", "card", "shared_ref"
];

const SECTION_CONTRACT: SiteObjectFieldContract = {
  objectType: "section",
  required: ["sectionType", "data"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["sectionType", "data"],
    properties: {
      sectionType: { type: "string", enum: LIVE_COMPONENT_TYPES },
      data: { type: "object", additionalProperties: true }
    }
  }
};

const PAGE_CONTRACT: SiteObjectFieldContract = {
  objectType: "page",
  required: ["pageType", "slug", "title", "sections"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["pageType", "slug", "title", "sections"],
    properties: {
      // Live page_type registry, 2026-09-17.
      pageType: { type: "string", enum: ["home", "standard", "listing", "content_detail", "system", "clone"] },
      slug: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      sections: { type: "array", items: { type: "object", additionalProperties: true } }
    }
  }
};

const TENANT = "kugel-platform";

const sectionObject = (objectId: string, sectionType: string, data: Record<string, unknown>, contentRevision = 3): SiteContextObject => ({
  objectId,
  objectType: "section",
  status: "saved",
  version: 5,
  contentRevision,
  publishedTime: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: { sectionType, data }
});

const pageObject = (objectId: string, contentRevision = 7): SiteContextObject => ({
  objectId,
  objectType: "page",
  status: "saved",
  version: 9,
  contentRevision,
  publishedTime: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: { pageType: "standard", slug: "about", title: "About", sections: [] }
});

const fixture = (overrides: Partial<FixtureTenantData> = {}): FixtureTenantData => ({
  tenantId: TENANT,
  revisionId: "rev_2026_09_17_01",
  objectsByType: { section: [], page: [] },
  contractsByType: { section: SECTION_CONTRACT, page: PAGE_CONTRACT },
  registries: DEFAULT_REGISTRIES,
  ...overrides
});

const snapshotOf = async (data: FixtureTenantData) => {
  const { source } = createInMemorySiteContextSource(data);
  return captureSiteSnapshot(source, { tenantId: data.tenantId, objectTypes: ["page", "section"] });
};

const PAGE_FIELDS = { pageType: "standard", slug: "about", title: "About" };

const organization = (order: number): DraftedSectionInput => ({
  order,
  sectionType: "about_overview",
  draft: { narrativeKind: "organization", title: "Who we are", body: "<p>Founded to restore films.</p>", groundedIn: ["src_1"] },
  runId: `run_${order}`,
  executionId: `exec_${order}`
});

const people = (order: number): DraftedSectionInput => ({
  order,
  sectionType: "our_team",
  draft: { narrativeKind: "people", title: "The team", body: "<p>Four archivists.</p>", groundedIn: ["src_2"] },
  runId: `run_${order}`,
  executionId: `exec_${order}`
});

const values = (order: number): DraftedSectionInput => ({
  order,
  sectionType: "our_values",
  draft: { referenceKind: "policy", title: "What we stand for", body: "<p>Preservation before profit.</p>", groundedIn: ["src_3"] }
});

describe("compileSiteContentObjects — the drafted page becomes candidate objects", () => {
  it("compiles About + team + values onto a new page, preserving non-contiguous planner orders", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [values(7), organization(1), people(4)],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Ascending planner order, and the planner's own numbers — never renumbered to 0,1,2.
    expect(result.plan.sections.map((section) => section.order)).toEqual([1, 4, 7]);
    expect(result.plan.sections.map((section) => section.componentType)).toEqual(["prose", "bio", "prose"]);
    expect(result.plan.sections.every((section) => section.action === "create")).toBe(true);
    expect(result.plan.page.action).toBe("create");
    // The traceability chain: a compiled section names the dispatch that wrote its draft (#382).
    expect(result.plan.sections[0]!.sourceRunId).toBe("run_1");
    expect(result.plan.sections[1]!.sourceExecutionId).toBe("exec_4");
    // Page change set first, then one per section.
    expect(result.plan.changeSets).toHaveLength(4);
    expect(result.plan.changeSets[0]!.objectType).toBe("page");
  });

  it("patches a people section in place when its order names an existing target, and creates the rest", async () => {
    const snapshot = await snapshotOf(
      fixture({ objectsByType: { section: [sectionObject("sec_team", "bio", { heading: "The team", body: "<p>Three archivists.</p>", trustNotes: [] })], page: [pageObject("page_about")] } })
    );
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [people(4)],
      snapshot,
      target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, sectionTargets: { 4: "sec_team" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sections[0]).toMatchObject({ action: "patch", objectId: "sec_team", componentType: "bio" });
    expect(result.plan.page.action).toBe("patch");
    // A patch diffs against the object's real current fields, so only the body moved.
    const sectionChangeSet = result.plan.changeSets.find((changeSet) => changeSet.objectId === "sec_team")!;
    expect(sectionChangeSet.diffs.map((diff) => diff.field)).toEqual(["data"]);
  });

  it("compiles a product/service description as prose rather than inventing a product id", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "offering", draft: { offeringKind: "service", title: "Restoration", body: "<p>Frame by frame.</p>", groundedIn: ["src"] } }],
      snapshot,
      target: { pageObjectId: null, pageFields: { ...PAGE_FIELDS, slug: "services", title: "Services" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sections[0]!.componentType).toBe("prose");
  });

  it("compiles a documentation/process page into steps when the draft has ordered items", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [
        {
          order: 2,
          sectionType: "how_it_works",
          draft: {
            referenceKind: "process",
            title: "Submitting a film",
            body: "<p>Three stages.</p>",
            items: [{ question: "Prepare the reel", answer: "Clean and inspect." }, { question: "Ship it", answer: "Use the archive courier." }],
            groundedIn: ["src"]
          }
        }
      ],
      snapshot,
      target: { pageObjectId: null, pageFields: { ...PAGE_FIELDS, slug: "docs", title: "Documentation" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sections[0]!.componentType).toBe("steps");
  });

  it("compiles an FAQ draft into a faq section, carrying its question/answer pairs", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [
        {
          order: 0,
          sectionType: "questions",
          draft: { referenceKind: "faq", title: "Common questions", body: "<p>…</p>", items: [{ question: "Do you accept 16mm?", answer: "Yes." }], groundedIn: ["src"] }
        }
      ],
      snapshot,
      target: { pageObjectId: null, pageFields: { ...PAGE_FIELDS, slug: "faq", title: "FAQ" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sections[0]!.componentType).toBe("faq");
    const changeSet = result.plan.changeSets.find((entry) => entry.objectType === "section")!;
    const data = changeSet.diffs.find((diff) => diff.field === "data")!.after as { items: unknown[] };
    expect(data.items).toEqual([{ q: "Do you accept 16mm?", a: "Yes." }]);
  });

  it("replaying the same request produces the identical materialization key and change set ids", async () => {
    const snapshot = await snapshotOf(fixture());
    const request = { projectId: TENANT, drafted: [organization(1), people(4)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } };

    const first = compileSiteContentObjects(request);
    const second = compileSiteContentObjects(request);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.plan.materializationKey).toBe(first.plan.materializationKey);
    expect(second.plan.changeSets.map((changeSet) => changeSet.changeSetId)).toEqual(first.plan.changeSets.map((changeSet) => changeSet.changeSetId));
  });

  it("a different draft is a different materialization — the key is not a constant", async () => {
    const snapshot = await snapshotOf(fixture());
    const base = compileSiteContentObjects({ projectId: TENANT, drafted: [organization(1)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });
    const edited = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ ...organization(1), draft: { ...organization(1).draft, body: "<p>Founded in 1974 to restore films.</p>" } }],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(base.ok && edited.ok).toBe(true);
    if (!base.ok || !edited.ok) return;
    expect(edited.plan.materializationKey).not.toBe(base.plan.materializationKey);
  });
});

describe("compileSiteContentObjects — what it refuses", () => {
  it("refuses a stale patch target rather than applying an approval to a changed object", async () => {
    const snapshot = await snapshotOf(
      fixture({ objectsByType: { section: [sectionObject("sec_team", "bio", { heading: "The team", body: "<p>x</p>", trustNotes: [] }, 9)], page: [] } })
    );
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [people(4)],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS, sectionTargets: { 4: "sec_team" }, expectedContentRevisions: { sec_team: 3 } }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("stale_target");
    expect(result.blockers[0]!.evidence).toMatchObject({ expectedContentRevision: 3, actualContentRevision: 9 });
  });

  it("refuses a process section whose draft produced prose instead of steps — never a silent downgrade", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "how_it_works", draft: { referenceKind: "process", title: "Submitting", body: "<p>Three stages, in a paragraph.</p>", groundedIn: ["src"] } }],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("process_steps_missing");
    expect(result.blockers[0]!.remedy).toContain("re-plan");
  });

  it("refuses an FAQ with no items", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "questions", draft: { referenceKind: "faq", title: "Questions", body: "<p>…</p>", groundedIn: ["src"] } }],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("faq_items_missing");
  });

  it("refuses an FAQ item missing its answer — one incomplete item is a malformed draft, not one fewer question", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [
        {
          order: 0,
          sectionType: "questions",
          draft: { referenceKind: "faq", title: "Q", body: "<p>…</p>", items: [{ question: "Do you accept 16mm?", answer: "Yes." }, { question: "And 35mm?" }], groundedIn: ["s"] }
        }
      ],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("faq_item_incomplete");
    // Names WHICH item, so a re-draft does not have to search for it.
    expect(result.blockers[0]!.message).toContain("item 1");
  });

  it("refuses a process item missing its description rather than shipping a step list with a gap", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [
        {
          order: 0,
          sectionType: "how_it_works",
          draft: { referenceKind: "process", title: "Submitting", body: "<p>…</p>", items: [{ question: "Prepare the reel", answer: "Clean it." }, { question: "Ship it" }], groundedIn: ["s"] }
        }
      ],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("process_step_incomplete");
    expect(result.blockers[0]!.message).toContain("item 1");
  });

  it("refuses a page patch target the snapshot does not contain, rather than diffing against nothing", async () => {
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [pageObject("page_about")] } }));
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [organization(0)],
      snapshot,
      target: { pageObjectId: "page_abuot", pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("patch_target_not_in_snapshot");
    expect(result.blockers[0]!.evidence).toMatchObject({ objectType: "page" });
  });

  it("refuses a component type this tenant's own contract does not declare", async () => {
    const narrowed: SiteObjectFieldContract = {
      ...SECTION_CONTRACT,
      schema: { ...SECTION_CONTRACT.schema, properties: { sectionType: { type: "string", enum: ["prose", "hero"] }, data: { type: "object", additionalProperties: true } } }
    };
    const snapshot = await snapshotOf(fixture({ contractsByType: { section: narrowed, page: PAGE_CONTRACT } }));
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [people(0)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("unsupported_section_type");
    expect(result.blockers[0]!.message).toContain("bio");
  });

  it("refuses to compile at all when the snapshot carries no section contract", async () => {
    const snapshot = await snapshotOf(fixture({ contractsByType: { page: PAGE_CONTRACT } }));
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [organization(0)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("section_type_registry_unavailable");
  });

  it("refuses drafts produced for another tenant", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({ projectId: "zilberman-ff", drafted: [organization(0)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("foreign_tenant_reference");
  });

  it("refuses a revision with no section to revise", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "about_overview", draft: { mode: "revise", revisedBody: "<p>Tighter.</p>", changesSummary: ["shortened"] } }],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("revision_without_target");
  });

  it("refuses the whole page when one section refuses — never a half-built page", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [organization(1), { order: 2, sectionType: "questions", draft: { referenceKind: "faq", title: "Q", body: "<p>…</p>", groundedIn: ["s"] } }, people(3)],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Two sections compiled perfectly well; nothing is offered for them.
    expect(result.blockers.map((entry) => entry.code)).toEqual(["faq_items_missing"]);
  });

  it("refuses a draft carrying no discriminator this compiler routes on", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "mystery", draft: { title: "T", body: "<p>b</p>" } }],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("unrecognized_draft_artifact");
  });

  it("refuses two sections claiming the same position", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [organization(2), people(2)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.some((entry) => entry.code === "duplicate_section_order")).toBe(true);
  });

  it("refuses a page whose own contract is not satisfied, naming the field", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [organization(0)], snapshot, target: { pageObjectId: null, pageFields: { pageType: "standard" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.blockers)).toContain("slug");
  });
});
