import { describe, expect, it } from "vitest";
import { suggestBudgetUsd } from "../../../src/agent/execution/runners/budgetGuard.js";

describe("suggestBudgetUsd — the raise a budget_exceeded error argues for", () => {
  it("rounds 50%-headroom-on-the-attempt up to the nearest $0.50 (the artifact_plan worked example)", () => {
    // The exact figures from the reported artifact_plan incident: estimated spend $1.70999 plus
    // ~$0.325835 for the upcoming turn against a $2 ceiling. (1.70999 + 0.325835) * 1.5 = 3.0537375,
    // which rounds UP to the next $0.50 increment: $3.50.
    expect(suggestBudgetUsd(1.70999, 0.325835)).toBe(3.5);
  });

  it("is always >= 1.5x what this attempt actually needed, never a bare break-even figure", () => {
    // spent + next-turn = 1 exactly; 1.5x = 1.5, already a $0.50 increment — must not round further.
    expect(suggestBudgetUsd(0.5, 0.5)).toBe(1.5);
    // 1.5x = 1.2 — rounds up to the next $0.50 increment, $1.50, not down to $1.00.
    expect(suggestBudgetUsd(0.4, 0.4)).toBe(1.5);
  });

  it("never suggests a figure below what a $0 spend already needs for one turn", () => {
    expect(suggestBudgetUsd(0, 0.01)).toBe(0.5);
  });
});
