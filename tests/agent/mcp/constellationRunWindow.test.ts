import { describe, expect, it } from "vitest";
import { createConstellationTools } from "../../../src/agent/mcp/workspace/constellationTools.js";
import { runSummaryOf, windowRunRows, type ExecutionRepository, type ListRunSummariesPageResult, type ListRunsFilters, type ListRunsPageResult } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import type { UsageRepository } from "../../../src/agent/repository/interfaces/UsageRepository.js";
import { fixtureNode } from "../observability/constellationFixtures.js";

// W3 acceptance — the constellation tools read a WINDOW of runs, not the fleet.
//
// gatherInputs used to call listRuns({}), which on the blob backend is store.list("runs/")
// plus a GET of every run blob. With 115 runs on a 1 vCPU / 1Gi instance that did not just
// run slowly, it killed the instance and took every other in-flight request down with the
// connection. The repository here counts every run RECORD the tools cause to be read, so
// "it reads 50 of 200" is asserted against actual reads rather than inferred from timing.

const nodes = [fixtureNode("alpha"), fixtureNode("beta", ["alpha"])];

const run = (index: number, status: WorkflowExecutionRecord["status"]): WorkflowExecutionRecord => ({
  runId: `run_${String(index).padStart(4, "0")}`,
  workflowId: "wf",
  projectId: index % 2 === 0 ? "project-a" : "project-b",
  // Newest last by index, so run_0199 is the newest and run_0000 the oldest.
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 60_000).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0) + index * 60_000).toISOString(),
  status,
  nodes: [
    { nodeId: "alpha", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000 },
    { nodeId: "beta", status: status === "failed" ? "failed" : "completed", startedAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:02.000Z", durationMs: 1000 }
  ] as WorkflowExecutionRecord["nodes"],
  artifacts: [],
  errors: status === "failed" ? ["beta:boom"] : [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  executionMode: "mock"
});

// 200 runs, a third of them failed — every one of which get_attention would want to cite if
// it were reading the fleet.
const ALL_RUNS = Array.from({ length: 200 }, (_, i) => run(i, i % 3 === 0 ? "failed" : "completed"));

class CountingExecutionRepository implements ExecutionRepository {
  /** Overridable so a test can supply its own fleet. */
  protected source(): WorkflowExecutionRecord[] { return ALL_RUNS; }

  recordsRead = 0;
  fullFleetReads = 0;
  pageReads = 0;
  directGets = 0;

  async createRun(r: WorkflowExecutionRecord) { return r; }
  async getRun(runId: string) {
    this.directGets += 1;
    const found = this.source().find((r) => r.runId === runId);
    if (found) this.recordsRead += 1;
    return found;
  }
  async listRuns(filters: ListRunsFilters = {}) {
    // The call this change exists to remove. Counted rather than thrown so a regression
    // reports "it read 200 records the full-fleet way", not an opaque stack trace.
    this.fullFleetReads += 1;
    return (await this.listRunsPage(filters)).runs;
  }
  async listRunsPage(filters: ListRunsFilters = {}): Promise<ListRunsPageResult> {
    this.pageReads += 1;
    // Mirrors BlobExecutionRepository's index path: window over cheap rows FIRST, then
    // "fetch" only the window — which is where records actually get read.
    const { window, matchedCount, hasMore } = windowRunRows(this.source(), filters);
    this.recordsRead += window.length;
    return { runs: window, matchedCount, hasMore };
  }
  async listRunSummariesPage(filters: ListRunsFilters = {}): Promise<ListRunSummariesPageResult> {
    // Rows cost no record reads — that is the W4 property — so nothing is counted here.
    const { window, matchedCount, hasMore } = windowRunRows(this.source(), filters);
    return { rows: window.map((r) => runSummaryOf(r)), matchedCount, hasMore };
  }
  async saveRun(r: WorkflowExecutionRecord) { return r; }
  async resetRun(_runId: string, next: WorkflowExecutionRecord) { return next; }
  async health() { return { ok: true, writable: true, readable: true, backend: "counting", version: "test" } as unknown as Awaited<ReturnType<ExecutionRepository["health"]>>; }
}

const deps = (executionRepository: ExecutionRepository) => ({
  workspaceRepository: {
    getNodes: async () => nodes,
    listRelationships: async () => []
  } as unknown as WorkspaceRepository,
  executionRepository,
  usageRepository: { list: async () => [] } as unknown as UsageRepository
});

const toolNamed = (executionRepository: ExecutionRepository, name: string) => {
  const tool = createConstellationTools(deps(executionRepository)).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no constellation tool named ${name}`);
  return tool;
};

const dataOf = (result: unknown) => (result as { data: Record<string, unknown> }).data;

describe("constellation run window (W3)", () => {
  it("get_attention windows twice — by recency and by status — and never reads the full fleet", async () => {
    const repo = new CountingExecutionRepository();
    const result = dataOf(await toolNamed(repo, "constellation.get_attention").execute({}));

    expect(repo.fullFleetReads).toBe(0);
    // TWO windowed reads (review fix): a SMALL recency window (20) plus the newest 50 whose
    // status means the run has stopped advancing. Bounded well under the 115 records that the
    // full-fleet read this replaced is documented as having killed the instance with.
    expect(repo.pageReads).toBe(2);
    expect(repo.recordsRead).toBe(70);

    const window = result.runWindow as {
      limit: number;
      examined: number;
      merged: number;
      matchedCount: number;
      hasMore: boolean;
      attention: { statuses: string[]; examined: number; matchedCount: number; hasMore: boolean };
    };
    // `examined` keeps its documented meaning — the recency read's own count, never > limit.
    expect(window).toMatchObject({ limit: 20, examined: 20, matchedCount: 200, hasMore: true });
    // The two reads overlap, so the union is smaller than their sum and at least as large as
    // either — it is a union of runs, not a concatenation of rows.
    expect(window.merged).toBeGreaterThanOrEqual(50);
    expect(window.merged).toBeLessThan(70);
    // 67 of the 200 fixture runs are failed; the status window returns its newest 50 of them.
    expect(window.attention).toMatchObject({ statuses: ["running", "paused", "blocked", "failed"], examined: 50, hasMore: true });

    // Every cited run is one the tool actually opened — never one it only counted.
    const items = result.items as Array<{ evidence?: { runIds?: string[] } }>;
    const cited = new Set(items.flatMap((item) => item.evidence?.runIds ?? []));
    expect(cited.size).toBeGreaterThan(0);
    const newest20 = new Set(ALL_RUNS.slice(-20).map((r) => r.runId));
    const newestFailed50 = new Set(ALL_RUNS.filter((r) => r.status === "failed").slice(-50).map((r) => r.runId));
    for (const runId of cited) expect(newest20.has(runId) || newestFailed50.has(runId)).toBe(true);
  });

  it("get_summary reports the true lifetime run total but a windowed status breakdown, with a caveat naming the gap", async () => {
    const repo = new CountingExecutionRepository();
    const result = dataOf(await toolNamed(repo, "constellation.get_summary").execute({}));
    const summary = result.summary as {
      runs: { total: number; examined?: number; windowed?: boolean; byStatus: Record<string, number> };
      caveats: string[];
    };

    // `total` comes off the index's matchedCount — the one lifetime figure the window can
    // still answer honestly, without opening a single extra record.
    expect(summary.runs.total).toBe(200);
    expect(repo.recordsRead).toBe(50);

    // ...and the breakdown does NOT pretend to cover all 200.
    expect(summary.runs.examined).toBe(50);
    expect(summary.runs.windowed).toBe(true);
    expect(Object.values(summary.runs.byStatus).reduce((sum, n) => sum + n, 0)).toBe(50);
    expect(summary.caveats.some((caveat) => caveat.includes("newest 50 of 200 matching runs"))).toBe(true);
  });

  it("a projectId-scoped read windows within that project, and its total counts only that project", async () => {
    const repo = new CountingExecutionRepository();
    const result = dataOf(await toolNamed(repo, "constellation.get_summary").execute({ projectId: "project-a" }));
    const summary = result.summary as { runs: { total: number; examined?: number } };

    expect(summary.runs.total).toBe(100);
    expect(summary.runs.examined).toBe(50);
    expect(repo.recordsRead).toBe(50);
    expect(repo.fullFleetReads).toBe(0);
  });

  it("a runId-scoped read addresses that ONE run directly, even when it is far outside the window", async () => {
    const repo = new CountingExecutionRepository();
    // The very oldest run — 199 runs older than the newest-50 window would ever reach. Under
    // a naive window this would silently have become "no such run".
    const result = dataOf(await toolNamed(repo, "constellation.get_metrics").execute({ runId: "run_0000" }));

    expect(repo.directGets).toBe(1);
    expect(repo.pageReads).toBe(0);
    expect(repo.recordsRead).toBe(1);
    // No window was applied, so none is reported.
    expect(result.runWindow).toBeUndefined();

    const agents = result.agents as Array<{ nodeId: string; executions: { total: number } }>;
    // The single addressed run is what the metrics are built from — one execution of each node.
    expect(agents.find((agent) => agent.nodeId === "alpha")?.executions.total).toBe(1);
  });

  it("REVIEW FIX — a run blocked long ago is still in attention, even when 50 newer runs have finished since", async () => {
    // The failure this guards: attention was windowed by startedAt, and a run waiting on an
    // operator STOPS ADVANCING while newer runs keep being created — so it is the first row a
    // newest-first window loses. An empty attention list then reads as "nothing is waiting on
    // you", which is the one claim this surface must never make falsely.
    const blockedOld = { ...run(0, "blocked"), runId: "run_blocked_old", approvalsRequired: [{ nodeId: "beta", reason: "publish approval" }] } as unknown as WorkflowExecutionRecord;
    const fleet = [blockedOld, ...Array.from({ length: 120 }, (_, i) => run(i + 1, "completed"))];

    class Repo extends CountingExecutionRepository {
      protected override source() { return fleet; }
    }
    const repo = new Repo();
    const result = dataOf(await toolNamed(repo, "constellation.get_attention").execute({}));

    // The old run is 120 runs behind the newest — nowhere near a newest-50 window.
    const window = result.runWindow as { examined: number; attention: { statuses: string[]; matchedCount: number } };
    expect(window.attention.statuses).toEqual(["running", "paused", "blocked", "failed"]);
    expect(window.attention.matchedCount).toBe(1);

    const items = result.items as Array<{ evidence?: { runIds?: string[] } }>;
    const cited = new Set(items.flatMap((item) => item.evidence?.runIds ?? []));
    expect(cited.has("run_blocked_old")).toBe(true);

    // Still bounded: two windows, never the fleet.
    expect(repo.fullFleetReads).toBe(0);
    expect(repo.recordsRead).toBeLessThanOrEqual(20 + 50);
  });

  it("reports no window when every matching run fits inside it", async () => {
    const repo = new CountingExecutionRepository();
    const result = dataOf(
      await toolNamed(repo, "constellation.get_summary").execute({
        // A range covering the oldest ten runs only.
        from: ALL_RUNS[0].startedAt,
        to: ALL_RUNS[9].startedAt
      })
    );
    const summary = result.summary as { runs: { total: number; examined?: number; windowed?: boolean }; caveats: string[] };

    expect(summary.runs.total).toBe(10);
    expect(summary.runs.examined).toBe(10);
    expect(summary.runs.windowed).toBe(false);
    expect(repo.recordsRead).toBe(10);
    // No "we only read the newest N" caveat when nothing was left unread.
    expect(summary.caveats.some((caveat) => caveat.includes("Run-derived figures read"))).toBe(false);
  });
});
