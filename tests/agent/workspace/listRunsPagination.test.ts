import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { DEFAULT_LIST_RUNS_LIMIT, InvalidListRunsCursorError, MAX_LIST_RUNS_LIMIT, listRunsPage, summarizeRunForList } from "../../../src/agent/workspace/executor.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// Session A (2026-08-03): workflow.list_runs pagination + filters. PR #105 bounded each ROW; this
// bounds the LIST — without a page window the response regrows linearly as the run ledger
// accumulates, no matter how compact each row is.

const makeRun = (n: number, overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: `run_${String(n).padStart(4, "0")}`,
  workflowId: "publishing_conductor",
  projectId: "platform",
  status: "completed",
  startedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, n)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 7, 1, 0, 1, n)).toISOString(),
  nodes: [{ nodeId: "input_triage", status: "completed", produces: ["content_source.v1"] }],
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  executionMode: "mock",
  ...overrides
});

const seed = async (store: ExecutionRepository, runs: WorkflowExecutionRecord[]) => {
  for (const run of runs) await store.createRun(run);
};

describe("workflow.list_runs pagination", () => {
  it("defaults to a bounded page (newest first) and pages the remainder via nextCursor with no gaps or overlaps", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    await seed(store, Array.from({ length: 25 }, (_, i) => makeRun(i)));

    const first = await listRunsPage({}, store);
    expect(first.runs).toHaveLength(DEFAULT_LIST_RUNS_LIMIT);
    expect(first.page).toMatchObject({ limit: DEFAULT_LIST_RUNS_LIMIT, matchedCount: 25, hasMore: true });
    expect(first.page.nextCursor).toBeDefined();
    // Newest first: the last-created run leads.
    expect(first.runs[0].runId).toBe("run_0024");

    const second = await listRunsPage({ cursor: first.page.nextCursor }, store);
    expect(second.runs).toHaveLength(5);
    expect(second.page).toMatchObject({ matchedCount: 25, hasMore: false });
    expect(second.page.nextCursor).toBeUndefined();

    const all = [...first.runs, ...second.runs].map((run) => run.runId);
    expect(new Set(all).size).toBe(25);
    expect(all).toEqual([...all].sort().reverse());
  });

  it("clamps limit to the configured maximum and floor of 1", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    await seed(store, Array.from({ length: 3 }, (_, i) => makeRun(i)));
    expect((await listRunsPage({ limit: 2 }, store)).runs).toHaveLength(2);
    expect((await listRunsPage({ limit: 9999 }, store)).page.limit).toBe(MAX_LIST_RUNS_LIMIT);
    expect((await listRunsPage({ limit: 0 }, store)).page.limit).toBe(1);
  });

  it("filters by status", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const statuses: ExecutionStatus[] = ["completed", "failed", "running", "failed", "cancelled"];
    await seed(store, statuses.map((status, i) => makeRun(i, { status })));

    const failed = await listRunsPage({ status: "failed" }, store);
    expect(failed.page.matchedCount).toBe(2);
    expect(failed.runs.every((run) => run.status === "failed")).toBe(true);
  });

  it("filters by startedAt time range (inclusive both ends)", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    await seed(store, Array.from({ length: 10 }, (_, i) => makeRun(i)));
    const from = new Date(Date.UTC(2026, 7, 1, 0, 0, 3)).toISOString();
    const to = new Date(Date.UTC(2026, 7, 1, 0, 0, 6)).toISOString();

    const window = await listRunsPage({ from, to }, store);
    expect(window.runs.map((run) => run.runId)).toEqual(["run_0006", "run_0005", "run_0004", "run_0003"]);
  });

  it("pages stably across same-millisecond startedAt ties (runId is the tiebreak)", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const startedAt = new Date(Date.UTC(2026, 7, 1)).toISOString();
    await seed(store, Array.from({ length: 6 }, (_, i) => makeRun(i, { startedAt })));

    const first = await listRunsPage({ limit: 2 }, store);
    const second = await listRunsPage({ limit: 2, cursor: first.page.nextCursor }, store);
    const third = await listRunsPage({ limit: 2, cursor: second.page.nextCursor }, store);
    const all = [...first.runs, ...second.runs, ...third.runs].map((run) => run.runId);
    expect(new Set(all).size).toBe(6);
    expect(third.page.hasMore).toBe(false);
  });

  it("cursor composes with filters and refuses garbage cursors loudly", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    await seed(store, Array.from({ length: 8 }, (_, i) => makeRun(i, { status: i % 2 ? "failed" : "completed" })));

    const first = await listRunsPage({ status: "failed", limit: 2 }, store);
    const second = await listRunsPage({ status: "failed", limit: 2, cursor: first.page.nextCursor }, store);
    expect(first.runs).toHaveLength(2);
    expect(second.runs).toHaveLength(2);
    expect([...first.runs, ...second.runs].every((run) => run.status === "failed")).toBe(true);
    expect(second.page.hasMore).toBe(false);

    await expect(listRunsPage({ cursor: "not-a-cursor" }, store)).rejects.toThrow(InvalidListRunsCursorError);
  });

  it("preserves PR #105's compaction contract on paged rows: no stageOutputs, artifact values, or node input/output", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const huge = "x".repeat(100_000);
    await seed(store, [makeRun(0, {
      nodes: [{ nodeId: "article_body", status: "completed", input: huge, output: huge, produces: ["client_object.v1"] }],
      artifacts: [{ id: "artifact_1", nodeId: "article_body", type: "client_object.v1", value: huge, createdAt: new Date(Date.UTC(2026, 7, 1)).toISOString() }],
      initialInput: huge,
      stageOutputs: { article_body: huge }
    })]);

    const page = await listRunsPage({}, store);
    const row = summarizeRunForList(page.runs[0]) as Record<string, unknown>;
    expect(row).not.toHaveProperty("stageOutputs");
    expect(row).not.toHaveProperty("artifacts");
    expect(row).not.toHaveProperty("initialInput");
    expect((row.nodes as Record<string, unknown>[])[0]).not.toHaveProperty("input");
    expect((row.nodes as Record<string, unknown>[])[0]).not.toHaveProperty("output");
    expect(JSON.stringify(row).length).toBeLessThan(4_000);
  });
});
