import { describe, expect, it } from "vitest";
import { buildTemplateDepositCandidates } from "../../../src/agent/library/templateDeposit.js";
import { buildTemplateId } from "../../../src/agent/library/templateIdentity.js";

const mintApplied = () => [
  { objectType: "section_template", objectId: "tmpl_hero_1", requestedId: "req_hero", name: "Hero" },
  { objectType: "template", objectId: "tmpl_landing_1", requestedId: "req_landing", name: "Landing" },
  { objectType: "section_template", objectId: "tmpl_unverified_1", requestedId: "req_unverified", name: "Unverified" }
];
const mintCreates = () => [
  { objectType: "section_template", requestedId: "req_hero", body: { name: "Hero", blueprint: { type: "hero", data: {} } } },
  { objectType: "template", requestedId: "req_landing", body: { name: "Landing", slots: [{ slotId: "s1", allowed: ["hero"] }] } },
  { objectType: "section_template", requestedId: "req_unverified", body: { name: "Unverified", blueprint: { type: "faq", data: {} } } }
];

describe("buildTemplateDepositCandidates", () => {
  it("only names objects that actually PUBLISHED — a minted-but-unpublished recipe is excluded", () => {
    const candidates = buildTemplateDepositCandidates({
      sourceProjectId: "zilberman",
      mintApplied: mintApplied(),
      mintCreates: mintCreates(),
      publishedObjects: [{ objectType: "section_template", objectId: "tmpl_hero_1" }, { objectType: "template", objectId: "tmpl_landing_1" }]
    });
    expect(candidates.map((c) => c.objectId).sort()).toEqual(["tmpl_hero_1", "tmpl_landing_1"]);
  });

  it("returns an empty array when nothing published", () => {
    expect(buildTemplateDepositCandidates({ sourceProjectId: "zilberman", mintApplied: mintApplied(), mintCreates: mintCreates(), publishedObjects: [] })).toEqual([]);
  });

  it("builds a stable templateId scoped to the minting tenant, matching buildTemplateId", () => {
    const [candidate] = buildTemplateDepositCandidates({
      sourceProjectId: "zilberman",
      mintApplied: [mintApplied()[0]],
      mintCreates: [mintCreates()[0]],
      publishedObjects: [{ objectType: "section_template", objectId: "tmpl_hero_1" }]
    });
    expect(candidate.templateId).toBe(buildTemplateId({ sourceProjectId: "zilberman", objectType: "section_template", requestedId: "req_hero" }));
  });

  it("carries the recipe body straight from plan.creates, matched by objectType + requestedId", () => {
    const [candidate] = buildTemplateDepositCandidates({
      sourceProjectId: "zilberman",
      mintApplied: [mintApplied()[0]],
      mintCreates: [mintCreates()[0]],
      publishedObjects: [{ objectType: "section_template", objectId: "tmpl_hero_1" }]
    });
    expect(candidate.recipe).toEqual({ name: "Hero", blueprint: { type: "hero", data: {} } });
  });

  it("ignores an object type with no matching plan.creates entry (integrity mismatch) rather than depositing a partial candidate", () => {
    const candidates = buildTemplateDepositCandidates({
      sourceProjectId: "zilberman",
      mintApplied: [{ objectType: "section_template", objectId: "tmpl_x", requestedId: "req_missing", name: "X" }],
      mintCreates: [],
      publishedObjects: [{ objectType: "section_template", objectId: "tmpl_x" }]
    });
    expect(candidates).toEqual([]);
  });

  it("never treats a published page as a deposit candidate", () => {
    const candidates = buildTemplateDepositCandidates({
      sourceProjectId: "zilberman",
      mintApplied: [{ objectType: "page", objectId: "page_home", requestedId: "req_page", name: "Home" }],
      mintCreates: [{ objectType: "page", requestedId: "req_page", body: {} }],
      publishedObjects: [{ objectType: "page", objectId: "page_home" }]
    });
    expect(candidates).toEqual([]);
  });
});

describe("buildTemplateId", () => {
  it("is stable across repeated calls with the same inputs", () => {
    const a = buildTemplateId({ sourceProjectId: "zilberman", objectType: "section_template", requestedId: "req_hero" });
    const b = buildTemplateId({ sourceProjectId: "zilberman", objectType: "section_template", requestedId: "req_hero" });
    expect(a).toBe(b);
  });

  it("never collides across two different minting tenants sharing a requestedId", () => {
    const a = buildTemplateId({ sourceProjectId: "zilberman", objectType: "section_template", requestedId: "req_hero" });
    const b = buildTemplateId({ sourceProjectId: "dr-lurie", objectType: "section_template", requestedId: "req_hero" });
    expect(a).not.toBe(b);
  });
});
