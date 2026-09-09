import { describe, expect, it } from "vitest";
import { evaluateNodeSkip, EV_FLOOR_BLOCKED_PREDICATE } from "../../../src/agent/workspace/skipPredicates.js";
import { computeEvFloor } from "../../../src/agent/workspace/evFloor.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { gatedMetadata } from "../../../src/agent/workspace/nodeGatingSeed.js";

// ACCEPTANCE 3, 4 and 5 (EV-floor brief, 2026-09-08).
//
// Test 3 is written first and is the one that protects production: with the Monetizer connection down
// (expected, operator 2026-09-08) expectedCommission is 0 on every money run, so a naive
// `verdict === "block"` predicate would stop EVERY money-class run the moment it deployed. The
// predicate must fire only on an EARNED block.

const briefArchitect = () => {
  const node = listWorkspaceNodes().find((candidate) => candidate.id === "brief_architect")!;
  return { id: node.id, dependsOn: node.dependsOn, metadata: gatedMetadata(node) };
};

const monetizationOutput = (evFloor: unknown) => ({ artifact: "monetization_strategy.v1", summary: "s", selectedOffer: null, offerRationale: "r", commercialIntent: "commercial", evFloor });

describe("ev_floor_blocked — a block stops a run only when it was EARNED", () => {
  it("3. does NOT fire on a block computed from stated assumptions — the run proceeds (this is the one that protects production)", () => {
    // The live shape today: Monetizer down, so no payout at all, floor missed on assumptions.
    const evFloor = computeEvFloor({ runCostUsd: 3.86, floorMultiplier: 1.25, payoutUsd: 20, conversionRate: 0.0001, estimatedVolume: 400, runCostBasis: "workflow_history" });

    expect(evFloor.verdict).toBe("block");
    expect(evFloor.estimateBasis).toBe("mixed");

    const verdict = evaluateNodeSkip(briefArchitect(), { initialInput: { contentClass: "money" }, stageOutputs: { monetization_strategy: monetizationOutput(evFloor) } })!;

    expect(verdict.skip).toBe(false);
    // The facts it decided on are on the record even when nothing fired — "why did this RUN" is as
    // answerable as "why did this not", which is rule 2 read in the other direction.
    expect(verdict.basis).toContain("evFloor.verdict: block");
    expect(verdict.basis).toContain("evFloor.estimateBasis: mixed");
  });

  it("3b. does not fire on estimateBasis stated_assumption either, nor on an absent basis", () => {
    const assumed = computeEvFloor({ runCostUsd: 800, floorMultiplier: 1.25, payoutUsd: 20, conversionRate: 0.01, estimatedVolume: 400 });
    expect(assumed.verdict).toBe("block");
    expect(assumed.estimateBasis).toBe("stated_assumption");
    expect(evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(assumed) } })!.skip).toBe(false);

    const noBasis = { artifact: "ev_floor.v1", verdict: "block" };
    expect(evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(noBasis) } })!.skip).toBe(false);
  });

  it("4. fires when the block came from live Monetizer data, and names the predicate that decided", () => {
    const evFloor = computeEvFloor({ runCostUsd: 3.86, floorMultiplier: 1.25, payoutUsd: 20, conversionRate: 0.001, estimatedVolume: 100, runCostBasis: "workflow_history", revenueBasis: "monetizer_data", volumeBasis: "tracking_engagement" });

    expect(evFloor.verdict).toBe("block");
    expect(evFloor.estimateBasis).toBe("monetizer_data");

    const verdict = evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(evFloor) } })!;

    expect(verdict.skip).toBe(true);
    expect(verdict.predicate?.when).toBe(EV_FLOOR_BLOCKED_PREDICATE);
    expect(verdict.basis).toContain("evFloor.verdict: block");
    expect(verdict.basis).toContain("evFloor.estimateBasis: monetizer_data");
  });

  it("4b. a passing floor on live data proceeds — the predicate reads the verdict, not the basis alone", () => {
    const evFloor = computeEvFloor({ runCostUsd: 3.86, payoutUsd: 40, conversionRate: 0.05, estimatedVolume: 400, runCostBasis: "workflow_history", revenueBasis: "monetizer_data", volumeBasis: "tracking_engagement" });

    expect(evFloor.verdict).toBe("proceed");
    expect(evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(evFloor) } })!.skip).toBe(false);
  });

  it("5. an unreadable, absent or unknown floor RUNS — fail-open, always", () => {
    const node = briefArchitect();
    expect(evaluateNodeSkip(node, { stageOutputs: {} })!.skip).toBe(false);
    expect(evaluateNodeSkip(node, { stageOutputs: { monetization_strategy: monetizationOutput(undefined) } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node, { stageOutputs: { monetization_strategy: monetizationOutput("not an object") } })!.skip).toBe(false);
    // "unknown" is not "block": a floor that could not be computed must never be read as a refusal.
    const unknown = computeEvFloor({ runCostUsd: 3.86, runCostBasis: "workflow_history", revenueBasis: "monetizer_data", volumeBasis: "tracking_engagement" });
    expect(unknown.verdict).toBe("unknown");
    expect(evaluateNodeSkip(node, { stageOutputs: { monetization_strategy: monetizationOutput(unknown) } })!.skip).toBe(false);
  });

  it("5b. a mock placeholder is never evidence — a dry-run fixture cannot halt a run", () => {
    const evFloor = computeEvFloor({ runCostUsd: 3.86, payoutUsd: 20, conversionRate: 0.001, estimatedVolume: 100, runCostBasis: "workflow_history", revenueBasis: "monetizer_data", volumeBasis: "tracking_engagement" });
    const placeholder = { ...monetizationOutput(evFloor), dryRun: true };

    expect(evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: placeholder } })!.skip).toBe(false);
  });
});

describe("computeEvFloor's provenance fields — a historical mean is not a stated assumption", () => {
  it("names runCostBasis on the artifact and derives estimateBasis from BOTH sides", () => {
    const measuredCostOnly = computeEvFloor({ runCostUsd: 3.86, runCostBasis: "workflow_history", payoutUsd: 20, conversionRate: 0.1, estimatedVolume: 10 });
    expect(measuredCostOnly.runCostBasis).toBe("workflow_history");
    expect(measuredCostOnly.estimateBasis).toBe("mixed");

    const nothingMeasured = computeEvFloor({ runCostUsd: 800 });
    expect(nothingMeasured.runCostBasis).toBe("no_history");
    expect(nothingMeasured.estimateBasis).toBe("stated_assumption");

    // A caller CLAIMING monetizer_data without the three figures has measured nothing on that side.
    const hollowClaim = computeEvFloor({ runCostUsd: 3.86, runCostBasis: "workflow_history", revenueBasis: "monetizer_data", volumeBasis: "tracking_engagement" });
    expect(hollowClaim.estimateBasis).toBe("mixed");
  });
});

// THE LIVE STORE'S OWN evFloor SHAPE (verified against the live node 2026-09-08). It predates
// ev_floor.v1 and carries a cluster-level model the tool has no equivalent for: clusterRole,
// supportingFor, and a third verdict `pass_via_cluster`. The predicate reads only `verdict` and
// `estimateBasis`, which both shapes spell identically — these tests pin that, and that the recorded
// reason quotes the live shape's numbers rather than printing "undefined" into an audit record.
describe("the live monetization_strategy evFloor shape", () => {
  const liveEvFloor = (over: Record<string, unknown> = {}) => ({
    expectedCommission: 20, currency: "USD", assumedConversionRate: 0.0001, expectedMonthlyTraffic: 400,
    estimatedRunCost: 3.86, estimatedRunCostBasis: "workflow_history", margin: { kind: "multiplier", value: 1.25 },
    expectedValue: 0.8, floorPassed: false, clusterRole: "unattached", supportingFor: null,
    verdict: "block", rationale: "r", estimateBasis: "monetizer_data", ...over
  });

  it("fires on an earned block and quotes the live field names in the reason", () => {
    const verdict = evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(liveEvFloor()) } })!;

    expect(verdict.skip).toBe(true);
    // The figures ride in `basis`, not the prose: brief_architect's seeded reason string wins over the
    // computed one, so a number interpolated into a reason is a number that may never be recorded.
    expect(verdict.basis).toContain("evFloor.expectedValue: 0.8");
    expect(verdict.basis).toContain("evFloor.runCost: 3.86");
    expect(verdict.basis.join(" ")).not.toContain("undefined");
  });

  it("does not fire on the same block once the basis is honest about the monetizer being down", () => {
    for (const estimateBasis of ["mixed", "stated_assumption"]) {
      expect(evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(liveEvFloor({ estimateBasis })) } })!.skip).toBe(false);
    }
  });

  it("does not fire on pass or pass_via_cluster — a sub-floor supporting asset is not a block", () => {
    for (const verdict of ["pass", "pass_via_cluster"]) {
      expect(evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(liveEvFloor({ verdict, clusterRole: "supporting_asset", supportingFor: "money_page_1" })) } })!.skip).toBe(false);
    }
  });

  it("renders a figure neither shape carries as \"not stated\", never as a fabricated 0", () => {
    const noNumbers = { verdict: "block", estimateBasis: "monetizer_data" };
    const decided = evaluateNodeSkip(briefArchitect(), { stageOutputs: { monetization_strategy: monetizationOutput(noNumbers) } })!;

    expect(decided.skip).toBe(true);
    expect(decided.basis).toContain("evFloor.expectedValue: not stated");
    expect(decided.basis).toContain("evFloor.runCost: not stated");
  });
});
