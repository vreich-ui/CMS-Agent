/**
 * C2 (part 2) — the scope vocabulary itself.
 *
 * The rule the whole module turns on is that an UNKNOWN dimension is not a match: a caller that
 * cannot say which site it is on must not receive site-scoped policy. Everything else here is the
 * round-tripping and the storage-key shape that keep one spelling of a scope from becoming two.
 */
import { describe, expect, it } from "vitest";
import {
  FLEET_SCOPE_KEY,
  SCOPE_DIMENSIONS,
  compareScopeSpecificity,
  isFleetScope,
  normalizeScope,
  parseScopeKey,
  scopeApplies,
  scopeKey,
  scopeLabel,
  scopeSpecificity,
  scopeStorageSegments,
  validateScope
} from "../../../src/agent/scope/policyScope.js";

describe("normalizeScope", () => {
  it("drops absent and blank dimensions so one scope has one spelling", () => {
    expect(normalizeScope({ site: "dr-lurie", task: "", objective: undefined })).toEqual({ site: "dr-lurie" });
    expect(normalizeScope(undefined)).toEqual({});
    expect(isFleetScope({ site: "   " })).toBe(true);
  });
});

describe("scopeApplies", () => {
  it("applies the fleet scope everywhere, including to a context that knows nothing", () => {
    expect(scopeApplies({}, { site: "dr-lurie", task: "draft_writer" })).toBe(true);
    expect(scopeApplies({}, {})).toBe(true);
  });

  it("requires every named dimension to match", () => {
    const context = { site: "dr-lurie", task: "draft_writer" };
    expect(scopeApplies({ site: "dr-lurie" }, context)).toBe(true);
    expect(scopeApplies({ site: "dr-lurie", task: "draft_writer" }, context)).toBe(true);
    expect(scopeApplies({ site: "fernwell" }, context)).toBe(false);
    expect(scopeApplies({ site: "dr-lurie", task: "seo_review" }, context)).toBe(false);
  });

  it("DOES NOT MATCH a dimension the context cannot state — unknown is never yes", () => {
    // The isolation rule. A dispatch with no site (an inspection, a synthetic node, a job with no
    // tenant) must not pick up dr-lurie's policy just because nothing contradicted it.
    expect(scopeApplies({ site: "dr-lurie" }, { task: "draft_writer" })).toBe(false);
    expect(scopeApplies({ objective: "q4_launch" }, { site: "dr-lurie", task: "draft_writer" })).toBe(false);
    expect(scopeApplies({ site: "dr-lurie" }, {})).toBe(false);
  });
});

describe("scopeKey / parseScopeKey", () => {
  it("round-trips every scope this vocabulary can express", () => {
    const scopes = [
      {},
      { site: "dr-lurie" },
      { task: "draft_writer" },
      { objective: "q4_launch" },
      { site: "dr-lurie", task: "draft_writer" },
      { site: "dr-lurie", task: "draft_writer", objective: "q4_launch" }
    ];
    for (const scope of scopes) expect(parseScopeKey(scopeKey(scope))).toEqual(scope);
    expect(scopeKey({})).toBe(FLEET_SCOPE_KEY);
  });

  it("writes dimensions in one fixed order whatever order the caller used", () => {
    expect(scopeKey({ task: "draft_writer", site: "dr-lurie" })).toBe("site=dr-lurie;task=draft_writer");
    expect(scopeKey({ site: "dr-lurie", task: "draft_writer" })).toBe("site=dr-lurie;task=draft_writer");
  });

  it("refuses a key it did not write, rather than inventing a scope from it", () => {
    expect(parseScopeKey("site")).toBeUndefined();
    expect(parseScopeKey("tenant=dr-lurie")).toBeUndefined();
    expect(parseScopeKey("site=dr-lurie;site=fernwell")).toBeUndefined();
    expect(parseScopeKey("site=../../etc")).toBeUndefined();
  });
});

describe("validateScope", () => {
  it("accepts the fleet and the id shapes this fleet actually uses", () => {
    expect(validateScope({})).toEqual([]);
    expect(validateScope({ site: "dr-lurie", task: "draft_writer", objective: "q4_launch" })).toEqual([]);
  });

  it("names the dimension and the reason, including for an unknown dimension", () => {
    expect(validateScope({ site: "a/b" }).join(" ")).toContain("storage key segment");
    expect(validateScope({ site: "  " }).join(" ")).toContain("omit the dimension");
    expect(validateScope({ tenant: "dr-lurie" } as never).join(" ")).toContain("Unknown scope dimension");
    expect(validateScope({ tenant: "dr-lurie" } as never).join(" ")).toContain(SCOPE_DIMENSIONS.join(", "));
  });
});

describe("specificity", () => {
  it("counts named dimensions and ranks narrower above wider", () => {
    expect(scopeSpecificity({})).toBe(0);
    expect(scopeSpecificity({ site: "dr-lurie", task: "draft_writer" })).toBe(2);
    expect(compareScopeSpecificity({ site: "dr-lurie" }, {})).toBeGreaterThan(0);
    expect(compareScopeSpecificity({}, { site: "dr-lurie" })).toBeLessThan(0);
  });

  it("refuses to rank two equally narrow scopes, so no caller inherits an arbitrary winner", () => {
    expect(compareScopeSpecificity({ site: "dr-lurie" }, { objective: "q4_launch" })).toBe(0);
    expect(compareScopeSpecificity({ site: "dr-lurie" }, { site: "fernwell" })).toBe(0);
  });
});

describe("scopeStorageSegments", () => {
  it("gives the fleet NO segments, so an existing record keeps the key it already has", () => {
    expect(scopeStorageSegments({})).toEqual([]);
    expect(scopeStorageSegments(undefined)).toEqual([]);
  });

  it("prefixes each named dimension", () => {
    expect(scopeStorageSegments({ site: "dr-lurie" })).toEqual(["by-site", "dr-lurie"]);
    expect(scopeStorageSegments({ site: "dr-lurie", task: "draft_writer" })).toEqual(["by-site", "dr-lurie", "by-task", "draft_writer"]);
  });

  it("throws rather than building a key from a value that could traverse a path", () => {
    expect(() => scopeStorageSegments({ site: "../../secrets" })).toThrow(/Refusing to build a storage key/);
  });
});

describe("scopeLabel", () => {
  it("reads as English in a blocker message", () => {
    expect(scopeLabel({})).toBe("the fleet");
    expect(scopeLabel({ site: "dr-lurie" })).toBe("site dr-lurie");
    expect(scopeLabel({ site: "dr-lurie", task: "draft_writer" })).toBe("site dr-lurie + task draft_writer");
  });
});
