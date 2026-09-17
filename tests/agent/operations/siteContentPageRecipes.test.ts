import { describe, expect, it } from "vitest";
import { SITE_CONTENT_PAGE_RECIPES } from "../../../src/agent/operations/siteContentPageRecipes.js";

// A recipe section's `order` field is ONLY its own declaration index within its recipe's `sections`
// array (0-based, contiguous) — never matched against the planner's own `order` value (see
// siteContentDraftingExecutor.ts, "recipe sections pair by position"). This test asserts every
// shipped recipe honours that invariant, so a future recipe with more than one section cannot
// accidentally reintroduce order-value matching by drifting its `order` fields out of step with
// declaration position.
describe("SITE_CONTENT_PAGE_RECIPES — order is a 0-based, contiguous declaration index", () => {
  for (const [name, recipeDef] of Object.entries(SITE_CONTENT_PAGE_RECIPES)) {
    it(`recipe "${name}": sections[i].order === i for every declared section`, () => {
      recipeDef.sections.forEach((section, index) => {
        expect(section.order).toBe(index);
      });
    });
  }
});
