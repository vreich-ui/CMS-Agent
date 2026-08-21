// T12.23 — the classifier prompt must be generated from the builder, not restated beside it.
//
// The prompt named seven section types inline while the deterministic builder grew to fourteen. The
// drift was invisible: block_classifier answered, its suggestions validated, and the run looked
// healthy — it simply could never offer any type added after the prompt was written, so the node
// whose entire job is rescuing a declined block kept offering the shapes the mapper had already
// rejected. Nothing failed. That is exactly why it lasted.
import { describe, expect, it } from "vitest";

import { SUPPORTED_SECTION_TYPES } from "../../../src/agent/capture/engine/map.mjs";
import { captureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";

const classifier = () => {
  const node = captureConductorNodes.find((entry) => entry.id === "block_classifier");
  if (!node) throw new Error("block_classifier is not in the capture conductor workflow");
  return node;
};

describe("block_classifier vocabulary", () => {
  it("offers EVERY type the deterministic builder can build", () => {
    const prompt = classifier().prompt ?? "";
    for (const type of SUPPORTED_SECTION_TYPES) {
      expect(prompt, `${type} builds but is not offered to the classifier`).toContain(type);
    }
  });

  it("has actually grown past the original seven", () => {
    // A regression guard with a number in it, deliberately: if this set ever shrinks back, the
    // symptom downstream is silence, so the alarm has to be here.
    expect(SUPPORTED_SECTION_TYPES.size).toBeGreaterThanOrEqual(14);
    for (const structural of ["faq", "stats", "timeline", "steps", "testimonial", "checklist", "comparison_table"]) {
      expect(SUPPORTED_SECTION_TYPES.has(structural)).toBe(true);
    }
  });

  it("still tells the model its suggestions are advisory and re-validated", () => {
    // The widened vocabulary makes this MORE important, not less: more types means more ways for a
    // suggestion to be wrong, and the contract is what keeps a wrong one from being coerced through.
    const prompt = classifier().prompt ?? "";
    expect(prompt).toContain("ADVISORY");
    expect(prompt).toContain("rejected, never coerced");
    expect(prompt).toContain("never suggest a block outside the declined ledger");
  });

  it("warns that a structural type needs structural evidence", () => {
    expect(classifier().prompt ?? "").toContain("block.structure");
  });
});
