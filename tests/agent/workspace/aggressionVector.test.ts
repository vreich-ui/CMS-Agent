import { describe, expect, it } from "vitest";
import {
  AGGRESSION_DIALS,
  buildPlacementResolution,
  computeAggressionTarget,
  extractPlacementSignals,
  readPlacementTarget,
  resolveAggressionVector
} from "../../../src/agent/workspace/aggressionVector.js";
import { reduceContract, type ContractSource } from "../../../src/agent/workspace/contractReduction.js";

const SOURCE: ContractSource = { tool: "object_contract", fetchedAtISO: "2026-08-10T00:00:00.000Z", fingerprint: "fp_test" };
const FULL_CEILING = { claim_strength: 0.6, urgency: 0.3, emotional_agitation: 0.9, cta_density: 0.5 };

describe("§2.16 — computeAggressionTarget (the deterministic mapping, never hand-set)", () => {
  it("cold search + problem-aware lands soft: low claim_strength and urgency", () => {
    const { target } = computeAggressionTarget("cold_search", "problem_aware");
    // base {0.3, 0.2, 0.4, 0.2} shifted -0.1 for cold traffic.
    expect(target).toEqual({ claim_strength: 0.2, urgency: 0.1, emotional_agitation: 0.3, cta_density: 0.1 });
  });

  it("warm email + product-aware lands assertive: high claim_strength and cta_density", () => {
    const { target } = computeAggressionTarget("email", "product_aware");
    // base {0.7, 0.6, 0.5, 0.6} shifted +0.1 for warm traffic.
    expect(target).toEqual({ claim_strength: 0.8, urgency: 0.7, emotional_agitation: 0.6, cta_density: 0.7 });
  });

  it("clamps to the declared 0-1 scale (most_aware + warm would exceed 1 unclamped)", () => {
    const { target } = computeAggressionTarget("newsletter", "most_aware");
    expect(target.urgency).toBe(0.9);
    expect(target.cta_density).toBe(0.9);
    for (const dial of AGGRESSION_DIALS) {
      expect(target[dial]).toBeGreaterThanOrEqual(0);
      expect(target[dial]).toBeLessThanOrEqual(1);
    }
    const floor = computeAggressionTarget("cold_search", "unaware").target;
    expect(floor.urgency).toBe(0); // 0.1 - 0.1 clamps at the floor, never negative
  });

  it("is deterministic and tolerant of spelling: same inputs, same vector", () => {
    expect(computeAggressionTarget("Paid Search", "Solution-Aware").target).toEqual(computeAggressionTarget("paid_search", "solution_aware").target);
  });

  it("normalizes an unrecognized value to the most conservative bucket and says so in the rationale", () => {
    const computed = computeAggressionTarget("carrier_pigeon", "enlightened");
    expect(computed.trafficTemperature).toBe("cold");
    expect(computed.normalizedAwarenessStage).toBe("unaware");
    expect(computed.rationale).toContain("carrier_pigeon");
    expect(computed.rationale).toContain("most conservative");
    expect(computed.target).toEqual(computeAggressionTarget("cold_search", "unaware").target);
  });
});

describe("§2.16 — resolveAggressionVector (min(ceiling, target) componentwise; absent ceiling is a BLOCKER)", () => {
  const target = { claim_strength: 0.8, urgency: 0.2, emotional_agitation: 0.5, cta_density: 0.7 };
  const contractWith = (aggressionCeiling: unknown) => reduceContract({ object_type: "content_item", ...(aggressionCeiling === undefined ? {} : { aggression_ceiling: aggressionCeiling }) }, SOURCE, "content_item");

  it("resolves min componentwise — each dial independently takes whichever of ceiling/target is lower", () => {
    const resolution = resolveAggressionVector(target, contractWith(FULL_CEILING));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.resolved).toEqual({ claim_strength: 0.6, urgency: 0.2, emotional_agitation: 0.5, cta_density: 0.5 });
      expect(resolution.ceiling).toEqual(FULL_CEILING);
      expect(resolution.target).toEqual(target);
    }
  });

  it("an ABSENT ceiling is a typed blocker, never a default (Wolf's explicit decision)", () => {
    const resolution = resolveAggressionVector(target, contractWith(undefined));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.blocker.code).toBe("aggression_ceiling_missing");
      expect(resolution.blocker.message).toContain("blocker, not a default");
    }
  });

  it("a PARTIAL ceiling (one dial missing) blocks too — a partial ceiling is not a ceiling", () => {
    const { cta_density: _dropped, ...partial } = FULL_CEILING;
    const resolution = resolveAggressionVector(target, contractWith(partial));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.blocker.code).toBe("aggression_ceiling_invalid");
      expect(resolution.blocker.message).toContain("cta_density");
    }
  });

  it("a non-numeric or out-of-range dial blocks with the offending dials named", () => {
    const resolution = resolveAggressionVector(target, contractWith({ ...FULL_CEILING, urgency: "high", claim_strength: 1.5 }));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.blocker.code).toBe("aggression_ceiling_invalid");
      expect(resolution.blocker.message).toContain("claim_strength");
      expect(resolution.blocker.message).toContain("urgency");
    }
  });

  it("a non-object ceiling blocks rather than being coerced", () => {
    const resolution = resolveAggressionVector(target, contractWith("aggressive"));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.blocker.code).toBe("aggression_ceiling_invalid");
  });
});

describe("§2.16 — ceiling carrier: contractReduction extracts aggression_ceiling from the raw contract", () => {
  it("extracts aggression_ceiling (snake_case) as a first-class reduced field, not unmapped leftovers", () => {
    const reduced = reduceContract({ object_type: "content_item", aggression_ceiling: FULL_CEILING }, SOURCE, "content_item");
    expect(reduced.aggressionCeiling).toEqual(FULL_CEILING);
    expect(reduced.unmapped?.aggression_ceiling).toBeUndefined();
  });

  it("accepts the camelCase spelling too", () => {
    const reduced = reduceContract({ object_type: "content_item", aggressionCeiling: FULL_CEILING }, SOURCE, "content_item");
    expect(reduced.aggressionCeiling).toEqual(FULL_CEILING);
  });

  it("omits the field entirely when the contract does not carry it (the absent-ceiling blocker's trigger)", () => {
    const reduced = reduceContract({ object_type: "content_item" }, SOURCE, "content_item");
    expect("aggressionCeiling" in reduced).toBe(false);
  });
});

describe("§2.16 — placement signal extraction and target read-back", () => {
  it("reads trafficSource/awarenessStage from a stage output, its contentSource, or the initial input — first hit wins", () => {
    expect(extractPlacementSignals({ trafficSource: "email", awarenessStage: "most_aware" })).toEqual({ trafficSource: "email", awarenessStage: "most_aware" });
    expect(extractPlacementSignals({ contentSource: { traffic_source: "seo", awareness_stage: "unaware" } })).toEqual({ trafficSource: "seo", awarenessStage: "unaware" });
    // Earlier carrier wins; a later carrier only fills what is still missing.
    expect(extractPlacementSignals({ trafficSource: "email" }, { trafficSource: "seo", awarenessStage: "product_aware" })).toEqual({ trafficSource: "email", awarenessStage: "product_aware" });
    expect(extractPlacementSignals("Draft this", undefined)).toEqual({});
  });

  it("buildPlacementResolution emits the full placement_resolution.v1 artifact and readPlacementTarget reads it back", () => {
    const resolution = buildPlacementResolution("email", "product_aware");
    expect(resolution.artifact).toBe("placement_resolution.v1");
    expect(resolution.summary).toContain("0-1 scale");
    expect(readPlacementTarget(resolution)).toEqual(resolution.target);
  });

  it("readPlacementTarget refuses mock placeholders and malformed targets", () => {
    const resolution = buildPlacementResolution("email", "product_aware");
    expect(readPlacementTarget({ ...resolution, dryRun: true })).toBeUndefined(); // a mock artifact never feeds a real resolution
    expect(readPlacementTarget({ ...resolution, artifact: "something_else.v1" })).toBeUndefined();
    expect(readPlacementTarget({ ...resolution, target: { ...resolution.target, urgency: "high" } })).toBeUndefined();
    expect(readPlacementTarget({ ...resolution, target: { ...resolution.target, urgency: 3 } })).toBeUndefined();
    expect(readPlacementTarget(undefined)).toBeUndefined();
  });
});
