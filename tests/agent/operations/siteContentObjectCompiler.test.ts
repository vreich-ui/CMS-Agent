// P2 v2 acceptance -- the drafted page -> ONE page materialization write step.
//
// EVERY contract fact these tests pin was read LIVE from `object_contract("page")` and
// `object_contract("section")` against the Kugel-Platform connector on 2026-09-18 and is carried in
// tests/agent/operations/fixtures/liveObjectContractCapture.ts (LIVE_SECTION_REGISTRY: all 28
// registry entries with their `component_bound`/`footprint`; LIVE_PAGE_TYPES: all six page types).
// Nothing here is derived from a repo fixture, a captured snapshot, PR prose or a code comment --
// all three of those still encode a stale dialect, which is what these tests exist to stop.
//
// The five live-required page fields are route, pageType, title, seo, sections -- `seo` INCLUDED.
import { describe, expect, it } from "vitest";

import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import type { SiteContextObject, SiteObjectFieldContract } from "../../../src/agent/operations/siteContext.js";
import { compileSiteContentObjects, PAGE_MATERIALIZATION_SCHEMA_VERSION, PAGE_REQUIRED_FIELDS } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import type { DraftedSectionInput } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import { createInMemorySiteContextSource, DEFAULT_REGISTRIES } from "./fixtures/inMemorySiteContextSource.js";
import type { FixtureTenantData } from "./fixtures/inMemorySiteContextSource.js";
import { LIVE_PAGE_TYPES, LIVE_SECTION_REGISTRY, LIVE_SECTION_TYPE_NAMES } from "./fixtures/liveObjectContractCapture.js";

const TENANT = "kugel-platform";

// The live page body_schema, trimmed to the keys these tests exercise but with the REAL required
// list. `sectionRegistry` and `pageTypes` are the live top-level registries, verbatim.
const PAGE_CONTRACT: SiteObjectFieldContract = {
  objectType: "page",
  required: ["route", "pageType", "title", "seo", "sections"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["route", "pageType", "title", "seo", "sections"],
    properties: {
      route: { type: "string", minLength: 1 },
      pageType: { type: "string", enum: ["home", "standard", "listing", "content_detail", "system", "clone"] },
      title: { type: "string", minLength: 1 },
      seo: { type: "object", additionalProperties: true },
      sections: { type: "array", items: { type: "object", additionalProperties: true } }
    }
  },
  sectionTypes: LIVE_SECTION_TYPE_NAMES,
  sectionRegistry: LIVE_SECTION_REGISTRY,
  pageTypes: LIVE_PAGE_TYPES
};

// The STANDALONE `section` object contract. Its live body_schema is `{required: ["section"],
// properties: [section, tracking]}` -- NOT a `{sectionType, data}` record, which is exactly the
// fiction this suite's predecessor validated against. The compiler no longer reads it at all; it is
// present only so a standalone/shared section object can appear in a snapshot's object list.
const SECTION_CONTRACT: SiteObjectFieldContract = {
  objectType: "section",
  required: ["section"],
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["section"],
    properties: { section: { type: "object", additionalProperties: true }, tracking: { type: "object", additionalProperties: true } }
  }
};

type InlineSection = { id: string; type: string; data: Record<string, unknown> };

const pageObject = (objectId: string, sections: InlineSection[] = [], contentRevision = 7): SiteContextObject => ({
  objectId,
  objectType: "page",
  status: "saved",
  version: 9,
  contentRevision,
  publishedTime: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: { route: "/about", pageType: "standard", title: "About", seo: { title: "About" }, sections }
});

// A page row as PRODUCTION sees it: `object_inventory`'s summary listing carries no body at all.
const bodylessPageObject = (objectId: string): SiteContextObject => ({
  objectId,
  objectType: "page",
  status: "saved",
  version: 9,
  contentRevision: 7,
  publishedTime: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: {}
});

const standaloneSection = (objectId: string): SiteContextObject => ({
  objectId,
  objectType: "section",
  status: "saved",
  version: 2,
  contentRevision: 1,
  publishedTime: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  fields: { section: { id: "s_shared1", type: "newsletter_signup", data: { formName: "footer_signup" } } }
});

const fixture = (overrides: Partial<FixtureTenantData> = {}): FixtureTenantData => ({
  tenantId: TENANT,
  revisionId: "rev_2026_09_18_01",
  objectsByType: { section: [], page: [] },
  contractsByType: { section: SECTION_CONTRACT, page: PAGE_CONTRACT },
  registries: DEFAULT_REGISTRIES,
  ...overrides
});

const snapshotOf = async (data: FixtureTenantData) => {
  const { source } = createInMemorySiteContextSource(data);
  return captureSiteSnapshot(source, { tenantId: data.tenantId, objectTypes: ["page", "section"] });
};

const PAGE_FIELDS = { route: "/about", pageType: "standard", title: "About", seo: { title: "About", robots: { index: true, follow: true } } };

const organization = (order: number, unitKey = `u${order}`, body = "<p>Founded to restore films.</p>"): DraftedSectionInput => ({
  unitKey,
  order,
  sectionType: "about_overview",
  draft: { narrativeKind: "organization", title: "Who we are", body, groundedIn: ["src_1"] },
  runId: `run_${order}`,
  executionId: `exec_${order}`
});

const people = (order: number, unitKey = `u${order}`): DraftedSectionInput => ({
  unitKey,
  order,
  sectionType: "our_team",
  draft: { narrativeKind: "people", title: "The team", body: "<p>Four archivists.</p>", groundedIn: ["src_2"] },
  runId: `run_${order}`,
  executionId: `exec_${order}`
});

const faq = (order: number, items: unknown[], unitKey = `u${order}`): DraftedSectionInput => ({
  unitKey,
  order,
  sectionType: "common_questions",
  draft: { referenceKind: "faq", title: "Questions", items }
});

const process = (order: number, items: unknown[], unitKey = `u${order}`): DraftedSectionInput => ({
  unitKey,
  order,
  sectionType: "how_it_works",
  draft: { referenceKind: "process", title: "How it works", items }
});

const comparison = (order: number, items: unknown[], unitKey = `u${order}`): DraftedSectionInput => ({
  unitKey,
  order,
  sectionType: "before_and_after",
  draft: { referenceKind: "comparison", title: "Before and after", items }
});

const compile = (drafted: DraftedSectionInput[], snapshot: Awaited<ReturnType<typeof snapshotOf>>, target: Record<string, unknown> = {}) =>
  compileSiteContentObjects({
    projectId: TENANT,
    drafted,
    snapshot,
    target: { pageObjectId: null, pageFields: PAGE_FIELDS, ...target } as never
  });

const codes = (result: ReturnType<typeof compileSiteContentObjects>): string[] => (result.ok ? [] : result.blockers.map((entry) => entry.code));

// ---------------------------------------------------------------------------------------------
// The contract facts themselves. If Platform's registry changes shape, these fail FIRST and name
// which fact moved, rather than letting a downstream test fail for an unrelated-looking reason.
// ---------------------------------------------------------------------------------------------
describe("the live page contract these tests are written against", () => {
  it("registers 28 section types, of which exactly card and shared_ref are not component-bound", () => {
    expect(LIVE_SECTION_REGISTRY).toHaveLength(28);
    expect(LIVE_SECTION_REGISTRY.filter((entry) => !entry.componentBound).map((entry) => entry.type).sort()).toEqual(["card", "shared_ref"]);
    expect(LIVE_SECTION_REGISTRY.filter((entry) => entry.footprint === null).map((entry) => entry.type).sort()).toEqual(["card", "shared_ref"]);
  });

  it("registers before_after as a component-bound, flow-region type -- it needs no capability gate", () => {
    const entry = LIVE_SECTION_REGISTRY.find((candidate) => candidate.type === "before_after");
    expect(entry).toBeDefined();
    expect(entry!.componentBound).toBe(true);
    expect(entry!.footprint).toEqual({ region: "flow" });
  });

  it("requires five page fields, seo included", () => {
    expect([...PAGE_REQUIRED_FIELDS]).toEqual(["route", "pageType", "title", "seo", "sections"]);
  });

  it("declares six page types, four of which restrict which sections may be placed", () => {
    expect(LIVE_PAGE_TYPES).toHaveLength(6);
    expect(LIVE_PAGE_TYPES.filter((rule) => rule.allowedSections !== "any")).toHaveLength(4);
    const home = LIVE_PAGE_TYPES.find((rule) => rule.id === "home")!;
    expect(home.routePattern).toBe("/");
    expect(home.allowedSections).toEqual(["hero", "checklist", "content_grid", "bio", "newsletter_signup", "shared_ref"]);
    expect(home.requiredSections).toEqual(["hero"]);
    const system = LIVE_PAGE_TYPES.find((rule) => rule.id === "system")!;
    expect(system.routePattern).toBe("/[system]");
    expect(system.allowedSections).toEqual(["hero", "prose", "link_list", "cta_banner"]);
  });

  it("carries no `sectionType` key anywhere in either contract", () => {
    expect(JSON.stringify(LIVE_SECTION_REGISTRY)).not.toContain("sectionType");
    expect(JSON.stringify(SECTION_CONTRACT.schema)).not.toContain("sectionType");
    expect(SECTION_CONTRACT.required).toEqual(["section"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("compileSiteContentObjects — creating a new page (inline sections)", () => {
  it("compiles drafts into ONE create write with inline sections, preserving non-contiguous planner orders", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(7, "values"), organization(1, "about"), people(4, "team")], snapshot);

    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    expect(result.plan.schemaVersion).toBe(PAGE_MATERIALIZATION_SCHEMA_VERSION);
    expect(result.plan.sectionProvenance.map((section) => section.order)).toEqual([1, 4, 7]);
    expect(result.plan.sectionProvenance.map((section) => section.componentType)).toEqual(["prose", "bio", "prose"]);
    expect(result.plan.sectionProvenance.map((section) => section.unitKey)).toEqual(["about", "team", "values"]);
    expect(result.plan.page.action).toBe("create");
    expect(result.plan.sectionProvenance[0]!.sourceRunId).toBe("run_1");
    expect(result.plan.sectionProvenance[1]!.sourceExecutionId).toBe("exec_4");

    const sections = result.plan.write.fields.sections as InlineSection[];
    expect(sections.map((section) => section.type)).toEqual(["prose", "bio", "prose"]);
    for (const [index, section] of sections.entries()) {
      expect(section.id).toMatch(/^s_[a-z0-9]+$/);
      expect(section.id).toBe(result.plan.sectionProvenance[index]!.sectionId);
    }
    expect(result.plan.changeSets).toHaveLength(1);
    expect(result.plan.changeSets[0]!.objectType).toBe("page");
  });

  it("compiles an FAQ draft into the registry's own `{items:[{q,a}]}` data shape", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([faq(0, [{ question: "How long?", answer: "Six weeks." }])], snapshot);
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    const section = (result.plan.write.fields.sections as InlineSection[])[0]!;
    expect(section.type).toBe("faq");
    expect(section.data).toEqual({ heading: "Questions", items: [{ q: "How long?", a: "Six weeks." }] });
  });

  it("compiles a process draft into the registry's own `steps` data shape", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([process(0, [{ question: "Assess", answer: "We inspect the reel." }])], snapshot);
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    const section = (result.plan.write.fields.sections as InlineSection[])[0]!;
    expect(section.type).toBe("steps");
    expect(section.data).toEqual({ heading: "How it works", items: [{ title: "Assess", description: "We inspect the reel." }] });
  });
});

// ---------------------------------------------------------------------------------------------
// C2 -- the registry gate, placeability, and PageType law.
// ---------------------------------------------------------------------------------------------
describe("C2 — the section-type registry is read from object_contract(\"page\").section_types", () => {
  it("refuses when the page contract carries no section_types registry, naming the page contract", async () => {
    const withoutRegistry: SiteObjectFieldContract = { objectType: "page", required: PAGE_CONTRACT.required, schema: PAGE_CONTRACT.schema, pageTypes: LIVE_PAGE_TYPES };
    const snapshot = await snapshotOf(fixture({ contractsByType: { section: SECTION_CONTRACT, page: withoutRegistry } }));
    const result = compile([organization(0)], snapshot);
    expect(codes(result)).toEqual(["section_type_registry_unavailable"]);
  });

  it("does NOT fall back to the `section` contract's registry -- the page contract is the authority", async () => {
    // The section contract carries the identical registry live, but placement law lives on the page
    // contract; reading the section contract is how the compiler previously validated nothing at all.
    const sectionWithRegistry: SiteObjectFieldContract = { ...SECTION_CONTRACT, sectionRegistry: LIVE_SECTION_REGISTRY };
    const pageWithoutRegistry: SiteObjectFieldContract = { objectType: "page", required: PAGE_CONTRACT.required, schema: PAGE_CONTRACT.schema };
    const snapshot = await snapshotOf(fixture({ contractsByType: { section: sectionWithRegistry, page: pageWithoutRegistry } }));
    expect(codes(compile([organization(0)], snapshot))).toEqual(["section_type_registry_unavailable"]);
  });

  it("refuses a section type the registry does not contain, listing what is registered", async () => {
    const narrowed: SiteObjectFieldContract = { ...PAGE_CONTRACT, sectionRegistry: LIVE_SECTION_REGISTRY.filter((entry) => entry.type !== "bio") };
    const snapshot = await snapshotOf(fixture({ contractsByType: { section: SECTION_CONTRACT, page: narrowed } }));
    const result = compile([people(0)], snapshot);
    expect(codes(result)).toEqual(["unsupported_section_type"]);
    if (result.ok) return;
    expect(result.blockers[0]!.message).toContain("bio");
    expect(result.blockers[0]!.message).toContain("prose");
  });

  it("refuses a NON-PLACEABLE type by rule, not by name -- any component_bound:false entry, not just `card`", async () => {
    // `prose` is component-bound live. Flipping THIS entry (not card's) proves the refusal is the
    // general placeability rule and would catch a 29th non-component type added tomorrow.
    const unplaceableProse: SiteObjectFieldContract = {
      ...PAGE_CONTRACT,
      sectionRegistry: LIVE_SECTION_REGISTRY.map((entry) => (entry.type === "prose" ? { ...entry, componentBound: false, footprint: null } : entry))
    };
    const snapshot = await snapshotOf(fixture({ contractsByType: { section: SECTION_CONTRACT, page: unplaceableProse } }));
    const result = compile([organization(0)], snapshot);
    expect(codes(result)).toEqual(["section_type_not_placeable"]);
    if (result.ok) return;
    expect(result.blockers[0]!.evidence).toMatchObject({ componentType: "prose", componentBound: false, footprint: null });
  });

  it("refuses data the registry entry's own data_schema rejects, rather than letting the tenant reject the write", async () => {
    // The live `schema_zod` constraint is strict (`additionalProperties: false`). Validating the
    // compiled `data` against the registry's own `data_schema` turns a tenant-side 4xx an operator
    // would have to reconstruct into a named compile-time refusal.
    const strictProse: SiteObjectFieldContract = {
      ...PAGE_CONTRACT,
      sectionRegistry: LIVE_SECTION_REGISTRY.map((entry) =>
        entry.type === "prose"
          ? { ...entry, dataSchema: { type: "object", required: ["body", "kicker"], properties: { body: { type: "string" }, kicker: { type: "string" } }, additionalProperties: false } }
          : entry
      )
    };
    const snapshot = await snapshotOf(fixture({ contractsByType: { section: SECTION_CONTRACT, page: strictProse } }));
    const result = compile([organization(0)], snapshot);
    expect(codes(result)).toEqual(["section_data_invalid"]);
    if (result.ok) return;
    expect(result.blockers[0]!.message).toContain("kicker");
  });

  it("places before_after with no capability gate of its own once its data is registry-shaped", async () => {
    const snapshot = await snapshotOf(fixture());
    const media = (label: string) => ({ src: `/img/${label}.jpg`, alt: `${label} state`, label });
    const result = compile([comparison(0, [{ before: media("before"), after: media("after") }])], snapshot);
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    expect((result.plan.write.fields.sections as InlineSection[])[0]!.type).toBe("before_after");
  });
});

describe("C2 — PageType law (allowedSections / requiredSections)", () => {
  it("refuses a section the declared page type does not allow, naming the allow-list", async () => {
    const snapshot = await snapshotOf(fixture());
    // pageType "system" allows hero/prose/link_list/cta_banner -- a `bio` is not among them.
    const result = compile([people(0)], snapshot, { pageFields: { ...PAGE_FIELDS, route: "/404", pageType: "system" } });
    expect(codes(result)).toEqual(["section_not_allowed_for_page_type"]);
    if (result.ok) return;
    expect(result.blockers[0]!.evidence).toMatchObject({ componentType: "bio", pageType: "system" });
  });

  it("refuses a page type whose required section is absent", async () => {
    const snapshot = await snapshotOf(fixture());
    // pageType "home" requires a `hero`; it also does not allow `prose`, so both blockers are named.
    const result = compile([organization(0)], snapshot, { pageFields: { ...PAGE_FIELDS, route: "/", pageType: "home" } });
    expect(codes(result).sort()).toEqual(["page_type_required_section_missing", "section_not_allowed_for_page_type"]);
  });

  it("allows anything on a page type whose allowedSections is \"any\"", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0), people(1)], snapshot, { pageFields: { ...PAGE_FIELDS, pageType: "clone", route: "/captured/x" } });
    expect(codes(result)).toEqual([]);
  });

  it("refuses a page type the contract's law does not define", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0)], snapshot, { pageFields: { ...PAGE_FIELDS, pageType: "microsite" } });
    expect(codes(result)).toContain("page_type_unknown");
  });
});

// ---------------------------------------------------------------------------------------------
// C3 -- required page fields and the tracking funnel.
// ---------------------------------------------------------------------------------------------
describe("C3 — the five required page fields", () => {
  it.each(["route", "pageType", "title", "seo"] as const)("refuses a missing %s by name rather than inventing one", async (field) => {
    const snapshot = await snapshotOf(fixture());
    const pageFields: Record<string, unknown> = { ...PAGE_FIELDS };
    delete pageFields[field];
    const result = compile([organization(0)], snapshot, { pageFields });
    expect(codes(result)).toContain("page_field_required_missing");
    if (result.ok) return;
    const named = result.blockers.find((entry) => entry.evidence?.field === field);
    expect(named).toBeDefined();
    expect(named!.message).toContain(field);
  });

  it("names EVERY missing required field, not just the first", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0)], snapshot, { pageFields: { title: "About" } });
    expect(codes(result)).toEqual(["page_field_required_missing", "page_field_required_missing", "page_field_required_missing"]);
    if (result.ok) return;
    expect(result.blockers.map((entry) => entry.evidence?.field).sort()).toEqual(["pageType", "route", "seo"]);
  });

  it("accepts the live seo shape and carries it into the create body untouched", async () => {
    const snapshot = await snapshotOf(fixture());
    const seo = { title: "About us", description: "Who we are.", ogImage: "/og.png", robots: { index: true, follow: false } };
    const result = compile([organization(0)], snapshot, { pageFields: { ...PAGE_FIELDS, seo } });
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    expect(result.plan.write.fields.seo).toEqual(seo);
  });
});

describe("C3 — the tracking one-writer funnel", () => {
  it("refuses a `tracking` key inside pageFields by name, naming set_tracking as the channel", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0)], snapshot, { pageFields: { ...PAGE_FIELDS, tracking: { enabled: true } } });
    expect(codes(result)).toEqual(["page_fields_tracking_reserved"]);
    if (result.ok) return;
    expect(result.blockers[0]!.remedy).toContain("set_tracking");
  });

  it("compiles target.tracking into its own set_tracking op on a patch, never into set_page_meta", async () => {
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [pageObject("page_about", [{ id: "s_existing1", type: "prose", data: { body: "<p>Old.</p>" } }])] } }));
    const result = compile([organization(0)], snapshot, { pageObjectId: "page_about", pageFields: { title: "About the studio" }, tracking: { enabled: true, label: "about" } });
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "patch") return;
    const ops = result.plan.write.ops;
    expect(ops.map((op) => op.op)).toEqual(["set_page_meta", "upsert_section", "set_tracking"]);
    const meta = ops.find((op) => op.op === "set_page_meta")!;
    expect(meta.op === "set_page_meta" && Object.keys(meta.fields)).toEqual(["title"]);
    const tracking = ops.find((op) => op.op === "set_tracking")!;
    expect(tracking).toEqual({ op: "set_tracking", fields: { enabled: true, label: "about" } });
  });

  it("carries tracking in the create body -- object_create takes a whole body, the funnel constrains patch ops", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0)], snapshot, { tracking: { enabled: true } });
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    expect(result.plan.write.fields.tracking).toEqual({ enabled: true });
  });
});

// ---------------------------------------------------------------------------------------------
// C4 -- section identity.
// ---------------------------------------------------------------------------------------------
describe("C4 — caller-preallocated section ids", () => {
  it("uses the caller's preallocated ids verbatim and records their origin", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0, "about"), people(1, "team")], snapshot, { sectionIds: { about: "s_about1", team: "s_team2" } });
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    expect((result.plan.write.fields.sections as InlineSection[]).map((section) => section.id)).toEqual(["s_about1", "s_team2"]);
    expect(result.plan.sectionProvenance.every((section) => section.sectionIdOrigin === "preallocated")).toBe(true);
  });

  it("keeps two BYTE-IDENTICAL drafts distinct -- which a content digest alone cannot do", async () => {
    const snapshot = await snapshotOf(fixture());
    const same = "<p>Identical copy.</p>";
    const result = compile([organization(0, "a", same), organization(1, "b", same)], snapshot, { sectionIds: { a: "s_a1", b: "s_b2" } });
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "create") return;
    const sections = result.plan.write.fields.sections as InlineSection[];
    expect(sections.map((section) => section.id)).toEqual(["s_a1", "s_b2"]);
    expect(sections[0]!.data).toEqual(sections[1]!.data);
  });

  it("refuses a preallocated id that does not match Platform's ^s_[a-z0-9]+$ pattern", async () => {
    const snapshot = await snapshotOf(fixture());
    for (const bad of ["sec_about", "s_About", "s_about-1", "s_"]) {
      const result = compile([organization(0, "about")], snapshot, { sectionIds: { about: bad } });
      expect(codes(result)).toContain("section_id_malformed");
    }
  });

  it("mints a conformant id where none is supplied at all", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0, "about")], snapshot);
    expect(codes(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.plan.sectionProvenance[0]!.sectionId).toMatch(/^s_[a-z0-9]+$/);
    expect(result.plan.sectionProvenance[0]!.sectionIdOrigin).toBe("minted");
  });

  it("refuses a PARTIAL preallocation by name rather than minting the rest behind the caller's intent", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0, "about"), people(1, "team")], snapshot, { sectionIds: { about: "s_about1" } });
    expect(codes(result)).toEqual(["preallocated_section_id_missing"]);
    if (result.ok) return;
    expect(result.blockers[0]!.evidence).toMatchObject({ missingUnitKeys: ["team"] });
  });

  it("refuses two units preallocated the SAME id by name", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0, "a"), people(1, "b")], snapshot, { sectionIds: { a: "s_dup1", b: "s_dup1" } });
    expect(codes(result)).toEqual(["duplicate_section_id"]);
  });

  it("refuses a preallocated id naming a unit that was never drafted", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0, "about")], snapshot, { sectionIds: { about: "s_about1", ghost: "s_ghost1" } });
    expect(codes(result)).toContain("preallocated_section_id_unmatched");
  });

  it("refuses two drafted units sharing a unit key, since a preallocated id could not be attributed", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0, "same"), people(1, "same")], snapshot);
    expect(codes(result)).toContain("duplicate_unit_key");
  });
});

// ---------------------------------------------------------------------------------------------
// C5 -- the ported battery.
// ---------------------------------------------------------------------------------------------
describe("C5 — per-item structured-content blockers", () => {
  it("refuses an FAQ item missing its answer", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([faq(0, [{ question: "How long?" }])], snapshot))).toEqual(["faq_item_incomplete"]);
  });

  it("refuses an FAQ item missing its question", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([faq(0, [{ answer: "Six weeks." }])], snapshot);
    expect(codes(result)).toEqual(["faq_item_incomplete"]);
    if (result.ok) return;
    expect(result.blockers[0]!.message).toContain("question");
  });

  it("refuses an FAQ with no items at all rather than downgrading it to prose", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([faq(0, [])], snapshot))).toEqual(["faq_items_missing"]);
  });

  it("refuses a process step missing its description", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([process(0, [{ question: "Assess" }])], snapshot))).toEqual(["process_step_incomplete"]);
  });

  it("refuses a process with no ordered items rather than downgrading it to prose", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([process(0, [])], snapshot))).toEqual(["process_steps_missing"]);
  });

  it("refuses a comparison item missing its after value", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([comparison(0, [{ before: { src: "/a.jpg", alt: "a", label: "a" } }])], snapshot))).toEqual(["comparison_item_incomplete"]);
  });

  it("refuses a comparison with no items at all", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([comparison(0, [])], snapshot))).toEqual(["comparison_items_missing"]);
  });

  it("refuses a TEXT-only comparison: before_after's live data schema is a single {src,alt,label} image pair", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([comparison(0, [{ before: "Cracked emulsion", after: "Restored" }])], snapshot))).toEqual(["comparison_media_unavailable"]);
  });

  it("refuses a multi-row comparison: before_after holds exactly one pair", async () => {
    const snapshot = await snapshotOf(fixture());
    const media = (label: string) => ({ src: `/${label}.jpg`, alt: label, label });
    const items = [{ before: media("b1"), after: media("a1") }, { before: media("b2"), after: media("a2") }];
    expect(codes(compile([comparison(0, items)], snapshot))).toEqual(["comparison_multiple_pairs_unsupported"]);
  });

  it("refuses a draft carrying none of the discriminators it routes on", async () => {
    const snapshot = await snapshotOf(fixture());
    const orphan: DraftedSectionInput = { unitKey: "x", order: 0, sectionType: "mystery", draft: { title: "T", body: "<p>B</p>" } };
    expect(codes(compile([orphan], snapshot))).toEqual(["unrecognized_draft_artifact"]);
  });

  it("is ALL OR NOTHING: one bad unit fails the whole compilation and returns no partial plan", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0, "good"), faq(1, [], "bad")], snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["faq_items_missing"]);
  });
});

describe("C5 — reserved and out-of-scope inputs", () => {
  it("refuses a caller-supplied `sections` key in pageFields rather than silently overwriting it", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0)], snapshot, { pageFields: { ...PAGE_FIELDS, sections: [{ id: "s_mine1", type: "prose", data: { body: "<p>Mine.</p>" } }] } });
    expect(codes(result)).toEqual(["page_fields_sections_reserved"]);
    if (result.ok) return;
    expect(result.blockers[0]!.evidence?.suppliedKeys).toContain("sections");
  });

  it("refuses a named cross-object change rather than folding it into the page write", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compile([organization(0)], snapshot, {
      crossObjectChanges: [{ objectType: "navigation", objectId: "nav_main", reason: "add the new page to the primary menu" }]
    });
    expect(codes(result)).toEqual(["cross_object_change_unsupported"]);
    if (result.ok) return;
    expect(result.blockers[0]!.evidence).toMatchObject({ objectType: "navigation", objectId: "nav_main" });
  });

  it("refuses drafts compiled against another tenant's snapshot", async () => {
    const snapshot = await snapshotOf(fixture());
    const result = compileSiteContentObjects({ projectId: "dr-lurie", drafted: [organization(0)], snapshot, target: { pageObjectId: null, pageFields: PAGE_FIELDS } });
    expect(codes(result)).toEqual(["foreign_tenant_reference"]);
  });

  it("refuses an empty drafting result", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([], snapshot))).toEqual(["no_drafted_sections"]);
  });

  it("refuses two drafts sharing a planner order", async () => {
    const snapshot = await snapshotOf(fixture());
    expect(codes(compile([organization(3, "a"), people(3, "b")], snapshot))).toContain("duplicate_section_order");
  });
});

describe("C5 — materializationKey determinism", () => {
  it("is deterministic: identical inputs and ids produce the identical key and the identical section ids", async () => {
    const snapshot = await snapshotOf(fixture());
    const units = [organization(0, "about"), people(1, "team")];
    const ids = { about: "s_about1", team: "s_team2" };
    const first = compile(units, snapshot, { sectionIds: ids });
    const second = compile(units, snapshot, { sectionIds: ids });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.plan.materializationKey).toBe(first.plan.materializationKey);
    expect(second.plan.sectionProvenance.map((section) => section.sectionId)).toEqual(first.plan.sectionProvenance.map((section) => section.sectionId));
    expect(second.plan.changeSets[0]!.changeSetId).toBe(first.plan.changeSets[0]!.changeSetId);
  });

  it("a REORDER changes the digest -- it must never dedupe onto the pre-reorder apply", async () => {
    const snapshot = await snapshotOf(fixture());
    const ids = { about: "s_about1", team: "s_team2" };
    const before = compile([organization(0, "about"), people(1, "team")], snapshot, { sectionIds: ids });
    const after = compile([organization(1, "about"), people(0, "team")], snapshot, { sectionIds: ids });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    // Each unit keeps its own id; only their sequence on the page moved.
    expect(before.plan.sectionProvenance.map((section) => [section.unitKey, section.sectionId])).toEqual([["about", "s_about1"], ["team", "s_team2"]]);
    expect(after.plan.sectionProvenance.map((section) => [section.unitKey, section.sectionId])).toEqual([["team", "s_team2"], ["about", "s_about1"]]);
    expect(after.plan.materializationKey).not.toBe(before.plan.materializationKey);
  });

  it("a changed draft body changes the key -- the key is not a constant", async () => {
    const snapshot = await snapshotOf(fixture());
    const base = compile([organization(0, "about")], snapshot, { sectionIds: { about: "s_about1" } });
    const edited = compile([organization(0, "about", "<p>Founded in 1974.</p>")], snapshot, { sectionIds: { about: "s_about1" } });
    expect(base.ok && edited.ok).toBe(true);
    if (!base.ok || !edited.ok) return;
    expect(edited.plan.materializationKey).not.toBe(base.plan.materializationKey);
  });

  it("a changed PAGE FIELD changes the key even when every section is untouched", async () => {
    const snapshot = await snapshotOf(fixture());
    const base = compile([organization(0, "about")], snapshot, { sectionIds: { about: "s_about1" } });
    const retitled = compile([organization(0, "about")], snapshot, { pageFields: { ...PAGE_FIELDS, title: "About the studio" }, sectionIds: { about: "s_about1" } });
    expect(base.ok && retitled.ok).toBe(true);
    if (!base.ok || !retitled.ok) return;
    expect(retitled.plan.materializationKey).not.toBe(base.plan.materializationKey);
  });
});

// ---------------------------------------------------------------------------------------------
// The revise path -- refused by name, with its carry-forward recorded.
// ---------------------------------------------------------------------------------------------
describe("the page-revise path is refused by name (carry-forward, not an oversight)", () => {
  it("refuses a request naming an existing inline section to rewrite", async () => {
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [pageObject("page_about", [{ id: "s_existing1", type: "prose", data: { body: "<p>Old.</p>" } }])] } }));
    const result = compile([organization(0, "about")], snapshot, { pageObjectId: "page_about", sectionTargets: { about: "s_existing1" } });
    expect(codes(result)).toEqual(["page_revise_path_unsupported"]);
    if (result.ok) return;
    expect(result.blockers[0]!.evidence?.carryForward).toBe("page-revise path: separate task");
  });

  it("refuses a patch whose page row carries no body at all -- the production object_inventory case", async () => {
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [bodylessPageObject("page_about")] } }));
    const result = compile([organization(0, "about")], snapshot, { pageObjectId: "page_about" });
    expect(codes(result)).toEqual(["page_body_unavailable_for_patch"]);
  });

  it("still refuses a shared/standalone section mutation under its own name", async () => {
    const snapshot = await snapshotOf(fixture({
      objectsByType: { section: [standaloneSection("sec_shared")], page: [pageObject("page_about", [{ id: "s_existing1", type: "prose", data: { body: "<p>Old.</p>" } }])] }
    }));
    const result = compile([organization(0, "about")], snapshot, { pageObjectId: "page_about", sectionTargets: { about: "sec_shared" } });
    expect(codes(result)).toEqual(["unsupported_shared_section_mutation"]);
  });

  it("refuses a revision draft that names no target", async () => {
    const snapshot = await snapshotOf(fixture());
    const revision: DraftedSectionInput = { unitKey: "rev", order: 0, sectionType: "revised_prose", draft: { mode: "revise", revisedBody: "<p>New copy.</p>" } };
    expect(codes(compile([revision], snapshot))).toEqual(["revision_without_target"]);
  });

  it("still APPENDS to an existing page whose body is known, at the right positions", async () => {
    const existing = [{ id: "s_existing1", type: "prose", data: { body: "<p>Old.</p>" } }];
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [pageObject("page_about", existing)] } }));
    const result = compile([organization(0, "a"), people(1, "b")], snapshot, { pageObjectId: "page_about", pageFields: {} });
    expect(codes(result)).toEqual([]);
    if (!result.ok || result.plan.write.kind !== "patch") return;
    const upserts = result.plan.write.ops.filter((op) => op.op === "upsert_section");
    expect(upserts).toHaveLength(2);
    expect(upserts.map((op) => (op.op === "upsert_section" ? op.position : null))).toEqual([1, 2]);
    expect(result.plan.page.targetContentRevision).toBe(7);
  });

  it("refuses a patch target the snapshot does not contain", async () => {
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [] } }));
    expect(codes(compile([organization(0)], snapshot, { pageObjectId: "page_ghost", pageFields: {} }))).toEqual(["patch_target_not_in_snapshot"]);
  });

  it("refuses a patch whose page moved since the request was prepared", async () => {
    const snapshot = await snapshotOf(fixture({ objectsByType: { section: [], page: [pageObject("page_about", [], 9)] } }));
    expect(codes(compile([organization(0)], snapshot, { pageObjectId: "page_about", pageFields: {}, expectedPageContentRevision: 7 }))).toEqual(["stale_target"]);
  });
});
