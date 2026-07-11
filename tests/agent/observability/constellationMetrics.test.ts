import { describe, expect, it } from "vitest";
import { aggregateAgentMetrics, aggregateRelationshipMetrics, buildAttentionItems, buildConstellationSummary, deriveExecutionEdges } from "../../../src/agent/observability/constellationMetrics.js";
import { emptyInputs, fixtureNodes, partialInputs, populatedInputs } from "./constellationFixtures.js";

const GENERATED_AT = "2026-07-01T12:00:00.000Z";

describe("deriveExecutionEdges", () => {
  it("derives one edge per dependsOn entry", () => {
    expect(deriveExecutionEdges(fixtureNodes())).toEqual([
      { kind: "execution", sourceId: "alpha", targetId: "beta", derivedFrom: "dependsOn" },
      { kind: "execution", sourceId: "beta", targetId: "gamma", derivedFrom: "dependsOn" }
    ]);
  });
});

describe("empty system", () => {
  it("reports zeros and explicit nulls — nothing invented", () => {
    const agents = aggregateAgentMetrics(emptyInputs());
    expect(agents.map((agent) => agent.nodeId)).toEqual(["alpha", "beta", "gamma"]);
    for (const agent of agents) {
      expect(agent.usage.estimated.recordCount).toBe(0);
      expect(agent.usage.actual.recordCount).toBe(0);
      expect(agent.executions.total).toBe(0);
      expect(agent.successRate).toBeNull();
      expect(agent.latency).toBeNull();
      expect(agent.retries).toBeNull();
      expect(agent.toolErrors.count).toBe(0);
    }
    const summary = buildConstellationSummary(emptyInputs(), GENERATED_AT);
    expect(summary.runs.total).toBe(0);
    expect(summary.usage.estimated.totalTokens).toBe(0);
    expect(summary.usage.unattributedRecordCount).toBe(0);
    expect(summary.relationships).toEqual({ stored: 0, derivedExecutionEdges: 2, disabled: 0 });
    expect(buildAttentionItems(emptyInputs())).toEqual([]);
  });
});

describe("partial system (usage only)", () => {
  it("keeps estimated/actual split, counts unattributed and unknown-model records", () => {
    const agents = aggregateAgentMetrics(partialInputs());
    const alpha = agents.find((agent) => agent.nodeId === "alpha")!;
    expect(alpha.usage.estimated.recordCount).toBe(2);
    expect(alpha.usage.estimated.totalTokens).toBe(3000);
    expect(alpha.usage.estimated.unknownModelRecordCount).toBe(1);
    expect(alpha.usage.actual.recordCount).toBe(0);
    expect(alpha.executions.total).toBe(0);

    const summary = buildConstellationSummary(partialInputs(), GENERATED_AT);
    expect(summary.usage.unattributedRecordCount).toBe(1);
    expect(summary.usage.estimated.recordCount).toBe(3);
    expect(summary.caveats.some((caveat) => caveat.includes("mystery-model-x"))).toBe(true);
  });

  it("raises a fallback-pricing attention item naming the unknown model with usage evidence", () => {
    const items = buildAttentionItems(partialInputs());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "attn_fallback_pricing", severity: "warning" });
    expect(items[0].reasons.join(" ")).toContain("mystery-model-x");
    expect(items[0].evidence.usageIds).toEqual(["usage_2"]);
  });
});

describe("populated system", () => {
  it("aggregates per-agent metrics with bases and preserved usage status", () => {
    const agents = aggregateAgentMetrics(populatedInputs());
    const alpha = agents.find((agent) => agent.nodeId === "alpha")!;
    const beta = agents.find((agent) => agent.nodeId === "beta")!;
    const gamma = agents.find((agent) => agent.nodeId === "gamma")!;

    expect(alpha.usage.estimated.recordCount).toBe(1);
    expect(alpha.usage.actual.recordCount).toBe(1);
    expect(alpha.usage.actual.totalTokens).toBe(300);
    expect(alpha.executions).toMatchObject({ total: 4, independent: 1, workflow: 3 });
    expect(alpha.successRate).toBe(1);
    expect(alpha.latency).toEqual({ count: 4, avgMs: 1750, maxMs: 4000 });

    expect(beta.successRate).toBe(2 / 3);
    expect(beta.retries).toEqual({ count: 1, basis: "derived_from_cumulative_run_errors", approximate: true });
    expect(beta.outputValidationFailures).toEqual({ count: 2, basis: "run_errors_output_validation_failed" });
    expect(beta.toolErrors).toEqual({ count: 1, byCode: { tool_error: 1 }, scope: "current_process" });

    expect(gamma.humanIntervention).toEqual({ approvalsRequested: 1, blockedRuns: 1 });
    expect(gamma.successRate).toBe(1);
  });

  it("derives relationship metrics from runs and never fabricates per-edge mismatches", () => {
    const metrics = aggregateRelationshipMetrics(populatedInputs());
    const alphaBeta = metrics.find((metric) => metric.kind === "execution" && metric.sourceId === "alpha" && metric.targetId === "beta")!;
    // run_ok, run_failed, run_blocked all traverse alpha -> beta.
    expect(alphaBeta.interactionCount).toBe(3);
    expect(alphaBeta.successRate).toBe(2 / 3);
    expect(alphaBeta.payloadBytes.total).toBe(JSON.stringify({ text: "0123456789" }).length * 3);
    expect(alphaBeta.payloadBytes.basis).toBe("json_stringify_stage_output");
    expect(alphaBeta.latency.basis).toBe("downstream_node_duration_proxy");
    expect(alphaBeta.schemaMismatchCount.value).toBeNull();
    expect(alphaBeta.schemaMismatchCount.reason).toContain("not recorded");

    const storedData = metrics.find((metric) => metric.relationshipId === "rel_data")!;
    expect(storedData.kind).toBe("data");
    expect(storedData.interactionCount).toBe(3);
    expect(storedData.dataStatus).toBe("derived");

    const betaGamma = metrics.find((metric) => metric.kind === "execution" && metric.sourceId === "beta")!;
    // Only run_ok completed gamma; run_blocked never started it.
    expect(betaGamma.interactionCount).toBe(1);
    expect(betaGamma.successRate).toBe(1);
  });

  it("builds evidence-cited attention items in severity order with deterministic ids", () => {
    const items = buildAttentionItems(populatedInputs());
    expect(items.map((item) => item.id)).toEqual([
      "attn_approval_pending_run_blocked",
      "attn_run_failed_run_failed",
      "attn_output_validation_beta",
      "attn_relationship_missing_endpoint_rel_dangling",
      "attn_relationship_disabled_rel_disabled",
      "attn_tool_errors_beta"
    ]);
    const failed = items.find((item) => item.id === "attn_run_failed_run_failed")!;
    expect(failed.severity).toBe("action");
    expect(failed.evidence).toEqual({ runIds: ["run_failed"], nodeIds: ["beta"] });
    expect(failed.reasons).toEqual(["beta:output_validation_failed"]);
    const dangling = items.find((item) => item.id === "attn_relationship_missing_endpoint_rel_dangling")!;
    expect(dangling.reasons.join(" ")).toContain("ghost");
    for (const item of items) {
      expect(item.reasons.length).toBeGreaterThan(0);
      expect(Object.values(item.evidence).some((refs) => (refs ?? []).length > 0)).toBe(true);
    }
  });

  it("is deterministic: identical inputs produce identical output", () => {
    const first = { agents: aggregateAgentMetrics(populatedInputs()), relationships: aggregateRelationshipMetrics(populatedInputs()), summary: buildConstellationSummary(populatedInputs(), GENERATED_AT), attention: buildAttentionItems(populatedInputs()) };
    const second = { agents: aggregateAgentMetrics(populatedInputs()), relationships: aggregateRelationshipMetrics(populatedInputs()), summary: buildConstellationSummary(populatedInputs(), GENERATED_AT), attention: buildAttentionItems(populatedInputs()) };
    expect(second).toEqual(first);
  });
});
