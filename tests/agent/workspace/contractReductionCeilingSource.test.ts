import { describe, expect, it } from "vitest";
import { extractAggressionCeiling, reduceContract } from "../../../src/agent/workspace/contractReduction.js";

// S3 item 3 — platform PR #583 exposes the client ceiling at contract.aggression_ceiling AND
// contract.publish_policy.aggression_ceiling. The reducer must see either.
const CEILING = { claim_strength: 0.6, urgency: 0.5, emotional_agitation: 0.4, cta_density: 0.5 };

describe("contract reduction: aggression ceiling source", () => {
  it("reads the top-level aggression_ceiling", () => {
    expect(extractAggressionCeiling({ aggression_ceiling: CEILING })).toEqual(CEILING);
  });
  it("falls back to publish_policy.aggression_ceiling when the top-level field is absent", () => {
    expect(extractAggressionCeiling({ publish_policy: { gated: true, aggression_ceiling: CEILING } })).toEqual(CEILING);
    expect(extractAggressionCeiling({ publishPolicy: { aggressionCeiling: CEILING } })).toEqual(CEILING);
  });
  it("top-level wins over the policy-scoped copy; neither present → undefined", () => {
    const top = { ...CEILING, urgency: 0.1 };
    expect(extractAggressionCeiling({ aggression_ceiling: top, publish_policy: { aggression_ceiling: CEILING } })).toEqual(top);
    expect(extractAggressionCeiling({ publish_policy: { gated: true } })).toBeUndefined();
  });
  it("reduceContract carries the policy-scoped ceiling into ReducedContract.aggressionCeiling", () => {
    const reduced = reduceContract({ object_type: "content_item", body_schema: { type: "object" }, publish_policy: { gated: true, aggression_ceiling: CEILING } }, { tool: "object_contract", fetchedAtISO: "2026-08-18T00:00:00.000Z", fingerprint: "test" }, "content_item");
    expect(reduced.aggressionCeiling).toEqual(CEILING);
  });
});
