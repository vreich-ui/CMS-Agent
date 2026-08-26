import { describe, expect, it } from "vitest";
import { canonicalStringify, computeTemplateContentHash, resolveTemplateVersion } from "../../../src/agent/library/templateLibraryRecord.js";

describe("canonicalStringify", () => {
  it("is independent of object key order but preserves array order", () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe(canonicalStringify({ a: 1, b: 2 }));
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
  });

  it("sorts nested object keys recursively", () => {
    const left = canonicalStringify({ outer: { z: 1, a: { y: 2, b: 1 } } });
    const right = canonicalStringify({ outer: { a: { b: 1, y: 2 }, z: 1 } });
    expect(left).toBe(right);
  });
});

describe("computeTemplateContentHash", () => {
  const base = { objectType: "section_template" as const, recipe: { name: "Hero", blueprint: { type: "hero", data: {} } }, sectionTypesUsed: ["hero"] };

  it("is a deterministic function of its inputs — two identical inputs produce identical hashes", () => {
    expect(computeTemplateContentHash(base)).toBe(computeTemplateContentHash(structuredClone(base)));
  });

  it("is independent of sectionTypesUsed ordering", () => {
    const a = computeTemplateContentHash({ ...base, sectionTypesUsed: ["hero", "faq"] });
    const b = computeTemplateContentHash({ ...base, sectionTypesUsed: ["faq", "hero"] });
    expect(a).toBe(b);
  });

  it("changes when the recipe body changes", () => {
    const changed = computeTemplateContentHash({ ...base, recipe: { ...base.recipe, name: "Hero v2" } });
    expect(changed).not.toBe(computeTemplateContentHash(base));
  });

  it("changes when objectType changes, even with an identical recipe", () => {
    const changed = computeTemplateContentHash({ ...base, objectType: "template" });
    expect(changed).not.toBe(computeTemplateContentHash(base));
  });
});

describe("resolveTemplateVersion", () => {
  it("mints version 1 when nothing exists yet", () => {
    expect(resolveTemplateVersion({ contentHash: "abc" })).toEqual({ outcome: "minted", version: 1 });
  });

  it("leaves the latest version unchanged when the content hash matches", () => {
    expect(resolveTemplateVersion({ existingLatest: { version: 3, contentHash: "abc" }, contentHash: "abc" })).toEqual({ outcome: "unchanged", version: 3 });
  });

  it("mints the NEXT version when the content hash differs, never skipping or reusing a number", () => {
    expect(resolveTemplateVersion({ existingLatest: { version: 3, contentHash: "abc" }, contentHash: "xyz" })).toEqual({ outcome: "minted", version: 4 });
  });
});
