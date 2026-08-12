import { describe, expect, it } from "vitest";
import { computeEvFloor } from "../../../src/agent/workspace/evFloor.js";

describe("computeEvFloor", () => {
  it("computes floorUsd as runCostUsd x floorMultiplier (default 1, break-even)", () => {
    const result = computeEvFloor({ runCostUsd: 5.56 });

    expect(result.floorUsd).toBe(5.56);
    expect(result.floorMultiplier).toBe(1);
    expect(result.runCostUsd).toBe(5.56);
  });

  it("never fabricates the run cost figure the way the live defect did ($250 invented vs $5.56 actual)", () => {
    // The bug this module fixes: monetization_strategy invented estimatedRunCost:$250 when the real
    // run cost was $5.56. This module only ever uses the runCostUsd it is given — asserting the exact
    // real figure survives unchanged is the regression guard against silently substituting a guess.
    const result = computeEvFloor({ runCostUsd: 5.56, payoutUsd: 40, conversionRate: 0.2, estimatedVolume: 5 });

    expect(result.runCostUsd).toBe(5.56);
    expect(result.rationale).toContain("real — never invented");
  });

  it("applies a floorMultiplier above 1 to demand margin above break-even", () => {
    const result = computeEvFloor({ runCostUsd: 10, floorMultiplier: 1.5 });

    expect(result.floorUsd).toBe(15);
  });

  it("computes breakEvenConversions from payoutUsd alone, independent of conversionRate/estimatedVolume", () => {
    const result = computeEvFloor({ runCostUsd: 20, payoutUsd: 8 });

    expect(result.breakEvenConversions).toBe(2.5);
    expect(result.expectedValueUsd).toBeNull();
    expect(result.meetsFloor).toBeNull();
  });

  it("leaves breakEvenConversions null (not zero) when payoutUsd is omitted", () => {
    const result = computeEvFloor({ runCostUsd: 20 });

    expect(result.breakEvenConversions).toBeNull();
    expect(result.payoutUsd).toBeNull();
  });

  it("computes expectedValueUsd only when payoutUsd, conversionRate, and estimatedVolume are all supplied", () => {
    const result = computeEvFloor({ runCostUsd: 5, payoutUsd: 20, conversionRate: 0.1, estimatedVolume: 100 });

    expect(result.expectedValueUsd).toBe(200);
    expect(result.meetsFloor).toBe(true);
  });

  it("reports meetsFloor false when expectedValueUsd is below floorUsd", () => {
    const result = computeEvFloor({ runCostUsd: 100, payoutUsd: 20, conversionRate: 0.05, estimatedVolume: 10 });

    expect(result.expectedValueUsd).toBe(10);
    expect(result.meetsFloor).toBe(false);
  });

  it("is pure and total for an empty input object (all optional fields omitted)", () => {
    const result = computeEvFloor({ runCostUsd: 0 });

    expect(result.floorUsd).toBe(0);
    expect(result.payoutUsd).toBeNull();
    expect(result.conversionRate).toBeNull();
    expect(result.estimatedVolume).toBeNull();
    expect(result.expectedValueUsd).toBeNull();
    expect(result.breakEvenConversions).toBeNull();
    expect(result.meetsFloor).toBeNull();
  });

  it("treats non-finite or negative runCostUsd as 0 rather than propagating NaN", () => {
    const result = computeEvFloor({ runCostUsd: Number.NaN });

    expect(result.runCostUsd).toBe(0);
    expect(result.floorUsd).toBe(0);
  });
});
