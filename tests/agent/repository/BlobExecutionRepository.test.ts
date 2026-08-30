import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobExecutionRepository } from "../../../src/agent/repository/blobs/BlobExecutionRepository.js";
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
    rev: 0,
    stageOutputs: {},
    artifacts: [],
    ...overrides
  }) as unknown as WorkflowExecutionRecord;

// Fakes just enough of BlobStoreClient for BlobExecutionRepository: an in-memory map keyed exactly
// like the real store, with `list` spied so tests can assert how many times the full-fleet scan
// actually ran.
const fakeStore = (seed: WorkflowExecutionRecord[]): { store: BlobStoreClient; listCalls: () => number } => {
  const data = new Map<string, unknown>(seed.map((r) => [`runs/${r.runId}.json`, r]));
  let listCalls = 0;
  const store = {
    get: vi.fn(async (key: string) => (data.has(key) ? structuredClone(data.get(key)) : null)),
    setJSON: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}` };
    }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => {
      listCalls += 1;
      return { blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: `etag-${key}` })), directories: [] };
    }),
    delete: vi.fn(async () => undefined)
  } as unknown as BlobStoreClient;
  return { store, listCalls: () => listCalls };
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
