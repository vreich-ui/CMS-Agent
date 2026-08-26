import { describe, expect, it } from "vitest";
import { sectionTypesUsedInRecipe } from "../../../src/agent/library/templateSectionTypes.js";

describe("sectionTypesUsedInRecipe", () => {
  it("reads the single type from a section_template's blueprint", () => {
    expect(sectionTypesUsedInRecipe("section_template", { blueprint: { type: "hero", data: {} } })).toEqual(["hero"]);
  });

  it("returns an empty array for a section_template with no blueprint type", () => {
    expect(sectionTypesUsedInRecipe("section_template", {})).toEqual([]);
  });

  it("reads every slot's allowed[0] from a page template, deduped and sorted", () => {
    const recipe = { slots: [{ slotId: "a", allowed: ["hero"] }, { slotId: "b", allowed: ["faq"] }, { slotId: "c", allowed: ["hero"] }] };
    expect(sectionTypesUsedInRecipe("template", recipe)).toEqual(["faq", "hero"]);
  });

  it("returns an empty array for a page template with no slots", () => {
    expect(sectionTypesUsedInRecipe("template", {})).toEqual([]);
  });

  it("returns an empty array for pdf_template — not a section-type consumer", () => {
    expect(sectionTypesUsedInRecipe("pdf_template", { anything: true })).toEqual([]);
  });
});
