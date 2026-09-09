import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prospectiveOutputTokens, wrapModelWithBudgetGuard, NodeBudgetExceededError, type BudgetGuardState } from "../../../src/agent/execution/runners/budgetGuard.js";
import { measuredDispatchCost, resetMeasuredDispatchCostCache, MIN_MEASURED_RESERVE_SAMPLES, buildNodeTimingRecord, type NodeTimingRecord } from "../../../src/agent/workspace/nodeTimings.js";
import { MemoryNodeTimingRepository } from "../../../src/agent/repository/memory/MemoryNodeTimingRepository.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";

// ACCEPTANCE — W2.1 (static-guesses brief, 2026-09-09, re-derived against actual usage records).
//
// THE DEFECT. The budget guard prices an upcoming model turn at the node's `maxOutputTokens` — a CAP
// the node is permitted to reach, not what it emits. narrative_movement is capped at 3500 and
// typically emits ~1100, so every turn reserved roughly three times the node's real output cost.
//
// THE LIVE FALSE-STOP (run_1788769566432_5qnafb, node ceiling $0.15): one in-dispatch attempt ran long
// and hit the cap, costing $0.121; the retry was priced at the cap AGAIN and refused. That node's p95
// across 40 dispatches is $0.090.
//
// NOTE ON THE BRIEF'S NUMBERS. It called for `max(static, measured)`, which makes the reserve BIGGER
// and the guard fire EARLIER — the opposite of its own invariant. It also cited p95s of
// $1.49/$0.28/$0.24 from nodeTimingAggregates BEFORE W0.2, when that figure summed actual+estimated,
// double-counted retries and pooled four tenants; re-derived from actual usage the same nodes are
// $0.403/$0.160/$0.090. Measurement is applied here in the other direction, and to ONE TERM ONLY.

describe("W2.1 — measurement lowers the OUTPUT reserve and nothing else", () => {
  it("takes the measured output size when it is below the configured cap", () => {
    expect(prospectiveOutputTokens(3500, 2500)).toBe(2500);
  });

  it("never raises the reserve above the node's configured cap", () => {
    expect(prospectiveOutputTokens(3500, 9000)).toBe(3500);
    for (const cap of [500, 2500, 3500, 10000]) {
      for (const measured of [undefined, 0, -5, 100, 3000, 99999]) {
        expect(prospectiveOutputTokens(cap, measured)).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("a cold ledger is byte-identical to the pre-W2 behaviour", () => {
    expect(prospectiveOutputTokens(3500, undefined)).toBe(3500);
    // Zero or negative is not a measurement and must not pin the reserve to nothing, which would
    // disable the output half of the guard entirely.
    expect(prospectiveOutputTokens(3500, 0)).toBe(3500);
    expect(prospectiveOutputTokens(3500, -1)).toBe(3500);
  });
});

// THE INVARIANT THAT MATTERS, exercised through the REAL guard rather than the pure helper.
//
// An earlier cut of this change capped the whole prospective COST at the node's measured p95, which
// silently discarded the guard's live input term — the runaway detector. This drives
// wrapModelWithBudgetGuard with a genuinely ballooning request and asserts it still refuses. If the
// production change were reverted to that cost-capping form, this test fails.
describe("W2.1 — a node ballooning its own context is still stopped", () => {
  const modelStub = (): Model => ({
    getResponse: async (): Promise<ModelResponse> => ({ usage: { inputTokens: 10, outputTokens: 10 } } as unknown as ModelResponse),
    getStreamedResponse: async function* () { /* unused */ }
  } as unknown as Model);

  // ~4 chars/token (estimateRequestTokens), so this is roughly 200k input tokens about to be sent.
  const ballooningRequest = { input: "x".repeat(800_000), systemInstructions: "" } as unknown as ModelRequest;

  it("refuses a huge upcoming turn even when its measured history is tiny", async () => {
    const state: BudgetGuardState = { accrued: { inputTokens: 0, outputTokens: 0 } };
    const guarded = wrapModelWithBudgetGuard(modelStub(), {
      nodeId: "narrative_movement",
      model: "gpt-5.5",
      nodeBudgetUsd: 0.3,
      priorSpendUsd: 0,
      maxOutputTokens: 3500,
      // A cheap, well-behaved history — exactly the case that made the cost-capping version unsafe.
      measuredOutputTokens: 1100
    }, state);

    await expect(guarded.getResponse(ballooningRequest)).rejects.toBeInstanceOf(NodeBudgetExceededError);
    expect(state.exceeded?.ceiling).toBe("node");
    // The refusal is priced from the LIVE request, not from the node's history: ~200k input tokens is
    // far past anything this node has ever spent, and the guard saw it.
    expect(state.exceeded!.prospectiveTurnUsd).toBeGreaterThan(0.3);
  });

  it("still lets an ordinary turn through, priced at the measured output rather than the cap", async () => {
    const state: BudgetGuardState = { accrued: { inputTokens: 0, outputTokens: 0 } };
    const config = { nodeId: "narrative_movement", model: "gpt-5.5", nodeBudgetUsd: 0.15, priorSpendUsd: 0, maxOutputTokens: 3500 };
    const ordinaryRequest = { input: "y".repeat(12_800), systemInstructions: "" } as unknown as ModelRequest;

    // At the CAP (pre-W2): 3200 input + 3500 output = $0.121, which leaves a $0.15 ceiling unable to
    // afford a second attempt — the shape of the live false-stop.
    const atCap = wrapModelWithBudgetGuard(modelStub(), config, { accrued: { inputTokens: 0, outputTokens: 0 } });
    await expect(atCap.getResponse(ordinaryRequest)).resolves.toBeDefined();

    // Measured (post-W2): the same turn is priced at ~2500 output, so the accrued-plus-next sum that
    // refused the retry now fits. Driven here by seeding accrued usage from the first attempt.
    const measured = wrapModelWithBudgetGuard(modelStub(), { ...config, measuredOutputTokens: 2500 }, state);
    state.accrued = { inputTokens: 3200, outputTokens: 1100 };
    await expect(measured.getResponse(ordinaryRequest)).resolves.toBeDefined();
    expect(state.exceeded).toBeUndefined();
  });
});

describe("W2.1 — measuredDispatchCost reads the timing ledger honestly", () => {
  const sample = (over: Partial<NodeTimingRecord>): NodeTimingRecord => buildNodeTimingRecord({
    runId: `run_${Math.random()}`, workflowId: "publishing_conductor", nodeId: "narrative_movement",
    durationMs: 1000, costUsd: 0.04, outputTokens: 1100, outcome: "completed",
    projectId: "dr-lurie", executionMode: "openai", routeEra: "model", ...over
  });
  let store: MemoryNodeTimingRepository;
  beforeEach(() => { store = new MemoryNodeTimingRepository(); resetMeasuredDispatchCostCache(); });

  const seed = async (records: NodeTimingRecord[]) => { for (const record of records) await store.record(record); };

  it("returns undefined below the sample minimum, so a cold node keeps the cap", async () => {
    await seed([sample({ outputTokens: 2500 })]);
    expect(MIN_MEASURED_RESERVE_SAMPLES).toBe(2);
    expect(await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "narrative_movement", projectId: "dr-lurie" }, store)).toBeUndefined();
  });

  it("computes p95 output over this tenant's own priced dispatches", async () => {
    await seed([
      sample({ outputTokens: 500 }), sample({ outputTokens: 1100 }), sample({ outputTokens: 2500 }),
      // Excluded: another tenant, a mock run, a phase breakdown, and a pre-W2.1 record with no
      // recorded output — none of them says what THIS node emits HERE.
      sample({ outputTokens: 30000, projectId: "zilberman" }),
      sample({ outputTokens: 30000, executionMode: "mock" }),
      sample({ outputTokens: 30000, phase: "validate" }),
      sample({ outputTokens: undefined })
    ]);
    const measured = await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "narrative_movement", projectId: "dr-lurie" }, store);
    expect(measured?.sampleCount).toBe(3);
    expect(measured?.p95OutputTokens).toBe(2500);
    expect(measured?.p50OutputTokens).toBe(1100);
  });

  it("scopes to the tenant asked for, never pooling four sites into one reserve", async () => {
    await seed([
      sample({ outputTokens: 1100 }), sample({ outputTokens: 2500 }),
      sample({ outputTokens: 8000, projectId: "platform" }), sample({ outputTokens: 9000, projectId: "platform" })
    ]);
    expect((await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "narrative_movement", projectId: "dr-lurie" }, store))?.p95OutputTokens).toBe(2500);
    expect((await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "narrative_movement", projectId: "platform" }, store))?.p95OutputTokens).toBe(9000);
  });
});

// BlobNodeTimingRepository.list() keys by workflowId and DOWNLOADS every blob under that prefix
// before filtering, so a per-node read on the dispatch path would re-download the whole workflow's
// history 25 times per run and grow forever with the ledger — the same trap W0.3 hit. Both halves of
// the fix are asserted: one list answers every node, and the DEFAULT repository is memoized.
describe("W2.1 — the lookup does not re-read the ledger once per node", () => {
  const defaultStore = repositoryManager.getNodeTimingRepository();
  const originalList = defaultStore.list.bind(defaultStore);
  let listCalls = 0;

  beforeEach(async () => {
    resetMeasuredDispatchCostCache();
    defaultStore.clear();
    listCalls = 0;
    for (const [nodeId, outputTokens] of [["narrative_movement", 500], ["narrative_movement", 2500], ["reader_simulation", 1800], ["reader_simulation", 4300]] as const) {
      await defaultStore.record(buildNodeTimingRecord({ runId: `run_${Math.random()}`, workflowId: "publishing_conductor", nodeId, durationMs: 1, costUsd: 0.1, outputTokens, outcome: "completed", projectId: "dr-lurie", executionMode: "openai", routeEra: "model" }));
    }
    (defaultStore as { list: typeof originalList }).list = async (filters) => { listCalls += 1; return originalList(filters); };
  });
  afterEach(() => { (defaultStore as { list: typeof originalList }).list = originalList; resetMeasuredDispatchCostCache(); });

  it("aggregates every node from ONE list, and serves the second node from cache", async () => {
    const first = await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "narrative_movement", projectId: "dr-lurie" });
    const second = await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "reader_simulation", projectId: "dr-lurie" });
    expect(first?.p95OutputTokens).toBe(2500);
    expect(second?.p95OutputTokens).toBe(4300);
    // ONE read for both nodes — this is the assertion that fails if the memo is removed.
    expect(listCalls).toBe(1);

    // ...and clearing the cache costs exactly one more read, proving the count above was the cache
    // working rather than the aggregation happening to be called once.
    resetMeasuredDispatchCostCache();
    await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "reader_simulation", projectId: "dr-lurie" });
    expect(listCalls).toBe(2);
  });

  it("does not memoize a caller-supplied store, so a test or audit never reads another store's cache", async () => {
    const own = new MemoryNodeTimingRepository();
    for (const outputTokens of [900, 950]) {
      await own.record(buildNodeTimingRecord({ runId: `run_${Math.random()}`, workflowId: "publishing_conductor", nodeId: "narrative_movement", durationMs: 1, costUsd: 0.02, outputTokens, outcome: "completed", projectId: "dr-lurie", executionMode: "openai", routeEra: "model" }));
    }
    // The default store's cache is warm with 2500 for this node; the injected store must answer 950.
    await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "narrative_movement", projectId: "dr-lurie" });
    expect((await measuredDispatchCost({ workflowId: "publishing_conductor", nodeId: "narrative_movement", projectId: "dr-lurie" }, own))?.p95OutputTokens).toBe(950);
  });
});
