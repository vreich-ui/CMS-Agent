import { describe, expect, it } from "vitest";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { evaluateNodeSkip } from "../../../src/agent/workspace/skipPredicates.js";
import type { EconomicDecision } from "../../../src/agent/workspace/economicDecision.js";

const economicGateNode = () => listWorkspaceNodes().find((node) => node.id === "reader_insight")!;
const decision = (over: Partial<EconomicDecision> = {}): EconomicDecision => ({
  artifact: "economic_decision.v1", authority: "cms_agent_engine", decisionId: "economic:run_1", runId: "run_1", workflowId: "publishing_conductor", projectId: "dr-lurie", evaluatedAt: "2026-09-10T10:00:00.000Z",
  outcome: "verified_stop", stop: true, reasonCode: "verified_ev_below_floor", currency: "USD", margin: { kind: "multiplier", value: 1, source: "default" }, clusterRole: "unattached", supportingFor: null,
  offerSource: { toolExecutionId: "tool_1", sourceProjectId: "monetizer", tool: "offer.list", offerReference: "offer_1" },
  costEvidence: { artifact: "run_cost_estimate.v1", estimatedRunCostUsd: 100, basis: "workflow_history", scope: "project", projectId: "dr-lurie", workflowId: "publishing_conductor", evaluatedAt: "2026-09-10T10:00:00.000Z", candidateRuns: 2, coverageRuns: 2, sampleRuns: 2, sampleRecords: 20, exclusionReasons: {}, observedRunCostsUsd: [100, 120], rationale: "qualified" },
  trafficEvidence: { artifact: "traffic_estimate.v1", expectedMonthlyTraffic: 10, observedConversionRate: 0.1, basis: "tracking_engagement", windowDays: 90, sessions: 300, pageviews: 400, sampleRecords: 3, projectId: "dr-lurie", windowStart: "2026-06-12T10:00:00.000Z", windowEnd: "2026-09-10T10:00:00.000Z", rationale: "measured" },
  calculation: { artifact: "ev_floor.v1", runCostUsd: 100, floorMultiplier: 1, floorUsd: 100, payoutUsd: 10, conversionRate: 0.1, estimatedVolume: 10, expectedValueUsd: 10, breakEvenConversions: 10, meetsFloor: false, runCostBasis: "workflow_history", revenueBasis: "monetizer_data", volumeBasis: "tracking_engagement", estimateBasis: "monetizer_data", verdict: "block", rationale: "computed" },
  notes: [], ...over
});

describe("ev_floor_blocked consumes only the engine-owned run decision", () => {
  it("fires for an internally consistent verified stop", () => {
    const verdict = evaluateNodeSkip(economicGateNode(), { economicDecision: decision(), stageOutputs: { monetization_strategy: { evFloor: { verdict: "pass" } } }, now: new Date("2026-09-10T10:00:00.000Z") })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toContain("economicDecision.authority: cms_agent_engine");
  });

  it("ignores schema-valid fabricated model provenance and verdict labels", () => {
    const modelOutput = { artifact: "monetization_strategy.v1", evFloor: { verdict: "block", estimateBasis: "monetizer_data", expectedValue: 0, estimatedRunCost: 800 } };
    const verdict = evaluateNodeSkip(economicGateNode(), { stageOutputs: { monetization_strategy: modelOutput } })!;
    expect(verdict.skip).toBe(false);
    expect(verdict.basis).toEqual(["economicDecision: absent"]);
  });

  it("does not fire for advisory, overridden or cluster-pass decisions", () => {
    for (const economicDecision of [
      decision({ outcome: "advisory", stop: false, reasonCode: "offer_source_unverified" }),
      decision({ outcome: "overridden", stop: false, reasonCode: "explicit_proceed_override:x" }),
      decision({ outcome: "pass_via_cluster", stop: false, reasonCode: "verified_passing_parent_decision", clusterRole: "supporting_asset", supportingFor: "economic:parent" })
    ]) expect(evaluateNodeSkip(economicGateNode(), { economicDecision, now: new Date("2026-09-10T10:00:00.000Z") })!.skip).toBe(false);
  });

  it("does not fire when stored calculation or tenant evidence was tampered", () => {
    const arithmetic = decision({ calculation: { ...decision().calculation, expectedValueUsd: 0 } });
    expect(evaluateNodeSkip(economicGateNode(), { economicDecision: arithmetic, now: new Date("2026-09-10T10:00:00.000Z") })!.skip).toBe(false);
    const tenant = decision({ costEvidence: { ...decision().costEvidence!, projectId: "platform" } });
    expect(evaluateNodeSkip(economicGateNode(), { economicDecision: tenant, now: new Date("2026-09-10T10:00:00.000Z") })!.skip).toBe(false);
  });
});
