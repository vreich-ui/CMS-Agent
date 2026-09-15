import { describe, expect, it, vi } from "vitest";
import { BlobExecutionRepository, RUN_INDEX_VERSION } from "../../../src/agent/repository/blobs/BlobExecutionRepository.js";
import { MemoryExecutionRepository } from "../../../src/agent/repository/memory/MemoryExecutionRepository.js";
import { runSummaryOf } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W4 — compact run rows. A list row used to cost one run-blob GET and still carry nodes[]:
// ~28KB per row, ~8s for twenty rows scoped to one project and 16s unscoped, measured live
// 2026-09-14. The row projection now lives in the run index, so `detail: "summary"` opens no
// run blobs at all.
//
// The property these tests exist to protect is not "it is fast" — it is that the INDEX AND THE
// RECORD AGREE. A counts row that drifts from the run it describes is worse than a slow one:
// nothing about it looks wrong.

const node = (nodeId: string, status: string) =>
  ({ nodeId, status, startedAt: "2026-08-25T12:00:00.000Z", completedAt: "2026-08-25T12:00:01.000Z", durationMs: 1000 }) as WorkflowExecutionRecord["nodes"][number];

const run = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord =>
  ({
    runId: "run_1",
    workflowId: "wf_1",
    projectId: "dr-lurie",
    status: "completed",
    startedAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:05:00.000Z",
    rev: 0,
    nodes: [node("alpha", "completed"), node("beta", "completed"), node("gamma", "queued")],
    stageOutputs: {},
    artifacts: [],
    errors: [],
    approvalsRequired: [],
    dryRun: true,
    executionMode: "mock",
    ...overrides
  }) as unknown as WorkflowExecutionRecord;

interface FakeStore {
  store: BlobStoreClient;
  runBlobGets: () => number;
  setCalls: () => string[];
  data: Map<string, unknown>;
}

const fakeStore = (seed: WorkflowExecutionRecord[], options: { seedIndex?: boolean; indexVersion?: number } = {}): FakeStore => {
  const data = new Map<string, unknown>(seed.map((r) => [`runs/${r.runId}.json`, r]));
  if (options.seedIndex) {
    // Defaults to the CURRENT index version, not a hardcoded number. The tests below that assert "this
    // page opened zero run blobs" mean "a CURRENT index costs nothing" — a hardcoded version turns
    // every future RUN_INDEX_VERSION bump into a false failure of those tests, because a stale row is
    // supposed to be healed by reading its run blob. The staleness tests pass `indexVersion`
    // explicitly and keep saying exactly what they mean.
    const version = options.indexVersion ?? RUN_INDEX_VERSION;
    const byProject = new Map<string, WorkflowExecutionRecord[]>();
    for (const r of seed) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
    for (const [projectId, runs] of byProject) {
      data.set(`run-index/${encodeURIComponent(projectId)}.json`, {
        // A pre-W4 index held only the filterable fields; that is what `indexVersion: 1` models.
        runs: runs.map((r) =>
          version >= 2
            ? { ...runSummaryOf(r), v: version }
            : { runId: r.runId, projectId: r.projectId, workflowId: r.workflowId, status: r.status, startedAt: r.startedAt, updatedAt: r.updatedAt }
        )
      });
    }
    data.set("run-index/!meta.json", { backfilledAt: "2026-08-29T00:00:00.000Z", ...(version >= 3 ? { v: version } : {}) });
  }
  let runBlobGets = 0;
  const setCalls: string[] = [];
  const store = {
    get: vi.fn(async (key: string) => {
      if (key.startsWith("runs/")) runBlobGets += 1;
      return data.has(key) ? structuredClone(data.get(key)) : null;
    }),
    getWithMetadata: vi.fn(async (key: string) => ({ data: data.has(key) ? structuredClone(data.get(key)) : null, etag: data.has(key) ? `etag-${key}` : undefined })),
    setJSON: vi.fn(async (key: string, value: unknown) => { setCalls.push(key); data.set(key, structuredClone(value)); return { modified: true }; }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({ blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) })),
    delete: vi.fn(async (key: string) => { data.delete(key); })
  } as unknown as BlobStoreClient;
  return { store, runBlobGets: () => runBlobGets, setCalls: () => setCalls, data };
};

describe("W4 — compact run rows", () => {
  const fleet = [
    run({ runId: "dl_1", startedAt: "2026-08-25T10:00:00.000Z" }),
    run({ runId: "dl_2", startedAt: "2026-08-25T11:00:00.000Z", status: "failed", errors: ["beta:boom", "beta:boom again"], nodes: [node("alpha", "completed"), node("beta", "failed")] }),
    run({ runId: "dl_3", startedAt: "2026-08-25T12:00:00.000Z", currentNodeId: "gamma", artifacts: [{ id: "a1" }] as never })
  ] as WorkflowExecutionRecord[];

  it("a summary page opens ZERO run blobs and still carries the counts a row displays", async () => {
    const { store, runBlobGets } = fakeStore(fleet, { seedIndex: true });
    const repo = new BlobExecutionRepository(store);

    const { rows, matchedCount, hasMore } = await repo.listRunSummariesPage({ projectId: "dr-lurie", limit: 2 });

    expect(rows.map((row) => row.runId)).toEqual(["dl_3", "dl_2"]); // newest first
    // THE point of W4: the page cost no run-record reads at all.
    expect(runBlobGets()).toBe(0);
    expect(matchedCount).toBe(3);
    expect(hasMore).toBe(true);

    const failed = rows[1];
    expect(failed.status).toBe("failed");
    expect(failed.nodeCount).toBe(2);
    expect(failed.completedCount).toBe(1);
    expect(failed.failedCount).toBe(1);
    expect(failed.errorCount).toBe(2);
    // No nodes[] on a row — the array is the weight this change removed.
    expect((failed as Record<string, unknown>).nodes).toBeUndefined();
  });

  it("a summary row is small — well under a kilobyte where a full row was tens of them", async () => {
    const { store } = fakeStore(fleet, { seedIndex: true });
    const repo = new BlobExecutionRepository(store);
    const { rows } = await repo.listRunSummariesPage({ limit: 3 });
    for (const row of rows) {
      expect(JSON.stringify(row).length).toBeLessThan(1_024);
    }
  });

  it("REVIEW FIX — an index written before W4 heals PER PAGE, never by scanning the fleet inline", async () => {
    // The defect this guards: a version-triggered full backfill meant every cold Cloud Run
    // instance did store.list("runs/") plus a GET of every run blob, inline, on its first
    // request — the exact read that kills a 1 vCPU instance — and again on every autoscale.
    // Healing is instead bounded by the page: a listing repairs the stale entries in its OWN
    // window and writes them back once.
    const wide = [
      ...fleet,
      ...Array.from({ length: 30 }, (_, i) => run({ runId: `bulk_${i}`, startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }))
    ];
    const { store, runBlobGets, setCalls } = fakeStore(wide, { seedIndex: true, indexVersion: 1 });
    const repo = new BlobExecutionRepository(store);

    const first = await repo.listRunSummariesPage({ projectId: "dr-lurie", limit: 3 });
    expect(first.rows.map((row) => row.nodeCount)).toEqual([3, 2, 3]);
    // Three rows repaired — three run blobs read. NOT the other 30.
    expect(runBlobGets()).toBe(3);
    // ...and written back in ONE index write, not one CAS loop per row racing the others.
    expect(setCalls().filter((key) => key.startsWith("run-index/"))).toHaveLength(1);

    const before = runBlobGets();
    const second = await repo.listRunSummariesPage({ projectId: "dr-lurie", limit: 3 });
    expect(second.rows.map((row) => row.runId)).toEqual(first.rows.map((row) => row.runId));
    expect(runBlobGets()).toBe(before);
  });

  it("a page that drops every row still hands back a cursor, so paging is never a dead end", async () => {
    // hasMore is computed over the index window; rows can be fewer (a ghost entry). A page that
    // says "there are more" and offers no cursor makes the rest of the fleet unreachable.
    const { store, data } = fakeStore(fleet, { seedIndex: true });
    for (const record of fleet) data.delete(`runs/${record.runId}.json`);
    // Force the repair path by marking the entries stale, so the missing blobs are noticed.
    const index = data.get("run-index/dr-lurie.json") as { runs: Array<Record<string, unknown>> };
    for (const entry of index.runs) delete entry.v;
    const repo = new BlobExecutionRepository(store);

    const page = await repo.listRunSummariesPage({ projectId: "dr-lurie", limit: 2 });
    expect(page.rows).toHaveLength(0);
    expect(page.lastKey).toBeDefined();
  });

  it("drift guard: every write path leaves the index row equal to runSummaryOf(the record)", async () => {
    const { store, data } = fakeStore([], {});
    const repo = new BlobExecutionRepository(store);

    const indexRowFor = (runId: string, projectId: string) => {
      const index = data.get(`run-index/${encodeURIComponent(projectId)}.json`) as { runs: Array<Record<string, unknown>> };
      const { v: _v, ...row } = index.runs.find((entry) => entry.runId === runId) ?? {};
      return row;
    };

    // createRun
    const created = await repo.createRun(run({ runId: "w_1", status: "running", nodes: [node("alpha", "completed"), node("beta", "running")] }));
    expect(indexRowFor("w_1", "dr-lurie")).toEqual(runSummaryOf(created));

    // saveRun — statuses and counts move together
    const saved = await repo.saveRun({ ...created, status: "failed", errors: ["beta:boom"], nodes: [node("alpha", "completed"), node("beta", "failed")] });
    expect(indexRowFor("w_1", "dr-lurie")).toEqual(runSummaryOf(saved));
    expect(indexRowFor("w_1", "dr-lurie")).toMatchObject({ status: "failed", failedCount: 1, completedCount: 1, errorCount: 1 });

    // resetRun
    const reset = await repo.resetRun("w_1", run({ runId: "w_1", status: "queued", errors: [], nodes: [node("alpha", "queued"), node("beta", "queued")] }));
    expect(indexRowFor("w_1", "dr-lurie")).toEqual(runSummaryOf(reset));
    expect(indexRowFor("w_1", "dr-lurie")).toMatchObject({ failedCount: 0, completedCount: 0, errorCount: 0 });
  });

  it("both backends answer the same rows from the same reading", async () => {
    const { store } = fakeStore(fleet, { seedIndex: true });
    const blobs = new BlobExecutionRepository(store);
    const memory = new MemoryExecutionRepository();
    for (const record of fleet) await memory.createRun(record);

    const fromBlobs = await blobs.listRunSummariesPage({ limit: 3 });
    const fromMemory = await memory.listRunSummariesPage({ limit: 3 });
    expect(fromBlobs.rows).toEqual(fromMemory.rows);
    expect(fromBlobs.matchedCount).toBe(fromMemory.matchedCount);
  });

  it("a running row carries the stall facts, so a summary row reaches the same stall verdict as a record", async () => {
    const running = run({
      runId: "live_1",
      status: "running",
      nodes: [
        node("alpha", "completed"),
        { nodeId: "beta", status: "running", dispatch: { dispatchedAt: "2026-08-25T12:04:00.000Z", timeoutMs: 60_000 } } as never
      ]
    });
    const { store } = fakeStore([running], { seedIndex: true });
    const repo = new BlobExecutionRepository(store);

    const { rows } = await repo.listRunSummariesPage({ limit: 1 });
    expect(rows[0].stallFacts).toEqual({
      status: "running",
      startedAt: running.startedAt,
      updatedAt: running.updatedAt,
      inFlight: { nodeId: "beta", dispatchedAt: "2026-08-25T12:04:00.000Z", timeoutMs: 60_000 },
      remainingNodeIds: ["beta"]
    });

    // A terminal row carries none of it — dead weight on every row in the fleet otherwise.
    const { rows: terminal } = await (async () => {
      const f = fakeStore(fleet, { seedIndex: true });
      return new BlobExecutionRepository(f.store).listRunSummariesPage({ limit: 3 });
    })();
    for (const row of terminal) expect(row.stallFacts).toBeUndefined();
  });
});
