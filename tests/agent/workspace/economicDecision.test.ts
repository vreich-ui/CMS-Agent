import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionRecord } from "../../../src/agent/tools/toolTypes.js";
import { buildAuthoritativeEconomicDecision, isAuthoritativeEconomicStop, loadParentEconomicDecision, type EconomicDecision } from "../../../src/agent/workspace/economicDecision.js";

const NOW = "2026-09-10T10:00:00.000Z";
const output = (over: Record<string, unknown> = {}) => ({
  artifact: "monetization_strategy.v1",
  summary: "selected offer",
  selectedOffer: { id: "offer_1", payoutUsd: 10, currency: "USD" },
  offerRationale: "fit",
  commercialIntent: "commercial",
  // Deliberately fabricated. The engine must ignore every one of these decision fields.
  evFloor: { verdict: "pass", estimateBasis: "monetizer_data", estimatedRunCost: 999, expectedValue: 999, clusterRole: "unattached", supportingFor: null },
  ...over
});
const cost = (over: Record<string, unknown> = {}) => ({
  artifact: "run_cost_estimate.v1", estimatedRunCostUsd: 100, basis: "workflow_history", scope: "project", projectId: "dr-lurie", workflowId: "publishing_conductor", evaluatedAt: NOW,
  candidateRuns: 3, coverageRuns: 3, sampleRuns: 3, sampleRecords: 25, exclusionReasons: {}, observedRunCostsUsd: [90, 100, 120], rationale: "qualified", ...over
});
const traffic = (over: Record<string, unknown> = {}) => ({
  artifact: "traffic_estimate.v1", expectedMonthlyTraffic: 10, observedConversionRate: 0.1, basis: "tracking_engagement", windowDays: 90, sessions: 300, pageviews: 400, sampleRecords: 4,
  projectId: "dr-lurie", windowStart: "2026-06-12T10:00:00.000Z", windowEnd: NOW, rationale: "measured", ...over
});
const receipt = (over: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
  toolExecutionId: "tool_exec_1", runId: "run_1", nodeId: "monetization_strategy", toolId: "project.call_read_tool", startedAt: NOW, completedAt: NOW, status: "success",
  inputSummary: { projectId: "monetizer", tool: "search_offers", arguments: { clientProjectId: "dr-lurie" } },
  outputSummary: { ok: true, offers: [{ id: "offer_1", payoutUsd: 10, currency: "USD" }] }, riskLevel: "read", approvalStatus: "not_required", ...over
});
const decide = (over: Record<string, unknown> = {}) => buildAuthoritativeEconomicDecision({
  runId: "run_1", workflowId: "publishing_conductor", projectId: "dr-lurie", evaluatedAt: NOW,
  output: output(), costEstimate: cost(), trafficEstimate: traffic(), toolExecutions: [receipt()], ...over
});

describe("authoritative economic decisions", () => {
  it("bounds parent references and degrades repository failures without throwing", async () => {
    const getRun = vi.fn(async () => { throw new Error("temporary store outage"); });
    await expect(loadParentEconomicDecision({ supportingFor: "economic:parent", currentRunId: "run_1", projectId: "dr-lurie", getRun })).resolves.toEqual({ warning: "economic_parent_lookup_failed" });
    expect(getRun).toHaveBeenCalledWith("parent");
    getRun.mockClear();
    await expect(loadParentEconomicDecision({ supportingFor: `economic:${"x".repeat(161)}`, currentRunId: "run_1", projectId: "dr-lurie", getRun })).resolves.toEqual({ warning: "economic_parent_reference_invalid" });
    expect(getRun).not.toHaveBeenCalled();
  });
  it("recomputes verified low EV from recorded inputs and can earn a stop", () => {
    const decision = decide();
    expect(decision).toMatchObject({ outcome: "verified_stop", stop: true, reasonCode: "verified_ev_below_floor", authority: "cms_agent_engine" });
    expect(decision.calculation).toMatchObject({ runCostUsd: 100, expectedValueUsd: 10, floorUsd: 100, verdict: "block" });
    expect(isAuthoritativeEconomicStop(decision, new Date(NOW))).toBe(true);
  });

  it("does not let a schema-valid model-authored monetizer_data label halt without source evidence", () => {
    const decision = decide({ toolExecutions: [] });
    expect(decision).toMatchObject({ outcome: "advisory", stop: false, reasonCode: "offer_source_unverified" });
    expect(isAuthoritativeEconomicStop(decision, new Date(NOW))).toBe(false);
  });

  it("rejects tampered cost evidence and ignores tampered model arithmetic", () => {
    const badCost = decide({ costEstimate: cost({ estimatedRunCostUsd: 800 }) });
    expect(badCost).toMatchObject({ outcome: "advisory", reasonCode: "cost_evidence_unqualified", stop: false });
    const modelTamper = decide({ output: output({ evFloor: { verdict: "block", estimateBasis: "monetizer_data", estimatedRunCost: 800, expectedValue: 0, clusterRole: "unattached", supportingFor: null } }) });
    expect(modelTamper.calculation).toMatchObject({ runCostUsd: 100, expectedValueUsd: 10 });
  });

  it("rejects wrong-tenant and stale traffic windows", () => {
    expect(decide({ trafficEstimate: traffic({ projectId: "platform" }) })).toMatchObject({ outcome: "advisory", reasonCode: "traffic_evidence_unqualified" });
    expect(decide({ trafficEstimate: traffic({ windowEnd: "2026-09-08T00:00:00.000Z" }) })).toMatchObject({ outcome: "advisory", reasonCode: "traffic_evidence_unqualified" });
    expect(decide({ toolExecutions: [receipt({ inputSummary: { projectId: "monetizer", tool: "search_offers", arguments: { clientProjectId: "platform" } } })] })).toMatchObject({ outcome: "advisory", reasonCode: "offer_source_unverified" });
  });

  it("requires the source-derived Monetizer offer route and one exact source offer record", () => {
    expect(decide({ toolExecutions: [receipt({ inputSummary: { projectId: "platform", tool: "search_offers", arguments: { clientProjectId: "dr-lurie" } } })] })).toMatchObject({ outcome: "advisory", reasonCode: "offer_source_unverified" });
    expect(decide({ toolExecutions: [receipt({ inputSummary: { projectId: "monetizer", tool: "performance", arguments: { clientProjectId: "dr-lurie" } } })] })).toMatchObject({ outcome: "advisory", reasonCode: "offer_source_unverified" });
    expect(decide({ toolExecutions: [receipt({ inputSummary: { projectId: "monetizer", tool: "search_offers", arguments: { clientProjectId: "platform", note: "dr-lurie" } } })] })).toMatchObject({ outcome: "advisory", reasonCode: "offer_source_unverified" });
    expect(decide({ toolExecutions: [receipt({ outputSummary: { offers: [{ id: "offer_1", payoutUsd: 99, currency: "USD" }, { id: "offer_2", payoutUsd: 10, currency: "USD" }] } })] })).toMatchObject({ outcome: "advisory", reasonCode: "offer_source_unverified" });
  });

  it("rejects future or undersampled cost evidence", () => {
    expect(decide({ costEstimate: cost({ evaluatedAt: "2026-09-10T10:00:01.000Z" }) })).toMatchObject({ outcome: "advisory", reasonCode: "cost_evidence_unqualified" });
    expect(decide({ costEstimate: cost({ candidateRuns: 1, coverageRuns: 1, sampleRuns: 1, observedRunCostsUsd: [100] }) })).toMatchObject({ outcome: "advisory", reasonCode: "cost_evidence_unqualified" });
  });

  it("treats incompatible currency and assumed traffic as advisory", () => {
    const eur = output({ selectedOffer: { id: "offer_1", payoutUsd: 10, currency: "EUR" } });
    const eurReceipt = receipt({ outputSummary: { offers: [{ id: "offer_1", payoutUsd: 10, currency: "EUR" }] } });
    expect(decide({ output: eur, toolExecutions: [eurReceipt] })).toMatchObject({ outcome: "advisory", reasonCode: "currency_incompatible" });
    expect(decide({ trafficEstimate: traffic({ basis: "insufficient_data", observedConversionRate: null }) })).toMatchObject({ outcome: "advisory", reasonCode: "traffic_evidence_unqualified" });
  });

  it("requires a checkable parent for pass_via_cluster", () => {
    const support = output({ evFloor: { clusterRole: "supporting_asset", supportingFor: "economic:parent", verdict: "pass_via_cluster" } });
    expect(decide({ output: support })).toMatchObject({ outcome: "advisory", reasonCode: "cluster_parent_unverified" });
    const parent = buildAuthoritativeEconomicDecision({
      runId: "parent", workflowId: "publishing_conductor", projectId: "dr-lurie", evaluatedAt: NOW,
      output: output({ selectedOffer: { id: "offer_1", payoutUsd: 1_500, currency: "USD" } }),
      costEstimate: cost(), trafficEstimate: traffic(),
      toolExecutions: [receipt({ runId: "parent", outputSummary: { offers: [{ id: "offer_1", payoutUsd: 1_500, currency: "USD" }] } })]
    });
    expect(parent).toMatchObject({ decisionId: "economic:parent", outcome: "verified_proceed", stop: false });
    expect(decide({ output: support, parentEconomicDecision: parent })).toMatchObject({ outcome: "pass_via_cluster", stop: false, reasonCode: "verified_passing_parent_decision" });
    expect(decide({ output: support, initialInput: { parentEconomicDecision: parent } })).toMatchObject({ outcome: "advisory", reasonCode: "cluster_parent_unverified" });
    const tamperedParent = { ...parent, calculation: { ...parent.calculation, expectedValueUsd: 999_999 } } as EconomicDecision;
    expect(decide({ output: support, parentEconomicDecision: tamperedParent })).toMatchObject({ outcome: "advisory", reasonCode: "cluster_parent_unverified" });
  });

  it("respects an explicit proceed override and run-configured absolute margin", () => {
    expect(decide({ initialInput: { economicOverride: { decision: "proceed", overrideId: "operator_7", reason: "commission is credited at cluster settlement" } } })).toMatchObject({ outcome: "overridden", stop: false, reasonCode: "explicit_proceed_override:operator_7" });
    const margin = decide({ initialInput: { economicPolicy: { margin: { kind: "absolute", value: 25 } } } });
    expect(margin).toMatchObject({ margin: { kind: "absolute", value: 25, source: "run_policy" } });
    expect(margin.calculation.floorUsd).toBe(125);
  });

  it("refuses a tampered persisted calculation even if its authority labels remain", () => {
    const decision = decide();
    const tampered = { ...decision, calculation: { ...decision.calculation, expectedValueUsd: 0 } };
    expect(isAuthoritativeEconomicStop(tampered, new Date(NOW))).toBe(false);
  });

  it("does not reuse a verified stop after its evidence window has gone stale", () => {
    expect(isAuthoritativeEconomicStop(decide(), new Date("2026-09-11T10:00:00.001Z"))).toBe(false);
  });
});
