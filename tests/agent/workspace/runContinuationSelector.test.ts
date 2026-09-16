import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALL_MARGIN_MS } from "../../../src/agent/workspace/executor.js";
import {
  CONTINUATION_TICK_CRON,
  CONTINUATION_TICK_INTERVAL_MS,
  DEPLOYED_TICK_DEFAULTS,
  continuationTickEnabled,
  continuationTickIntervalMs,
  decideRunContinuation,
  runContinuationTick,
  selectContinuableRuns
} from "../../../src/agent/workspace/runContinuation.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { runSummaryOf, type ExecutionRepository, type ListRunsFilters } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";

// T5 — the continuation tick's whole judgement is this selector, so it is tested as what it is: a
// pure function of the persisted record plus a clock. No repository, no schedule, no network.
const NOW = new Date("2026-08-13T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const run = (overrides: Partial<WorkflowExecutionRecord> & { runId: string; status: ExecutionStatus }): WorkflowExecutionRecord => ({
  workflowId: "publishing_conductor",
  projectId: "platform",
  startedAt: at(600_000),
  updatedAt: at(5_000),
  nodes: [{ nodeId: "n1", status: "completed" }, { nodeId: "n2", status: "queued" }],
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  ...overrides
} as WorkflowExecutionRecord);

describe("T5 continuation selector — which runs a scheduled tick re-enters", () => {
  it("re-enters a running run parked between nodes, without waiting out the stall margin", () => {
    // The run_1786557897658_elj34j gap: nothing in flight, record freshly saved, driver simply parked.
    // Requiring stalledSuspected here would reintroduce a 90s floor under every idle gap.
    const verdict = decideRunContinuation(run({ runId: "r-parked", status: "running", updatedAt: at(2_000) }), NOW);
    expect(verdict).toMatchObject({ reenter: true, code: "reenter_idle_driver" });
  });

  it("re-enters a queued run", () => {
    expect(decideRunContinuation(run({ runId: "r-queued", status: "queued" }), NOW)).toMatchObject({ reenter: true, code: "reenter_idle_driver" });
  });

  it("re-enters a run whose dispatch claim outlived its own timeout, so the advance reclaims it", () => {
    const dead = run({
      runId: "r-stale",
      status: "running",
      nodes: [{ nodeId: "n1", status: "running", dispatch: { dispatchedAt: at(120_000 + STALL_MARGIN_MS + 5_000), timeoutMs: 120_000 } }]
    });
    expect(decideRunContinuation(dead, NOW)).toMatchObject({ reenter: true, code: "reenter_stale_dispatch", stall: { inFlightNodeId: "n1", stalledSuspected: true } });
  });

  it("refuses a run that is genuinely mid-dispatch (fresh heartbeat inside its claim window)", () => {
    const live = run({
      runId: "r-inflight",
      status: "running",
      nodes: [{ nodeId: "n1", status: "running", dispatch: { dispatchedAt: at(30_000), timeoutMs: 120_000 } }]
    });
    const verdict = decideRunContinuation(live, NOW);
    expect(verdict).toMatchObject({ reenter: false, code: "skip_dispatch_in_flight" });
    expect(verdict.reason).toMatch(/double-dispatch/);
  });

  it("refuses every terminal and halted status — the tick never clears a stop", () => {
    for (const status of ["completed", "failed", "blocked", "cancelled", "paused"] as ExecutionStatus[]) {
      expect(decideRunContinuation(run({ runId: `r-${status}`, status }), NOW)).toMatchObject({ reenter: false, code: "skip_not_active" });
    }
  });

  it("refuses a budget-blocked run: raising the ceiling is an operator act, not a scheduled one", () => {
    const budgetBlocked = run({
      runId: "r-budget",
      status: "blocked",
      budgetBlock: { blockedAt: at(60_000), budgetUsd: 3, spentUsdEstimate: 3.1, nextNodeId: "n2", reason: "Run paused for budget." }
    });
    expect(decideRunContinuation(budgetBlocked, NOW)).toMatchObject({ reenter: false, code: "skip_not_active" });
  });

  it("refuses a run the operator withheld, even while its status is still active", () => {
    const withheld = run({ runId: "r-withheld", status: "running", operatorPublishDecision: "withheld", operatorDecisionSource: "explicit" });
    const verdict = decideRunContinuation(withheld, NOW);
    expect(verdict).toMatchObject({ reenter: false, code: "skip_operator_withheld" });
    // A project-policy default can only ever produce "approved" (T2), so this is always a human veto.
    expect(decideRunContinuation(run({ runId: "r-policy", status: "running", operatorPublishDecision: "approved", operatorDecisionSource: "project_policy_default" }), NOW).reenter).toBe(true);
  });

  it("partitions a mixed ledger and gives every run a named verdict — nothing is silently dropped", () => {
    const runs = [
      run({ runId: "r1", status: "running", updatedAt: at(1_000) }),
      run({ runId: "r2", status: "completed" }),
      run({ runId: "r3", status: "queued" }),
      run({ runId: "r4", status: "running", nodes: [{ nodeId: "n1", status: "running", dispatch: { dispatchedAt: at(10_000), timeoutMs: 120_000 } }] })
    ];
    const { reenter, skipped } = selectContinuableRuns(runs, NOW);
    expect(reenter.map((verdict) => verdict.runId)).toEqual(["r1", "r3"]);
    expect(skipped.map((verdict) => verdict.runId)).toEqual(["r2", "r4"]);
    expect(reenter.length + skipped.length).toBe(runs.length);
    for (const verdict of [...reenter, ...skipped]) expect(verdict.reason.length).toBeGreaterThan(0);
  });

  // W5 T6 — THE PIN MOVED, and what is left here is the part this module actually owns.
  //
  // This used to restate two literals ("*/2 * * * *" and 120_000) and call that a guarantee. It was
  // not one: a unit test that hardcodes the same numbers as the module proves they agree with the
  // test, never that either agrees with Cloud Scheduler. scripts/twoPlaneDrift.ts (`npm run
  // test:drift`) now owns the pin, against scripts/deploy-continuation-tick-schedule.sh itself —
  // edit the script's CRON default and drift fails, which is the acceptance for W5 T6.
  //
  // What remains is the DERIVATION, which is this module's own logic and has nothing to do with the
  // deploy scripts: an interval that follows the cron, and a shape it does not understand leaving the
  // published value alone rather than guessing.
  it("derives the published cadence from the cron rather than restating it", () => {
    expect(CONTINUATION_TICK_CRON).toBe(DEPLOYED_TICK_DEFAULTS.cron);
    expect(CONTINUATION_TICK_INTERVAL_MS).toBe(continuationTickIntervalMs(DEPLOYED_TICK_DEFAULTS.cron));
    expect(continuationTickIntervalMs("*/5 * * * *")).toBe(300_000);
    expect(continuationTickIntervalMs("0 * * * *")).toBeUndefined();
  });
});

// A repository stub: the tick only ever calls listRuns and getRun, and drives through the injected
// advance. Everything else on the interface would be unused ceremony.
//
// It honours `status` — and only `status` — because that is the single filter the tick passes, and
// the scan that filter produces is what these tests are about. Array order is deliberately preserved
// rather than re-sorted newest-first: the verdict ordering asserted below is the fixture's own, not
// the repository's, and a stub that quietly re-sorted would make those assertions test the stub.
// `seenFilters` records every call so a test can assert what the tick ASKED for, which is the part
// the bill responds to — a tick that asked for everything and filtered in memory would still pass a
// test that only looked at the runs it acted on.
const fakeStore = (records: WorkflowExecutionRecord[], seenFilters: ListRunsFilters[] = []): ExecutionRepository => {
  const select = (filters: ListRunsFilters = {}): WorkflowExecutionRecord[] => {
    seenFilters.push(filters);
    if (filters.status === undefined) return records;
    const wanted = new Set(Array.isArray(filters.status) ? filters.status : [filters.status]);
    return records.filter((record) => wanted.has(record.status));
  };
  return {
    listRuns: async (filters) => select(filters),
    listRunsPage: async (filters) => {
      const runs = select(filters);
      return { runs, matchedCount: runs.length, hasMore: false };
    },
    listRunSummariesPage: async (filters) => {
      const runs = select(filters);
      return { rows: runs.map((record) => runSummaryOf(record)), matchedCount: runs.length, hasMore: false };
    },
    getRun: async (runId: string) => records.find((record) => record.runId === runId),
    createRun: async (record) => record,
    saveRun: async (record) => record,
    resetRun: async (_runId, next) => next,
    health: async () => ({ backend: "memory", ok: true } as never)
  };
};

describe("T5 continuation tick — the shell over the selector", () => {
  // S1: the tick now preflights the driver's environment (driverEnvPreflight.ts) and refuses to
  // dispatch a run whose project MCP endpoint env var it cannot see. These fixtures are "platform"
  // runs, so the endpoint must be visible for the tick to drive them at all.
  beforeEach(() => { process.env.PLATFORM_MCP_ENDPOINT = "https://platform.example/mcp"; });
  afterEach(() => { delete process.env.RUN_CONTINUATION_TICK; delete process.env.PLATFORM_MCP_ENDPOINT; });

  it("drives only the runs the selector chose, and never touches the ones it refused", async () => {
    const records = [
      run({ runId: "r-active", status: "running", updatedAt: at(1_000) }),
      run({ runId: "r-blocked", status: "blocked" }),
      run({ runId: "r-inflight", status: "running", nodes: [{ nodeId: "n1", status: "running", dispatch: { dispatchedAt: at(5_000), timeoutMs: 120_000 } }] })
    ];
    const advanced: string[] = [];
    const result = await runContinuationTick({
      executionRepository: fakeStore(records),
      now: () => NOW,
      advance: async (runId) => {
        advanced.push(runId);
        // The advance halts the run, exactly as a real gate would; the loop must stop on it.
        const record = records.find((candidate) => candidate.runId === runId)!;
        record.status = "blocked";
        return record;
      }
    });
    expect(advanced).toEqual(["r-active"]);
    expect(result.driven).toEqual([{ runId: "r-active", code: "reenter_idle_driver", statusBefore: "running", statusAfter: "blocked", steps: 1 }]);
    expect(result.verdicts.filter((verdict) => !verdict.reenter).map((verdict) => verdict.code)).toEqual(["skip_not_active", "skip_dispatch_in_flight"]);
  });

  it("stops at its wall-clock budget instead of running past the platform's ceiling", async () => {
    const records = [run({ runId: "r-slow", status: "queued" })];
    let calls = 0;
    const result = await runContinuationTick({
      executionRepository: fakeStore(records),
      timeBudgetMs: 45_000,
      // First call sets the deadline, the second is already past it.
      now: () => new Date(NOW.getTime() + (calls++ === 0 ? 0 : 50_000)),
      advance: async () => records[0]
    });
    expect(result.timedOut).toBe(true);
    expect(result.driven).toEqual([]);
  });

  it("does nothing at all when the kill switch is set, and says so", async () => {
    process.env.RUN_CONTINUATION_TICK = "off";
    expect(continuationTickEnabled()).toBe(false);
    const advance = async () => { throw new Error("the tick must not advance anything while disabled"); };
    const result = await runContinuationTick({ executionRepository: fakeStore([run({ runId: "r", status: "queued" })]), advance, now: () => NOW });
    expect(result).toMatchObject({ enabled: false, scanned: 0, driven: [] });
  });

  it("reports a failing run by name and keeps going", async () => {
    const records = [run({ runId: "r-boom", status: "queued" }), run({ runId: "r-ok", status: "queued" })];
    const result = await runContinuationTick({
      executionRepository: fakeStore(records),
      now: () => NOW,
      advance: async (runId) => {
        if (runId === "r-boom") throw new Error("store unreachable");
        const record = records.find((candidate) => candidate.runId === runId)!;
        record.status = "completed";
        return record;
      }
    });
    expect(result.driven[0]).toMatchObject({ runId: "r-boom", error: "store unreachable" });
    expect(result.driven[1]).toMatchObject({ runId: "r-ok", statusAfter: "completed", steps: 1 });
  });

  // COST — the tick's scan BREADTH, as distinct from the runs it drives. Everything above asserts
  // which runs moved; these two assert what was read to decide that, which is the line on the bill.
  it("asks the repository only for the statuses it can act on, and never reads a terminal run", async () => {
    // 12:30 — outside FULL_SCAN_MINUTE_WINDOW, so this is an ordinary indexed tick.
    const INDEXED_MINUTE = new Date("2026-08-13T12:30:00.000Z");
    const records = [
      run({ runId: "r-active", status: "running", updatedAt: at(1_000) }),
      run({ runId: "r-done", status: "completed" }),
      run({ runId: "r-failed", status: "failed" }),
      run({ runId: "r-cancelled", status: "cancelled" })
    ];
    const seen: ListRunsFilters[] = [];
    const result = await runContinuationTick({
      executionRepository: fakeStore(records, seen),
      now: () => INDEXED_MINUTE,
      advance: async (runId) => {
        const record = records.find((candidate) => candidate.runId === runId)!;
        record.status = "completed";
        return record;
      }
    });

    expect(result.scanMode).toBe("indexed");
    // The ASK, not just the outcome: a tick that requested the whole fleet and filtered it in memory
    // would still drive the right run and still cost the bucket every read this change removes.
    expect(seen[0]).toEqual({ status: ["running", "queued"] });
    // Three terminal runs were never read, so they cannot appear in the count or among the refusals.
    expect(result.scanned).toBe(1);
    expect(result.verdicts.map((verdict) => verdict.runId)).toEqual(["r-active"]);
    expect(result.driven.map((report) => report.runId)).toEqual(["r-active"]);
  });

  it("takes one UNFILTERED scan at the top of the hour, so a lost index entry cannot park a run forever", async () => {
    const records = [
      run({ runId: "r-active", status: "running", updatedAt: at(1_000) }),
      run({ runId: "r-done", status: "completed" })
    ];
    const seen: ListRunsFilters[] = [];
    const result = await runContinuationTick({
      // NOW is 12:00:00Z — inside FULL_SCAN_MINUTE_WINDOW, which is why every other tick test in this
      // file still exercises the pre-change full-fleet behaviour unmodified.
      executionRepository: fakeStore(records, seen),
      now: () => NOW,
      advance: async (runId) => {
        const record = records.find((candidate) => candidate.runId === runId)!;
        record.status = "completed";
        return record;
      }
    });

    expect(result.scanMode).toBe("full");
    expect(seen[0]).toEqual({});
    expect(result.scanned).toBe(2);
    // The terminal run is seen and refused by name, exactly as it was before the indexed scan existed.
    expect(result.verdicts.filter((verdict) => !verdict.reenter).map((verdict) => verdict.code)).toEqual(["skip_not_active"]);
  });
});
