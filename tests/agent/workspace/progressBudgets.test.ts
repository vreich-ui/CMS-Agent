import { describe, expect, it } from "vitest";
import {
  checkQualityRevisionBudget,
  checkSpecialistRoundBudget,
  MAX_QUALITY_REVISIONS_PER_ARTIFACT,
  MAX_SPECIALIST_ROUNDS_PER_CAPABILITY
} from "../../../src/agent/workspace/progressBudgets.js";

// R2 — the other two "Initial limits" the programme spec names, as generic, tested, ready
// primitives. See progressBudgets.ts's own header for what is (honestly) not yet wired to a caller.

describe("R2 — checkQualityRevisionBudget", () => {
  it("allows revisions up to MAX_QUALITY_REVISIONS_PER_ARTIFACT (2), then refuses", () => {
    let budgets: Record<string, number> | undefined;
    const first = checkQualityRevisionBudget({ qualityRevisions: budgets }, "artifact-1");
    expect(first.check).toEqual({ allowed: true, nextCount: 1, limit: MAX_QUALITY_REVISIONS_PER_ARTIFACT });
    budgets = first.qualityRevisions;

    const second = checkQualityRevisionBudget({ qualityRevisions: budgets }, "artifact-1");
    expect(second.check).toEqual({ allowed: true, nextCount: 2, limit: MAX_QUALITY_REVISIONS_PER_ARTIFACT });
    budgets = second.qualityRevisions;

    const third = checkQualityRevisionBudget({ qualityRevisions: budgets }, "artifact-1");
    expect(third.check).toEqual({ allowed: false, count: 2, limit: MAX_QUALITY_REVISIONS_PER_ARTIFACT });
  });

  it("tracks each artifact id independently", () => {
    const one = checkQualityRevisionBudget(undefined, "artifact-a");
    const two = checkQualityRevisionBudget({ qualityRevisions: one.qualityRevisions }, "artifact-b");
    expect(two.check).toEqual({ allowed: true, nextCount: 1, limit: MAX_QUALITY_REVISIONS_PER_ARTIFACT });
    expect(two.qualityRevisions).toEqual({ "artifact-a": 1, "artifact-b": 1 });
  });

  it("never mutates the caller's input map", () => {
    const budgets = { "artifact-1": 1 };
    checkQualityRevisionBudget({ qualityRevisions: budgets }, "artifact-1");
    expect(budgets).toEqual({ "artifact-1": 1 });
  });
});

describe("R2 — checkSpecialistRoundBudget", () => {
  it("allows exactly one added round per capability, then refuses", () => {
    const first = checkSpecialistRoundBudget(undefined, "pdf_render");
    expect(first.check).toEqual({ allowed: true, nextCount: 1, limit: MAX_SPECIALIST_ROUNDS_PER_CAPABILITY });

    const second = checkSpecialistRoundBudget({ specialistRounds: first.specialistRounds }, "pdf_render");
    expect(second.check).toEqual({ allowed: false, count: 1, limit: MAX_SPECIALIST_ROUNDS_PER_CAPABILITY });
  });

  it("tracks each capability id independently", () => {
    const one = checkSpecialistRoundBudget(undefined, "pdf_render");
    const two = checkSpecialistRoundBudget({ specialistRounds: one.specialistRounds }, "asset_search");
    expect(two.check).toEqual({ allowed: true, nextCount: 1, limit: MAX_SPECIALIST_ROUNDS_PER_CAPABILITY });
    expect(two.specialistRounds).toEqual({ pdf_render: 1, asset_search: 1 });
  });
});
