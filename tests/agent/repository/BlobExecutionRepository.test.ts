import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobExecutionRepository } from "../../../src/agent/repository/blobs/BlobExecutionRepository.js";
import { MemoryExecutionRepository } from "../../../src/agent/repository/memory/MemoryExecutionRepository.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W1.2 (documented residual from W1.4/#232) — listRuns fetches every run blob before any filter is
// applied, so an unscoped call (no projectId) pays the same full-fleet fetch as every other call.
// These tests hold the stopgap short-TTL cache to its two jobs: collapse a burst of calls (scoped or
// not) into one blob-store round trip within the window, and never serve a caller its own stale write.

const run = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord =>
  ({
    runId: "run_1",
    workflowId: "wf_1",
    projectId: "dr-lurie",
    status: "completed",
    startedAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:05:00.000Z",
    rev: 0,
    stageOutputs: {},
    artifacts: [],
    ...overrides
  }) as unknown as WorkflowExecutionRecord;

// The compact per-project index entry shape the repository maintains under run-index/<projectId>.json.
const entryOf = (r: WorkflowExecutionRecord) => ({
  runId: r.runId,
  projectId: r.projectId,
  workflowId: r.workflowId,
  status: r.status,
  startedAt: r.startedAt,
  updatedAt: r.updatedAt
});
const indexKeyFor = (projectId: string) => `run-index/${encodeURIComponent(projectId)}.json`;
const META_KEY = "run-index/!meta.json";

type FakeStore = {
  store: BlobStoreClient;
  data: Map<string, unknown>;
  listCalls: () => number;
  listPrefixes: string[];
  // Reads of runs/<runId>.json specifically — the expensive fetch the W1.5 index exists to bound.
  runBlobGets: () => number;
  resetCounters: () => void;
};

// Fakes just enough of BlobStoreClient for BlobExecutionRepository: an in-memory map keyed exactly
// like the real store, with `list` and run-blob `get`s spied so tests can assert how many expensive
// store reads a listing actually performed. Optionally pre-seeds the per-project index + meta blobs
// (a store that W1.5 already backfilled).
const fakeStore = (seed: WorkflowExecutionRecord[], options: { seedIndex?: boolean } = {}): FakeStore => {
  const data = new Map<string, unknown>(seed.map((r) => [`runs/${r.runId}.json`, r]));
  if (options.seedIndex) {
    const byProject = new Map<string, WorkflowExecutionRecord[]>();
    for (const r of seed) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
    for (const [projectId, runs] of byProject) data.set(indexKeyFor(projectId), { runs: runs.map(entryOf) });
    data.set(META_KEY, { backfilledAt: "2026-08-29T00:00:00.000Z" });
  }
  let listCalls = 0;
  let runBlobGets = 0;
  const listPrefixes: string[] = [];
  const store = {
    get: vi.fn(async (key: string) => {
      if (key.startsWith("runs/")) runBlobGets += 1;
      return data.has(key) ? structuredClone(data.get(key)) : null;
    }),
    setJSON: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}` };
    }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => {
      listCalls += 1;
      listPrefixes.push(prefix);
      return { blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: `etag-${key}` })), directories: [] };
    }),
    delete: vi.fn(async () => undefined)
  } as unknown as BlobStoreClient;
  return { store, data, listCalls: () => listCalls, listPrefixes, runBlobGets: () => runBlobGets, resetCounters: () => { listCalls = 0; runBlobGets = 0; listPrefixes.length = 0; } };
};

describe("BlobExecutionRepository — full-fleet listRuns cache", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-08-30T00:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  it("a burst of calls within the TTL — scoped and unscoped alike — shares one blob-store scan", async () => {
    const { store, listCalls } = fakeStore([run({ runId: "a", projectId: "dr-lurie" }), run({ runId: "b", projectId: "zilberman" })]);
    const repo = new BlobExecutionRepository(store);

    const [all, drLurie, zilberman] = await Promise.all([repo.listRuns(), repo.listRuns({ projectId: "dr-lurie" }), repo.listRuns({ projectId: "zilberman" })]);

    expect(all.map((r) => r.runId).sort()).toEqual(["a", "b"]);
    expect(drLurie.map((r) => r.runId)).toEqual(["a"]);
    expect(zilberman.map((r) => r.runId)).toEqual(["b"]);
    // Three list_runs calls (one unscoped, two scoped), one actual full-fleet blob scan.
    expect(listCalls()).toBe(1);

    // Still within the TTL — a later sequential call reuses the same cached fetch too.
    await repo.listRuns({ projectId: "dr-lurie" });
    expect(listCalls()).toBe(1);
  });

  it("re-scans once the TTL has elapsed", async () => {
    const { store, listCalls } = fakeStore([run({ runId: "a" })]);
    const repo = new BlobExecutionRepository(store);

    await repo.listRuns();
    expect(listCalls()).toBe(1);

    vi.advanceTimersByTime(5_001);

    await repo.listRuns();
    expect(listCalls()).toBe(2);
  });

  it("never serves a caller its own write as stale: createRun/saveRun/resetRun each invalidate the cache", async () => {
    const { store, listCalls } = fakeStore([]);
    const repo = new BlobExecutionRepository(store);

    expect(await repo.listRuns()).toEqual([]);
    expect(listCalls()).toBe(1);

    const created = await repo.createRun(run({ runId: "new_run" }));
    expect((await repo.listRuns()).map((r) => r.runId)).toEqual(["new_run"]);
    expect(listCalls()).toBe(2);

    const saved = await repo.saveRun({ ...created, status: "failed" });
    expect((await repo.listRuns())[0].status).toBe("failed");
    expect(listCalls()).toBe(3);

    await repo.resetRun("new_run", { ...saved, status: "running", rev: saved.rev });
    expect((await repo.listRuns())[0].status).toBe("running");
    expect(listCalls()).toBe(4);
  });

  it("a failed fetch does not poison the cache for the rest of the TTL window", async () => {
    const { store } = fakeStore([run({ runId: "a" })]);
    let failNext = true;
    const originalList = store.list.bind(store);
    store.list = vi.fn(async (...args: Parameters<typeof originalList>) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient store error");
      }
      return originalList(...args);
    }) as unknown as BlobStoreClient["list"];
    const repo = new BlobExecutionRepository(store);

    await expect(repo.listRuns()).rejects.toThrow("transient store error");
    // Immediately retrying (still inside what would have been the TTL window) must not replay the
    // same rejection — the failed fetch is not cached.
    await expect(repo.listRuns()).resolves.toEqual([run({ runId: "a" })]);
  });
});

// W1.5 — per-project run index. A scoped or windowed listing must read the small index blob(s) and
// then fetch ONLY the run blobs it will return, never the whole fleet. These spy tests count the
// exact store reads to hold that boundary.
describe("BlobExecutionRepository — W1.5 per-project run index", () => {
  const fleet = [
    run({ runId: "dl_1", projectId: "dr-lurie", startedAt: "2026-08-25T10:00:00.000Z" }),
    run({ runId: "dl_2", projectId: "dr-lurie", startedAt: "2026-08-25T11:00:00.000Z", status: "failed" }),
    run({ runId: "dl_3", projectId: "dr-lurie", startedAt: "2026-08-25T12:00:00.000Z" }),
    run({ runId: "zb_1", projectId: "zilberman", startedAt: "2026-08-25T10:30:00.000Z" }),
    run({ runId: "zb_2", projectId: "zilberman", startedAt: "2026-08-25T11:30:00.000Z" })
  ] as WorkflowExecutionRecord[];

  it("listRuns({projectId, limit: N}) reads at most N run blobs plus the project's index — and no full-fleet scan", async () => {
    const { store, listCalls, listPrefixes, runBlobGets } = fakeStore(fleet, { seedIndex: true });
    const repo = new BlobExecutionRepository(store);

    const page = await repo.listRuns({ projectId: "dr-lurie", limit: 2 });

    expect(page.map((r) => r.runId)).toEqual(["dl_3", "dl_2"]); // newest first
    expect(runBlobGets()).toBe(2); // exactly the page's blobs — never the other 3 runs
    expect(listCalls()).toBe(0); // scoped: one index blob by key, no prefix enumeration at all
    expect(listPrefixes).not.toContain("runs/");
  });

  it("an unscoped windowed list reads the aggregated indexes and only page-sized run blobs", async () => {
    const { store, listPrefixes, runBlobGets } = fakeStore(fleet, { seedIndex: true });
    const repo = new BlobExecutionRepository(store);

    const { runs, matchedCount, hasMore } = await repo.listRunsPage({ limit: 2 });

    expect(runs.map((r) => r.runId)).toEqual(["dl_3", "zb_2"]);
    expect(matchedCount).toBe(5);
    expect(hasMore).toBe(true);
    expect(runBlobGets()).toBe(2); // 5 runs in the fleet, 2 fetched
    expect(listPrefixes).toEqual(["run-index/"]); // enumerates the small indexes, never runs/
  });

  it("status/time filters and the after-anchor apply BEFORE any run blob is fetched", async () => {
    const { store, runBlobGets } = fakeStore(fleet, { seedIndex: true });
    const repo = new BlobExecutionRepository(store);

    const { runs, matchedCount } = await repo.listRunsPage({ projectId: "dr-lurie", status: "failed", limit: 10 });
    expect(runs.map((r) => r.runId)).toEqual(["dl_2"]);
    expect(matchedCount).toBe(1);
    expect(runBlobGets()).toBe(1); // the two non-matching dr-lurie runs were filtered index-side
  });

  it("self-heals a missing index: the first read backfills every project's index from one scan, later reads use it", async () => {
    const { store, data, listPrefixes, resetCounters, runBlobGets, listCalls } = fakeStore(fleet); // NO index, NO meta — pre-W1.5 store
    const repo = new BlobExecutionRepository(store);

    const page = await repo.listRuns({ projectId: "zilberman", limit: 1 });
    expect(page.map((r) => r.runId)).toEqual(["zb_2"]);
    // The one-time backfill scanned the fleet and persisted the indexes + meta stamp.
    expect(listPrefixes).toContain("runs/");
    expect(data.has(indexKeyFor("dr-lurie"))).toBe(true);
    expect(data.has(indexKeyFor("zilberman"))).toBe(true);
    expect(data.has(META_KEY)).toBe(true);

    // A fresh repository instance (new process) over the now-backfilled store: steady state — index
    // read plus the page's single blob, no scans.
    resetCounters();
    const later = new BlobExecutionRepository(store);
    expect((await later.listRuns({ projectId: "zilberman", limit: 1 })).map((r) => r.runId)).toEqual(["zb_2"]);
    expect(listCalls()).toBe(0);
    expect(runBlobGets()).toBe(1);
  });

  it("self-heals a ghost entry: an index row whose run blob is gone is dropped from the listing AND pruned from the index", async () => {
    const { store, data } = fakeStore(fleet, { seedIndex: true });
    const ghost = entryOf(run({ runId: "deleted_run", projectId: "dr-lurie", startedAt: "2026-08-25T13:00:00.000Z" }));
    const seeded = data.get(indexKeyFor("dr-lurie")) as { runs: unknown[] };
    data.set(indexKeyFor("dr-lurie"), { runs: [...seeded.runs, ghost] });
    const repo = new BlobExecutionRepository(store);

    const { runs, matchedCount } = await repo.listRunsPage({ projectId: "dr-lurie", limit: 10 });

    expect(runs.map((r) => r.runId)).toEqual(["dl_3", "dl_2", "dl_1"]); // listing never fails, ghost silently dropped
    expect(matchedCount).toBe(3);
    const pruned = data.get(indexKeyFor("dr-lurie")) as { runs: { runId: string }[] };
    expect(pruned.runs.map((entry) => entry.runId).sort()).toEqual(["dl_1", "dl_2", "dl_3"]);
  });

  it("every write path keeps the index current: createRun inserts, saveRun updates status, resetRun rewrites", async () => {
    const { store, data } = fakeStore([], { seedIndex: true });
    const repo = new BlobExecutionRepository(store);

    const created = await repo.createRun(run({ runId: "w_1", projectId: "kugel", status: "running" }));
    expect((data.get(indexKeyFor("kugel")) as { runs: { runId: string; status: string }[] }).runs).toMatchObject([{ runId: "w_1", status: "running" }]);

    const saved = await repo.saveRun({ ...created, status: "failed" });
    expect((data.get(indexKeyFor("kugel")) as { runs: { status: string }[] }).runs).toMatchObject([{ status: "failed" }]);

    await repo.resetRun("w_1", { ...saved, status: "queued", rev: saved.rev });
    expect((data.get(indexKeyFor("kugel")) as { runs: { runId: string; status: string }[] }).runs).toMatchObject([{ runId: "w_1", status: "queued" }]);

    // And a scoped windowed read now serves the run from the index without any scan.
    const { runs } = await repo.listRunsPage({ projectId: "kugel", limit: 5 });
    expect(runs.map((r) => r.runId)).toEqual(["w_1"]);
  });

  it("an unscoped, unwindowed listRuns({}) still returns every run (constellation contract)", async () => {
    const { store } = fakeStore(fleet, { seedIndex: true });
    const repo = new BlobExecutionRepository(store);
    const all = await repo.listRuns({});
    expect(all.map((r) => r.runId)).toEqual(["dl_3", "zb_2", "dl_2", "zb_1", "dl_1"]);
  });
});

// W1.5 — both repositories implement the same windowed contract, so a test suite (or a caller)
// swapping backends sees identical filter, ordering, and pagination semantics.
describe("MemoryExecutionRepository mirrors the windowed listRuns contract", () => {
  it("blob and memory backends return identical pages for identical fleets", async () => {
    const fleet = [
      run({ runId: "a", projectId: "p1", startedAt: "2026-08-25T10:00:00.000Z" }),
      run({ runId: "b", projectId: "p1", startedAt: "2026-08-25T11:00:00.000Z", status: "failed" }),
      run({ runId: "c", projectId: "p2", startedAt: "2026-08-25T12:00:00.000Z" }),
      run({ runId: "d", projectId: "p1", startedAt: "2026-08-25T13:00:00.000Z" })
    ] as WorkflowExecutionRecord[];
    const blob = new BlobExecutionRepository(fakeStore(fleet, { seedIndex: true }).store);
    const memory = new MemoryExecutionRepository();
    for (const r of fleet) await memory.createRun(r);

    const queries = [
      {},
      { projectId: "p1" },
      { projectId: "p1", limit: 2 },
      { status: "failed" as const, limit: 5 },
      { limit: 2, after: { startedAt: "2026-08-25T13:00:00.000Z", runId: "d" } },
      { from: "2026-08-25T11:00:00.000Z", to: "2026-08-25T12:00:00.000Z" }
    ];
    for (const query of queries) {
      const [fromBlob, fromMemory] = [await blob.listRunsPage(query), await memory.listRunsPage(query)];
      expect(fromMemory.runs.map((r) => r.runId)).toEqual(fromBlob.runs.map((r) => r.runId));
      expect(fromMemory.matchedCount).toBe(fromBlob.matchedCount);
      expect(fromMemory.hasMore).toBe(fromBlob.hasMore);
    }
  });
});
