// P2 v2 acceptance -- the drafted page -> ONE page materialization write step.
//
// The section-type list and page types in these fixtures are the ones the LIVE platform component
// and page_type registries returned on 2026-09-17 (registry_get); the page body_schema's inline
// section shape (`{id, visibility, notes, type, data}`) and the patch op grammar
// (set_page_meta/upsert_section/update_section_data/...) are the ones object_contract(page) and
// object_contract(section) returned LIVE on 2026-09-18. These tests pin the routing, the
// create/patch decision, the chosen op per section, ordering, idempotency and every refusal -- not
// the shape of a component's own `data`.
import { describe, expect, it } from "vitest";

import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import type { SiteContextObject, SiteObjectFieldContract } from "../../../src/agent/operations/siteContext.js";
import { compileSiteContentObjects, PAGE_MATERIALIZATION_SCHEMA_VERSION } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import type { DraftedSectionInput } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import { createInMemorySiteContextSource, DEFAULT_REGISTRIES } from "./fixtures/inMemorySiteContextSource.js";
import type { FixtureTenantData } from "./fixtures/inMemorySiteContextSource.js";

const LIVE_COMPONENT_TYPES = [
  "hero", "prose", "lede", "checklist", "bio", "content_grid", "newsletter_signup", "contact_form",
  "cta_banner", "faq", "link_list", "product_preview", "steps", "composition", "content_split",
  "pricing_table", "media", "brand_row", "stats", "timeline", "comparison_table", "testimonial",
  "search", "content_embed", "form_confirmation", "card", "shared_ref"
];

// The STANDALONE `section` object contract -- used today only for a `shared_ref` target, and by the
// compiler purely as the component-type registry (see the compiler's own header on why the same
// enum backs both). A page's own inline sections never appear under this contract's object list.
const SECTION_CONTRACT: SiteObjectFieldContract = {
  objectType: "section",
  required: ["sectionType", "data"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["sectionType", "data"],
    properties: { sectionType: { type: "string", enum: LIVE_COMPONENT_TYPES }, data: { type: "object", additionalProperties: true } }
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
      pageType: { type: "string", enum: ["home", "standard", "listing", "content_detail", "system", "clone"] },
      slug: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      sections: { type: "array", items: { type: "object", additionalProperties: true } }
    }
  }
};

const TENANT = "kugel-platform";

type InlineSection = { id: string; type: string; data: Record<string, unknown>; visibility?: string };

const pageObject = (objectId: string, sections: InlineSection[] = [], contentRevision = 7): SiteContextObject => ({
  objectId,
  objectType: "page",
  status: "saved",
  version: 9,
  contentRevision,
  publishedTime: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: { pageType: "standard", slug: "about", title: "About", sections }
});

// A standalone `section` object -- the shared_ref case. Present in the snapshot's own object list,
// never inside any page's inline `sections` array in these fixtures (matching what a real capture
// shows today -- see the compiler's own header).
const standaloneSection = (objectId: string): SiteContextObject => ({
  objectId,
  objectType: "section",
  status: "saved",
  version: 2,
  contentRevision: 1,
  publishedTime: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: { sectionType: "newsletter_signup", data: { formName: "footer_signup" } }
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

describe("compileSiteContentObjects — creating a new page (inline sections)", () => {
  it("compiles About + team + values into ONE create write with inline sections, preserving non-contiguous planner orders", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [values(7), organization(1), people(4)],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.schemaVersion).toBe(PAGE_MATERIALIZATION_SCHEMA_VERSION);
    expect(result.plan.write.kind).toBe("create");
    if (result.plan.write.kind !== "create") return;
    // Ascending planner order, and the planner's own numbers -- never renumbered to 0,1,2.
    expect(result.plan.sectionProvenance.map((section) => section.order)).toEqual([1, 4, 7]);
    expect(result.plan.sectionProvenance.map((section) => section.componentType)).toEqual(["prose", "bio", "prose"]);
    expect(result.plan.sectionProvenance.every((section) => section.action === "create")).toBe(true);
    expect(result.plan.page.action).toBe("create");
    // The traceability chain: a compiled section names the dispatch that wrote its draft (#382).
    expect(result.plan.sectionProvenance[0]!.sourceRunId).toBe("run_1");
    expect(result.plan.sectionProvenance[1]!.sourceExecutionId).toBe("exec_4");

    const sections = result.plan.write.fields.sections as InlineSection[];
    expect(sections.map((s) => s.type)).toEqual(["prose", "bio", "prose"]);
    // Every minted id matches Platform's own inline id pattern and lines up with sectionProvenance.
    for (const [index, section] of sections.entries()) {
      expect(section.id).toMatch(/^s_[a-z0-9]+$/);
      expect(section.id).toBe(result.plan.sectionProvenance[index]!.sectionId);
    }
    expect(result.plan.changeSets).toHaveLength(1);
    expect(result.plan.changeSets[0]!.objectType).toBe("page");
  });

  it("mints distinct ids for two byte-identical drafts at different orders", async () => {
    const snapshot = await snapshotOf(fixture());
    const identical = (order: number): DraftedSectionInput => ({ order, sectionType: "about_overview", draft: { narrativeKind: "organization", title: "Same", body: "<p>Same.</p>" } });
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [identical(1), identical(2)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });

    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.write.kind !== "create") return;
    const ids = (result.plan.write.fields.sections as InlineSection[]).map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("replaying the identical request produces the identical materializationKey and the identical minted section ids", async () => {
    const snapshot = await snapshotOf(fixture());
    const request = { projectId: TENANT, drafted: [organization(1), people(4)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } };

    const first = compileSiteContentObjects(request);
    const second = compileSiteContentObjects(request);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok || first.plan.write.kind !== "create" || second.plan.write.kind !== "create") return;
    expect(second.plan.materializationKey).toBe(first.plan.materializationKey);
    expect((second.plan.write.fields.sections as InlineSection[]).map((s) => s.id)).toEqual((first.plan.write.fields.sections as InlineSection[]).map((s) => s.id));
  });

  it("a different draft is a different materialization -- the key is not a constant", async () => {
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
    expect(result.plan.sectionProvenance[0]!.componentType).toBe("prose");
  });

  it("compiles a process draft into steps when the draft has ordered items", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [
        {
          order: 2,
          sectionType: "how_it_works",
          draft: { referenceKind: "process", title: "Submitting a film", body: "<p>Three stages.</p>", items: [{ question: "Prepare the reel", answer: "Clean and inspect." }, { question: "Ship it", answer: "Use the archive courier." }], groundedIn: ["src"] }
        }
      ],
      snapshot,
      target: { pageObjectId: null, pageFields: { ...PAGE_FIELDS, slug: "docs", title: "Documentation" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sectionProvenance[0]!.componentType).toBe("steps");
  });

  it("compiles an FAQ draft into a faq section, carrying its question/answer pairs", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "questions", draft: { referenceKind: "faq", title: "Common questions", body: "<p>…</p>", items: [{ question: "Do you accept 16mm?", answer: "Yes." }], groundedIn: ["src"] } }],
      snapshot,
      target: { pageObjectId: null, pageFields: { ...PAGE_FIELDS, slug: "faq", title: "FAQ" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.write.kind !== "create") return;
    expect(result.plan.sectionProvenance[0]!.componentType).toBe("faq");
    const data = (result.plan.write.fields.sections as InlineSection[])[0]!.data as { items: unknown[] };
    expect(data.items).toEqual([{ q: "Do you accept 16mm?", a: "Yes." }]);
  });
});

describe("compileSiteContentObjects — patching an existing page (mixed ops)", () => {
  it("builds set_page_meta + upsert_section + update_section_data in one ops array", async () => {
    const existingBio: InlineSection = { id: "s_existingteam", type: "bio", data: { heading: "The team", body: "<p>Three archivists.</p>", trustNotes: [] } };
    const page = pageObject("page_about", [existingBio]);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [page] } }));

    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [people(4), values(9)],
      snapshot,
      target: { pageObjectId: "page_about", pageFields: { ...PAGE_FIELDS, title: "About Us" }, sectionTargets: { 4: "s_existingteam" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.write.kind !== "patch") return;
    expect(result.plan.page.action).toBe("patch");
    const ops = result.plan.write.ops;
    expect(ops[0]).toMatchObject({ op: "set_page_meta", fields: { title: "About Us" } });
    // The revised team bio: same componentType, only data changed -> a merge op naming just the id.
    const teamOp = ops.find((op) => op.op === "update_section_data");
    expect(teamOp).toMatchObject({ op: "update_section_data", sectionId: "s_existingteam" });
    // The new "values" section: no target named -> upsert_section, appended after the one existing
    // inline section.
    const newOp = ops.find((op) => op.op === "upsert_section");
    expect(newOp).toMatchObject({ op: "upsert_section", position: 1 });
    expect(result.plan.sectionProvenance.find((s) => s.order === 4)!.action).toBe("update");
    expect(result.plan.sectionProvenance.find((s) => s.order === 9)!.action).toBe("create");
  });

  it("uses upsert_section (a full replace), not update_section_data, when the component type itself changes", async () => {
    const existingProse: InlineSection = { id: "s_existingvalues", type: "prose", data: { body: "<p>old</p>" } };
    const page = pageObject("page_about", [existingProse]);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [page] } }));

    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [people(0)],
      snapshot,
      target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, sectionTargets: { 0: "s_existingvalues" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.write.kind !== "patch") return;
    expect(result.plan.write.ops).toEqual([{ op: "upsert_section", section: { id: "s_existingvalues", type: "bio", data: { heading: "The team", body: "<p>Four archivists.</p>", trustNotes: [] } } }]);
  });

  it("marks a section unchanged and emits no op for it when the revised data is identical", async () => {
    const existingBio: InlineSection = { id: "s_team", type: "bio", data: { heading: "The team", body: "<p>Four archivists.</p>", trustNotes: [] } };
    const page = pageObject("page_about", [existingBio]);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [page] } }));

    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [people(4), organization(0)],
      snapshot,
      target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, sectionTargets: { 4: "s_team" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.write.kind !== "patch") return;
    expect(result.plan.sectionProvenance.find((s) => s.order === 4)!.action).toBe("unchanged");
    // Only the new section's upsert -- nothing for the unchanged one.
    expect(result.plan.write.ops.filter((op) => op.op !== "set_page_meta")).toHaveLength(1);
  });

  it("refuses with no_effective_changes when nothing about the page or its named sections actually moved", async () => {
    const existingBio: InlineSection = { id: "s_team", type: "bio", data: { heading: "The team", body: "<p>Four archivists.</p>", trustNotes: [] } };
    const page = pageObject("page_about", [existingBio]);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [page] } }));

    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [people(4)], snapshot, target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, sectionTargets: { 4: "s_team" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("no_effective_changes");
  });
});

describe("compileSiteContentObjects — the shared/standalone section refusal", () => {
  it("refuses a patch target that is a standalone `section` object rather than one of the page's own inline sections", async () => {
    const page = pageObject("page_about", []);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [standaloneSection("sec_shared_1")], page: [page] } }));

    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [people(0)], snapshot, target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, sectionTargets: { 0: "sec_shared_1" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("unsupported_shared_section_mutation");
  });

  it("refuses a patch target that is an inline shared_ref pointer, even though it appears in the page's own sections array", async () => {
    const sharedRefEntry: InlineSection = { id: "s_ref1", type: "shared_ref", data: { target: "sec_shared_1" } };
    const page = pageObject("page_about", [sharedRefEntry]);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [standaloneSection("sec_shared_1")], page: [page] } }));

    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [people(0)], snapshot, target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, sectionTargets: { 0: "s_ref1" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("unsupported_shared_section_mutation");
  });
});

describe("compileSiteContentObjects — what it refuses", () => {
  it("refuses a stale page patch target rather than applying an approval to a changed page", async () => {
    const page = pageObject("page_about", [], 9);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [page] } }));
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [organization(0)],
      snapshot,
      target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, expectedPageContentRevision: 3 }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("stale_target");
    expect(result.blockers[0]!.evidence).toMatchObject({ expectedContentRevision: 3, actualContentRevision: 9 });
  });

  it("refuses target.pageFields carrying its own \"sections\" key", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [organization(0)], snapshot, target: { pageObjectId: null, pageFields: { ...PAGE_FIELDS, sections: [] } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("page_fields_must_not_include_sections");
  });

  it("refuses a section target named with no page being patched", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [people(0)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS, sectionTargets: { 0: "s_x" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("section_target_without_page");
  });

  it("refuses a process section whose draft produced prose instead of steps -- never a silent downgrade", async () => {
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

  it("refuses an FAQ item missing its answer -- one incomplete item is a malformed draft, not one fewer question", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "questions", draft: { referenceKind: "faq", title: "Q", body: "<p>…</p>", items: [{ question: "Do you accept 16mm?", answer: "Yes." }, { question: "And 35mm?" }], groundedIn: ["s"] } }],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("faq_item_incomplete");
    expect(result.blockers[0]!.message).toContain("item 1");
  });

  it("refuses a process item missing its description rather than shipping a step list with a gap", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "how_it_works", draft: { referenceKind: "process", title: "Submitting", body: "<p>…</p>", items: [{ question: "Prepare the reel", answer: "Clean it." }, { question: "Ship it" }], groundedIn: ["s"] } }],
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
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [organization(0)], snapshot, target: { pageObjectId: "page_abuot", pageFields: PAGE_FIELDS } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("patch_target_not_in_snapshot");
    expect(result.blockers[0]!.evidence).toMatchObject({ objectType: "page" });
  });

  it("refuses a section patch target that is not among the page's own inline sections", async () => {
    const page = pageObject("page_about", []);
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [page] } }));
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [people(0)], snapshot, target: { pageObjectId: "page_about", pageFields: PAGE_FIELDS, sectionTargets: { 0: "s_nope" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]!.code).toBe("patch_target_not_in_snapshot");
  });

  it("refuses a component type this tenant's own contract does not declare", async () => {
    const narrowed: SiteObjectFieldContract = { ...SECTION_CONTRACT, schema: { ...SECTION_CONTRACT.schema, properties: { sectionType: { type: "string", enum: ["prose", "hero"] }, data: { type: "object", additionalProperties: true } } } };
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

  it("refuses the whole page when one section refuses -- never a half-built page", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [organization(1), { order: 2, sectionType: "questions", draft: { referenceKind: "faq", title: "Q", body: "<p>…</p>", groundedIn: ["s"] } }, people(3)],
      snapshot,
      target: { pageObjectId: null, pageFields: PAGE_FIELDS }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((entry) => entry.code)).toEqual(["faq_items_missing"]);
  });

  it("refuses a draft carrying no discriminator this compiler routes on", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({ projectId: TENANT, drafted: [{ order: 0, sectionType: "mystery", draft: { title: "T", body: "<p>b</p>" } }], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });

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
