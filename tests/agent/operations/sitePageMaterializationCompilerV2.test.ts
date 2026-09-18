// C1 acceptance — the v2 page compiler: drafted units -> ONE inline page body, or named blockers.
//
// Fixtures below are built to match the REAL Platform page dialect this repo's own capture/clone
// tests exercise against the live object wire (not a compiler's own invented shape) — see
// sitePageMaterializationCompilerV2.ts's module header for the exact call sites this was checked
// against: tests/agent/capture/{cloneAdjudicationWiring,cloneLockLeakAudit,cloneEngineRefusals,
// cloneRestampLockRetry,determinismHarness,gapReplayHarness,emitMediaResumption}.test.ts. `seo` is
// carried on this task's own stated authority, not independently re-derived from one of those call
// sites — see that same header comment.
import { describe, expect, it } from "vitest";

import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import type { SiteObjectFieldContract } from "../../../src/agent/operations/siteContext.js";
import {
  compilePagePlanV2,
  isSitePageMaterializationV2Plan,
  assertSitePageMaterializationV2Plan,
  assertNotSitePageMaterializationV2Plan,
  SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION
} from "../../../src/agent/operations/sitePageMaterializationCompilerV2.js";
import type { DraftedPageUnitV2 } from "../../../src/agent/operations/sitePageMaterializationCompilerV2.js";
import { compileSiteContentObjects } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import { applySiteContentPlan } from "../../../src/agent/operations/siteContentObjectApplier.js";
import { createInMemorySiteContextSource, DEFAULT_REGISTRIES } from "./fixtures/inMemorySiteContextSource.js";
import type { FixtureTenantData } from "./fixtures/inMemorySiteContextSource.js";
import { LIVE_PAGE_TYPES, LIVE_SECTION_REGISTRY } from "./fixtures/liveObjectContractCapture.js";

const TENANT = "kugel-platform";

// Live component registry, 2026-09-17 — same pin as siteContentObjectCompiler.test.ts. Deliberately
// excludes "before_after" (not yet registered for this tenant at that capture) and includes "card"
// (registered, but never placeable as a standalone page section — see PAGE_LEVEL_DISALLOWED_TYPES).
const LIVE_COMPONENT_TYPES = [
  "hero", "prose", "lede", "checklist", "bio", "content_grid", "newsletter_signup", "contact_form",
  "cta_banner", "faq", "link_list", "product_preview", "steps", "composition", "content_split",
  "pricing_table", "media", "brand_row", "stats", "timeline", "comparison_table", "testimonial",
  "search", "content_embed", "form_confirmation", "card", "shared_ref"
];

const sectionContract = (types: readonly string[]): SiteObjectFieldContract => ({
  objectType: "section",
  required: ["sectionType", "data"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["sectionType", "data"],
    properties: { sectionType: { type: "string", enum: types }, data: { type: "object", additionalProperties: true } }
  }
});

// The real inline page dialect — route/pageType/title/sections={id,type,data}, source-verified
// against this repo's own capture/clone tests (module header). `seo` is optional and permissive.
const PAGE_CONTRACT_V2: SiteObjectFieldContract = {
  objectType: "page",
  required: ["route", "pageType", "title", "sections"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["route", "pageType", "title", "sections"],
    properties: {
      route: { type: "string", minLength: 1 },
      pageType: { type: "string", enum: ["home", "standard", "listing", "content_detail", "system", "clone"] },
      title: { type: "string", minLength: 1 },
      seo: { type: "object", additionalProperties: true },
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "type", "data"],
          properties: { id: { type: "string", minLength: 1 }, type: { type: "string" }, data: { type: "object", additionalProperties: true } }
        }
      }
    }
  }
};

const fixture = (overrides: Partial<FixtureTenantData> = {}): FixtureTenantData => ({
  tenantId: TENANT,
  revisionId: "rev_2026_09_17_01",
  objectsByType: { page: [] },
  contractsByType: { section: sectionContract(LIVE_COMPONENT_TYPES), page: PAGE_CONTRACT_V2 },
  registries: DEFAULT_REGISTRIES,
  ...overrides
});

const snapshotOf = async (data: FixtureTenantData) => {
  const { source } = createInMemorySiteContextSource(data);
  return captureSiteSnapshot(source, { tenantId: data.tenantId, objectTypes: ["page", "section"] });
};

const PAGE_FIELDS = { route: "/about", pageType: "standard", title: "About", seo: { description: "Who we are." } };

const organization = (unitKey: string, order: number, body = "<p>Founded to restore films.</p>"): DraftedPageUnitV2 => ({
  unitKey,
  order,
  sectionType: "about_overview",
  draft: { narrativeKind: "organization", title: "Who we are", body },
  runId: `run_${unitKey}`,
  executionId: `exec_${unitKey}`
});

const people = (unitKey: string, order: number): DraftedPageUnitV2 => ({
  unitKey,
  order,
  sectionType: "our_team",
  draft: { narrativeKind: "people", title: "The team", body: "<p>Four archivists.</p>" }
});

const faq = (unitKey: string, order: number, items: Array<Record<string, unknown>>): DraftedPageUnitV2 => ({
  unitKey,
  order,
  sectionType: "faqs",
  draft: { referenceKind: "faq", title: "Questions", items }
});

const process_ = (unitKey: string, order: number, items: Array<Record<string, unknown>>): DraftedPageUnitV2 => ({
  unitKey,
  order,
  sectionType: "how_it_works",
  draft: { referenceKind: "process", title: "How it works", items }
});

const comparison = (unitKey: string, order: number, items: Array<Record<string, unknown>>): DraftedPageUnitV2 => ({
  unitKey,
  order,
  sectionType: "before_after_gallery",
  draft: { referenceKind: "comparison", title: "See the difference", items }
});

const cardUnit = (unitKey: string, order: number): DraftedPageUnitV2 => ({
  unitKey,
  order,
  sectionType: "featured_card",
  draft: { narrativeKind: "spotlight", title: "Featured", body: "<p>x</p>" }
});

const compileOf = async (
  units: DraftedPageUnitV2[],
  sectionIds: Record<string, string>,
  overrides: Partial<FixtureTenantData> = {},
  pageFields: Record<string, unknown> = PAGE_FIELDS
) => {
  const snapshot = await snapshotOf(fixture(overrides));
  return compilePagePlanV2({ projectId: TENANT, units, snapshot, target: { mode: "create", pageFields }, sectionIds });
};

describe("compilePagePlanV2 — one inline page body, or named blockers", () => {
  it("compiles multiple specialists' sections into ONE page create effect with inline {id,type,data} sections", async () => {
    const result = await compileOf(
      [organization("org", 5), people("team", 1), faq("faq", 3, [{ question: "Q1", answer: "A1" }])],
      { org: "sec_org", team: "sec_team", faq: "sec_faq" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.schemaVersion).toBe(SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION);
    expect(result.plan.page.action).toBe("create");
    // Exactly one change set for the whole page — never one per section.
    expect(result.plan.changeSet.objectType).toBe("page");
    expect(result.plan.changeSet.objectId).toBeNull();
    // Ascending planner order, ids preserved, never renumbered.
    expect(result.plan.units.map((u) => u.unitKey)).toEqual(["team", "faq", "org"]);
    expect(result.plan.units.map((u) => u.sectionId)).toEqual(["sec_team", "sec_faq", "sec_org"]);
    const sectionsDiff = result.plan.changeSet.diffs.find((d) => d.field === "sections");
    expect(sectionsDiff).toBeDefined();
    const sections = sectionsDiff!.after as Array<{ id: string; type: string; data: unknown }>;
    // Inline {id,type,data} — never {order,section} or {order,pendingSectionIndex}.
    expect(sections).toEqual([
      { id: "sec_team", type: "bio", data: { heading: "The team", body: "<p>Four archivists.</p>", trustNotes: [] } },
      { id: "sec_faq", type: "faq", data: { heading: "Questions", items: [{ q: "Q1", a: "A1" }] } },
      { id: "sec_org", type: "prose", data: { body: "<p>Founded to restore films.</p>" } }
    ]);
    for (const s of sections) {
      expect(s).not.toHaveProperty("order");
      expect(s).not.toHaveProperty("pendingSectionIndex");
    }
  });

  it("refuses a malformed FAQ item by name, never silently dropping it", async () => {
    const result = await compileOf([faq("faq", 0, [{ question: "Q1", answer: "A1" }, { question: "Q2" }])], { faq: "sec_faq" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["faq_item_incomplete"]);
    expect(result.blockers[0]!.message).toMatch(/item 1/);
  });

  it("refuses a malformed process item by name, never silently dropping it", async () => {
    const result = await compileOf([process_("steps", 0, [{ question: "Step 1", answer: "Do this" }, { question: "Step 2" }])], { steps: "sec_steps" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["process_step_incomplete"]);
  });

  it("refuses an empty FAQ items list rather than downgrading to prose", async () => {
    const result = await compileOf([faq("faq", 0, [])], { faq: "sec_faq" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["faq_items_missing"]);
  });

  it("never places `card` as a standalone page section, even though the tenant declares it supported", async () => {
    const result = await compileOf([cardUnit("card1", 0)], { card1: "sec_card1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["unplaceable_standalone_section"]);
  });

  it("refuses `before_after` when the captured target capability does not declare it", async () => {
    const result = await compileOf([comparison("cmp", 0, [{ before: "Cluttered", after: "Clean" }])], { cmp: "sec_cmp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["unsupported_section_type"]);
  });

  it("accepts `before_after` once the captured target capability declares it", async () => {
    const result = await compileOf(
      [comparison("cmp", 0, [{ before: "Cluttered", after: "Clean" }])],
      { cmp: "sec_cmp" },
      { contractsByType: { section: sectionContract([...LIVE_COMPONENT_TYPES, "before_after"]), page: PAGE_CONTRACT_V2 } }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.units[0]!.componentType).toBe("before_after");
  });

  it("refuses a malformed comparison item by name rather than dropping it", async () => {
    const result = await compileOf(
      [comparison("cmp", 0, [{ before: "Cluttered" }])],
      { cmp: "sec_cmp" },
      { contractsByType: { section: sectionContract([...LIVE_COMPONENT_TYPES, "before_after"]), page: PAGE_CONTRACT_V2 } }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["comparison_item_incomplete"]);
  });

  it("never mints an id: a unit with no preallocated sectionId is refused by name", async () => {
    const result = await compileOf([organization("org", 0)], {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["section_identity_not_preallocated"]);
  });

  it("refuses two units sharing one preallocated section id — two intended units, one identity", async () => {
    const result = await compileOf([organization("a", 0), people("b", 1)], { a: "sec_1", b: "sec_1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["duplicate_preallocated_section_id"]);
  });

  it("is deterministic: identical inputs and ids produce the identical materializationKey and changeSetId", async () => {
    const units = [organization("org", 0), people("team", 1)];
    const ids = { org: "sec_org", team: "sec_team" };
    const first = await compileOf(units, ids);
    const second = await compileOf(units, ids);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.plan.materializationKey).toBe(first.plan.materializationKey);
    expect(second.plan.changeSet.changeSetId).toBe(first.plan.changeSet.changeSetId);
  });

  it("keeps two units with byte-identical drafted content distinct, each with its own preallocated id", async () => {
    const result = await compileOf(
      [organization("a", 0, "<p>Same body.</p>"), organization("b", 1, "<p>Same body.</p>")],
      { a: "sec_a", b: "sec_b" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.units).toHaveLength(2);
    expect(result.plan.units.map((u) => u.sectionId)).toEqual(["sec_a", "sec_b"]);
    // Two distinct intended units, not one deduplicated by coincidence of content.
    expect(result.plan.units[0]!.unitKey).not.toBe(result.plan.units[1]!.unitKey);
  });

  it("keeps each unit's originally assigned id when the drafts are reordered", async () => {
    const ids = { a: "sec_a", b: "sec_b" };
    const before = await compileOf([organization("a", 0), people("b", 1)], ids);
    const after = await compileOf([organization("a", 1), people("b", 0)], ids);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    // Same ids, same unitKeys, only their position in the page's own sections array moved.
    expect(before.plan.units.map((u) => [u.unitKey, u.sectionId])).toEqual([["a", "sec_a"], ["b", "sec_b"]]);
    expect(after.plan.units.map((u) => [u.unitKey, u.sectionId])).toEqual([["b", "sec_b"], ["a", "sec_a"]]);
    // The reordered page is genuinely different CONTENT (its sections render in a different
    // sequence), so it must get its own distinct materializationKey/changeSetId — a reorder must
    // never dedupe onto the pre-reorder apply as though nothing changed.
    expect(after.plan.materializationKey).not.toBe(before.plan.materializationKey);
    expect(after.plan.changeSet.changeSetId).not.toBe(before.plan.changeSet.changeSetId);
  });

  it("refuses an unlabelled content revision rather than assuming it is safe rich text", async () => {
    const unit: DraftedPageUnitV2 = { unitKey: "rev", order: 0, sectionType: "revised_prose", draft: { mode: "revise", revisedBody: "<p>New copy.</p>" } };
    const result = await compileOf([unit], { rev: "sec_rev" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["content_revision_format_unconfirmed"]);
  });

  it("accepts a content revision once it explicitly declares bodyFormat richText", async () => {
    const unit: DraftedPageUnitV2 = { unitKey: "rev", order: 0, sectionType: "revised_prose", draft: { mode: "revise", revisedBody: "<p>New copy.</p>", bodyFormat: "richText" } };
    const result = await compileOf([unit], { rev: "sec_rev" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.units[0]!.componentType).toBe("prose");
  });

  it("refuses a localize revision with no explicit targetLocale destination", async () => {
    const unit: DraftedPageUnitV2 = { unitKey: "loc", order: 0, sectionType: "localized_prose", draft: { mode: "localize", revisedBody: "<p>Copia nueva.</p>", bodyFormat: "richText" } };
    const result = await compileOf([unit], { loc: "sec_loc" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["localization_destination_missing"]);
  });

  it("accepts a localize revision once its destination locale is explicit", async () => {
    const unit: DraftedPageUnitV2 = {
      unitKey: "loc",
      order: 0,
      sectionType: "localized_prose",
      draft: { mode: "localize", revisedBody: "<p>Copia nueva.</p>", bodyFormat: "richText", targetLocale: "es-MX" }
    };
    const result = await compileOf([unit], { loc: "sec_loc" });
    expect(result.ok).toBe(true);
  });

  it("refuses any task mode other than create by name, as a blocker rather than a silent no-op", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compilePagePlanV2({
      projectId: TENANT,
      units: [organization("org", 0)],
      snapshot,
      target: { mode: "revise" as unknown as "create", pageFields: PAGE_FIELDS },
      sectionIds: { org: "sec_org" }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["unsupported_task_mode"]);
  });

  it("refuses a request that would also change something beyond this page — never folded in, never claimed atomic", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compilePagePlanV2({
      projectId: TENANT,
      units: [organization("org", 0)],
      snapshot,
      target: { mode: "create", pageFields: PAGE_FIELDS },
      sectionIds: { org: "sec_org" },
      crossObjectChanges: [{ objectType: "navigation", objectId: "nav_main", reason: "add this page to the main menu" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["cross_object_change_unsupported"]);
  });

  it("refuses a caller-supplied `sections` key on pageFields rather than silently overwriting it", async () => {
    const result = await compileOf([organization("org", 0)], { org: "sec_org" }, {}, { ...PAGE_FIELDS, sections: [{ id: "x", type: "prose", data: {} }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual(["page_fields_sections_reserved"]);
  });

  it("refuses missing required page metadata (route/title) as a named blocker, never inventing content", async () => {
    const result = await compileOf([organization("org", 0)], { org: "sec_org" }, {}, { pageType: "standard" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.some((b) => b.code === "required_field_missing" && b.evidence?.field === "route")).toBe(true);
    expect(result.blockers.some((b) => b.code === "required_field_missing" && b.evidence?.field === "title")).toBe(true);
  });

  it("carries unrelated page fields and every component type through untouched alongside a localized section", async () => {
    const units: DraftedPageUnitV2[] = [
      organization("org", 0),
      faq("faq", 1, [{ question: "Q", answer: "A" }]),
      { unitKey: "loc", order: 2, sectionType: "localized_prose", draft: { mode: "localize", revisedBody: "<p>Copia.</p>", bodyFormat: "richText", targetLocale: "es-MX" } }
    ];
    const result = await compileOf(units, { org: "sec_org", faq: "sec_faq", loc: "sec_loc" }, {}, { ...PAGE_FIELDS, seo: { description: "Untouched.", ogImage: "img_1" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seoDiff = result.plan.changeSet.diffs.find((d) => d.field === "seo");
    expect(seoDiff?.after).toEqual({ description: "Untouched.", ogImage: "img_1" });
    expect(result.plan.units.map((u) => u.componentType)).toEqual(["prose", "faq", "prose"]);
  });
});

// The v1 compiler (siteContentObjectCompiler.ts) now enforces the LIVE page contract read from
// object_contract("page") on 2026-09-18: five required fields (route, pageType, title, seo, sections)
// and a top-level `section_types` registry it reads off the PAGE contract. The guard tests below do
// not care about that dialect — they only need SOME successful v1 plan to prove a v1 plan carries no
// v2 schemaVersion — so they compile against the live shape rather than the pre-correction one.
const V1_LIVE_PAGE_CONTRACT: SiteObjectFieldContract = {
  objectType: "page",
  required: ["route", "pageType", "title", "seo", "sections"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["route", "pageType", "title", "seo", "sections"],
    properties: {
      route: { type: "string", minLength: 1 },
      pageType: { type: "string" },
      title: { type: "string", minLength: 1 },
      seo: { type: "object", additionalProperties: true },
      sections: { type: "array" }
    }
  },
  sectionRegistry: LIVE_SECTION_REGISTRY,
  pageTypes: LIVE_PAGE_TYPES
};
const V1_LIVE_PAGE_FIELDS = { route: "/about", pageType: "standard", title: "About", seo: { title: "About" } };

describe("v1/v2 version guard — the boundary these two compilers must never cross", () => {
  it("tells a v2 plan from a v1 plan STRUCTURALLY — both compilers stamp the identical schemaVersion string", async () => {
    const snapshot = await snapshotOf(fixture());
    const v2 = compilePagePlanV2({
      projectId: TENANT,
      units: [organization("org", 0)],
      snapshot,
      target: { mode: "create", pageFields: PAGE_FIELDS },
      sectionIds: { org: "sec_org" }
    });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(isSitePageMaterializationV2Plan(v2.plan)).toBe(true);

    const v1SnapshotFixture = fixture({ contractsByType: { section: sectionContract(LIVE_COMPONENT_TYPES), page: V1_LIVE_PAGE_CONTRACT } });
    const v1Snapshot = await snapshotOf(v1SnapshotFixture);
    const v1 = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "about_overview", draft: { narrativeKind: "organization", title: "Who we are", body: "<p>x</p>" } }],
      snapshot: v1Snapshot,
      target: { pageObjectId: null, pageFields: V1_LIVE_PAGE_FIELDS }
    });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(isSitePageMaterializationV2Plan(v1.plan)).toBe(false);
    // The version string is NOT what separates them: siteContentObjectCompiler.ts stamps the
    // byte-identical "site-page-materialization.v2". Both compilers were rebuilt against the same
    // live contract in parallel and landed on the same name, so a version-only guard accepted a v1
    // plan as v2. `units` is the discriminator — a v1 plan carries `write`/`sectionProvenance`/
    // `changeSets` and has none.
    expect((v1.plan as unknown as Record<string, unknown>).schemaVersion).toBe(SITE_PAGE_MATERIALIZATION_V2_SCHEMA_VERSION);
    expect((v1.plan as unknown as Record<string, unknown>).units).toBeUndefined();
    expect(Array.isArray((v2.plan as unknown as Record<string, unknown>).units)).toBe(true);
  });

  it("assertSitePageMaterializationV2Plan refuses a v1 SiteContentObjectPlan — never reinterpreted as v2", async () => {
    const v1Snapshot = await snapshotOf(fixture({ contractsByType: { section: sectionContract(LIVE_COMPONENT_TYPES), page: V1_LIVE_PAGE_CONTRACT } }));
    const v1 = compileSiteContentObjects({
      projectId: TENANT,
      drafted: [{ order: 0, sectionType: "about_overview", draft: { narrativeKind: "organization", title: "Who we are", body: "<p>x</p>" } }],
      snapshot: v1Snapshot,
      target: { pageObjectId: null, pageFields: V1_LIVE_PAGE_FIELDS }
    });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(() => assertSitePageMaterializationV2Plan(v1.plan)).toThrow(/v1 SiteContentObjectPlan/);
  });

  it("assertNotSitePageMaterializationV2Plan refuses a v2 plan — never fed to the v1 applier", async () => {
    const snapshot = await snapshotOf(fixture());
    const v2 = compilePagePlanV2({
      projectId: TENANT,
      units: [organization("org", 0)],
      snapshot,
      target: { mode: "create", pageFields: PAGE_FIELDS },
      sectionIds: { org: "sec_org" }
    });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(() => assertNotSitePageMaterializationV2Plan(v2.plan)).toThrow(/v1 applier/);
  });

  it("a v2 plan is refused before it ever reaches the real v1 applier (applySiteContentPlan)", async () => {
    const snapshot = await snapshotOf(fixture());
    const v2 = compilePagePlanV2({
      projectId: TENANT,
      units: [organization("org", 0)],
      snapshot,
      target: { mode: "create", pageFields: PAGE_FIELDS },
      sectionIds: { org: "sec_org" }
    });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;

    // A minimal in-memory writer/journal — the point of this test is the guard refusing dispatch
    // before either is ever called, not the applier's own write behaviour (covered by
    // siteContentObjectApplier.test.ts against the real, unmodified applier).
    const writer = {
      createObject: async () => { throw new Error("must not be called: the guard should have refused before dispatch"); },
      patchObject: async () => { throw new Error("must not be called: the guard should have refused before dispatch"); },
      readObject: async () => null
    };
    const journal = { read: async () => null, write: async () => { throw new Error("must not be called: the guard should have refused before dispatch"); } };

    // The guarded call path a future integration would use: assert the version before ever handing
    // an untyped plan to the real v1 applier.
    const dispatchToV1Applier = async (plan: unknown) => {
      assertNotSitePageMaterializationV2Plan(plan, "applySiteContentPlan's plan argument");
      return applySiteContentPlan(plan as Parameters<typeof applySiteContentPlan>[0], { writer, journal });
    };

    await expect(dispatchToV1Applier(v2.plan)).rejects.toThrow(/v1 applier/);
  });
});
