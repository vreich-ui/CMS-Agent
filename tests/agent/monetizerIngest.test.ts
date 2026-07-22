import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  flattenNumericMetrics,
  metricsFromCallResult,
  ingestMonetizerAnalytics,
  type CallToolFn
} from "../../src/agent/improvement/monetizerIngest.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

// Phase 7 (docs/platform/DIRECTION.md §7): Monetizer analytics ingestion. performance / demand_signals
// telemetry is pulled and recorded as feedback OUTCOME records, closing the outer loop. These tests pin
// the pure metric extraction and the ingestion (per-signal success/error isolation) against an injected
// callTool — no live Monetizer endpoint is touched.

const okCall = (result: unknown): Awaited<ReturnType<CallToolFn>> => ({ ok: true, projectId: "monetizer", connection: {}, tool: "x", permission: "allowed", result } as unknown as Awaited<ReturnType<CallToolFn>>);
const failCall = (error: string): Awaited<ReturnType<CallToolFn>> => ({ ok: false, projectId: "monetizer", connection: {}, tool: "x", permission: "allowed", error } as unknown as Awaited<ReturnType<CallToolFn>>);
const stubCall = (map: Record<string, () => Promise<Awaited<ReturnType<CallToolFn>>>>): CallToolFn => async (tool) => {
  const handler = map[tool];
  if (!handler) throw new Error(`unexpected tool ${tool}`);
  return handler();
};

describe("flattenNumericMetrics", () => {
  it("flattens numbers and booleans by dot/bracket path", () => {
    expect(flattenNumericMetrics({ revenue: 1200, ctr: 0.031, live: true, off: false })).toEqual({ revenue: 1200, ctr: 0.031, live: 1, off: 0 });
    expect(flattenNumericMetrics({ networks: [{ epc: 1.2 }, { epc: 0.8 }] })).toEqual({ "networks[0].epc": 1.2, "networks[1].epc": 0.8 });
  });
  it("ignores non-finite and non-numeric leaves", () => {
    expect(flattenNumericMetrics({ a: NaN, b: Infinity, c: "text", d: null, e: 5 })).toEqual({ e: 5 });
  });
  it("bounds metric count and depth", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 150; index++) wide[`m${index}`] = index;
    expect(Object.keys(flattenNumericMetrics(wide)).length).toBeLessThanOrEqual(100);
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { tooDeep: 9 } } } } } } } };
    expect(flattenNumericMetrics(deep)).toEqual({}); // the number sits below the depth cap
  });
});

describe("metricsFromCallResult", () => {
  it("prefers structuredContent", () => {
    expect(metricsFromCallResult({ structuredContent: { clicks: 40 } })).toEqual({ clicks: 40 });
  });
  it("parses a JSON text content block", () => {
    expect(metricsFromCallResult({ content: [{ type: "text", text: JSON.stringify({ conversions: 3 }) }] })).toEqual({ conversions: 3 });
  });
  it("falls back to the raw object when content is not JSON", () => {
    expect(metricsFromCallResult({ content: [{ type: "text", text: "not json" }], score: 7 })).toEqual({ score: 7 });
  });
});

describe("ingestMonetizerAnalytics", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());
  const deps = (callTool: CallToolFn) => ({ evaluationRepository: repositoryManager.getEvaluationRepository(), callTool });

  it("records one feedback OUTCOME per signal with extracted metrics", async () => {
    const callTool = stubCall({
      performance: async () => okCall({ structuredContent: { revenue: 900, epc: 1.4 } }),
      demand_signals: async () => okCall({ structuredContent: { demandIndex: 72 } })
    });
    const result = await ingestMonetizerAnalytics({ runId: "run_perf_1" }, deps(callTool));
    expect(result.errors).toEqual([]);
    expect(result.ingested.map((entry) => entry.signal)).toEqual(["performance", "demand_signals"]);

    const feedback = await repositoryManager.getEvaluationRepository().listFeedback({ runId: "run_perf_1", kind: "outcome" });
    expect(feedback).toHaveLength(2);
    const perf = feedback.find((record) => record.outcome?.source === "monetizer:performance");
    expect(perf?.outcome?.metrics).toEqual({ revenue: 900, epc: 1.4 });
    expect(feedback.find((record) => record.outcome?.source === "monetizer:demand_signals")?.outcome?.metrics).toEqual({ demandIndex: 72 });
  });

  it("isolates a failing signal and still ingests the others", async () => {
    const callTool = stubCall({
      performance: async () => failCall("connection_not_configured"),
      demand_signals: async () => okCall({ structuredContent: { demandIndex: 5 } })
    });
    const result = await ingestMonetizerAnalytics({ runId: "run_perf_2" }, deps(callTool));
    expect(result.errors).toEqual([{ signal: "performance", error: "connection_not_configured" }]);
    expect(result.ingested.map((entry) => entry.signal)).toEqual(["demand_signals"]);
    expect(await repositoryManager.getEvaluationRepository().listFeedback({ runId: "run_perf_2", kind: "outcome" })).toHaveLength(1);
  });

  it("captures a thrown transport error per signal and never throws", async () => {
    const callTool = stubCall({ performance: async () => { throw new Error("socket hang up"); } });
    const result = await ingestMonetizerAnalytics({ runId: "run_perf_3", signals: ["performance"] }, deps(callTool));
    expect(result.ingested).toEqual([]);
    expect(result.errors[0]).toMatchObject({ signal: "performance" });
    expect(result.errors[0]!.error).toContain("socket hang up");
  });

  it("honors a signal subset", async () => {
    const callTool = stubCall({ demand_signals: async () => okCall({ structuredContent: { demandIndex: 1 } }) });
    const result = await ingestMonetizerAnalytics({ signals: ["demand_signals"] }, deps(callTool));
    expect(result.ingested.map((entry) => entry.signal)).toEqual(["demand_signals"]);
  });
});
