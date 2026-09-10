import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushToolExecutionLedger, recordToolExecution } from "../../../src/agent/tools/toolExecutionLedger.js";
import { BlobToolExecutionRepository } from "../../../src/agent/repository/blobs/BlobToolExecutionRepository.js";
import { MemoryToolExecutionRepository } from "../../../src/agent/repository/memory/MemoryToolExecutionRepository.js";
import { getRepositoryManager, repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { ToolExecutionRecord } from "../../../src/agent/tools/toolTypes.js";

// ACCEPTANCE — the ledger's COST properties (W4 follow-up).
//
// W3.2.1 shipped the ledger correct and expensive: every tenant call waited for two sequential blob
// writes, and capture's emit_live makes ~58 tenant calls against a real site — ~116 round trips
// serialised into the longest stage on its route. Making it cheap is easy; making it cheap without
// quietly becoming a ledger that loses records, or one that lies to the reader who asks for them
// half a millisecond later, is the part worth testing.
//
// Three properties, and they constrain each other:
//   1. the write is off the caller's clock,
//   2. a reader still sees a write that has not landed yet (read-your-writes, via flush),
//   3. a bounded read bounds the DOWNLOADS, not just the answer.

const record = (over: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
  toolExecutionId: `tool_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  runId: "run_ledger", nodeId: "publish_executor", toolId: "object_publish",
  startedAt: new Date().toISOString(), status: "success", inputSummary: {},
  riskLevel: "publish", approvalStatus: "not_required", caller: "engine", projectId: "dr-lurie",
  ...over
});

beforeEach(() => {
  resetRepositoryManager();
});

describe("the write is off the caller's clock", () => {
  it("returns before the store has finished, and does not block on a store that never answers", async () => {
    // A store that never resolves. If recordToolExecution awaited it, this test would time out —
    // which is precisely what every tenant call used to do for as long as the store took.
    let release: (() => void) | undefined;
    const never = new Promise<ToolExecutionRecord>((resolve) => { release = () => resolve(record()); });
    vi.spyOn(getRepositoryManager(), "getToolExecutionRepository").mockReturnValue({ record: () => never } as never);

    let returned = false;
    recordToolExecution(record());
    returned = true;

    expect(returned).toBe(true);
    release?.();
    await flushToolExecutionLedger();
    vi.restoreAllMocks();
  });

  it("still never throws when the store rejects — an audit write cannot fail the call it describes", async () => {
    vi.spyOn(getRepositoryManager(), "getToolExecutionRepository").mockReturnValue({ record: async () => { throw new Error("store down"); } } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => recordToolExecution(record())).not.toThrow();
    await expect(flushToolExecutionLedger()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("read-your-writes", () => {
  // The failure this prevents: a ledger that answers "no records" for a call it was handed a moment
  // ago. That is worse than a slow ledger, because the reader believes it.
  it("flush makes an in-flight write visible", async () => {
    const written = record({ toolExecutionId: "tool_exec_flush_1" });
    recordToolExecution(written);
    await flushToolExecutionLedger();
    expect((await repositoryManager.getToolExecutionRepository().list({ runId: "run_ledger" })).map((entry) => entry.toolExecutionId))
      .toContain("tool_exec_flush_1");
  });

  it("flush drains writes started while an earlier flush was already awaiting", async () => {
    // One pass would leave the newest write unflushed — and the newest record is the one a reader
    // asking right now is most likely to want.
    recordToolExecution(record({ toolExecutionId: "tool_exec_wave_1" }));
    const draining = flushToolExecutionLedger();
    recordToolExecution(record({ toolExecutionId: "tool_exec_wave_2" }));
    await draining;
    await flushToolExecutionLedger();

    const ids = (await repositoryManager.getToolExecutionRepository().list({ runId: "run_ledger" })).map((entry) => entry.toolExecutionId);
    expect(ids).toContain("tool_exec_wave_1");
    expect(ids).toContain("tool_exec_wave_2");
  });
});

describe("the blob backend's cost properties", () => {
  const PROJECT_INDEX_META_KEY = "tool_executions/project-index/!meta.v1.json";
  const store = () => {
    const blobs = new Map<string, unknown>();
    const etags = new Map<string, string>();
    let nextEtag = 1;
    const reads: string[] = [];
    let concurrentWrites = 0;
    let peakConcurrentWrites = 0;
    return {
      blobs, reads,
      peak: () => peakConcurrentWrites,
      client: {
        setJSON: async (key: string, value: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
          concurrentWrites += 1;
          peakConcurrentWrites = Math.max(peakConcurrentWrites, concurrentWrites);
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (options?.onlyIfNew && blobs.has(key)) { concurrentWrites -= 1; return { modified: false }; }
          if (options?.onlyIfMatch && etags.get(key) !== options.onlyIfMatch) { concurrentWrites -= 1; return { modified: false }; }
          blobs.set(key, value);
          const etag = `etag_${nextEtag++}`;
          etags.set(key, etag);
          concurrentWrites -= 1;
          return { modified: true, etag };
        },
        get: async (key: string) => { reads.push(key); return blobs.has(key) ? blobs.get(key) : null; },
        getWithMetadata: async (key: string) => {
          reads.push(key);
          return blobs.has(key) ? { data: blobs.get(key), etag: etags.get(key) } : null;
        },
        list: async ({ prefix }: { prefix: string }) => ({ blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }),
        delete: async (key: string) => { blobs.delete(key); }
      }
    };
  };

  it("writes both indexes at once rather than one after the other", async () => {
    const double = store();
    await new BlobToolExecutionRepository(double.client as never).record(record({ toolExecutionId: "tool_exec_par_1" }));
    expect([...double.blobs.keys()].sort()).toEqual([
      "tool_executions/by-node/publish_executor/tool_exec_par_1.json",
      "tool_executions/by-run/run_ledger/tool_exec_par_1.json",
      "tool_executions/project-index/dr-lurie.json"
    ]);
    // Sequential direct-index writes would peak at 1. The project-index CAS write may overlap too,
    // but must never serialize the two immutable writes.
    expect(double.peak()).toBeGreaterThanOrEqual(2);
  });

  // THE REGRESSION THIS EXISTS FOR. `project.get.usedBy` filters by projectId only, and projectId has
  // no prefix of its own — so it lands on the unindexed run root. Slicing AFTER fetching would have
  // downloaded the entire ledger to return its newest 500: the read-amplification trap this class was
  // written to avoid, reintroduced by the one axis without an index.
  it("a limited read downloads only what it will return", async () => {
    const double = store();
    // This is a steady-state ledger. A pre-index ledger first self-heals from a complete scan;
    // that deliberate backfill is tested separately below and is not a limit-shaped read.
    double.blobs.set(PROJECT_INDEX_META_KEY, { schemaVersion: "tool_execution_project_index.v1", backfilledAt: "2026-09-10T00:00:00.000Z" });
    const repository = new BlobToolExecutionRepository(double.client as never);
    for (let index = 0; index < 60; index += 1) {
      await repository.record(record({ toolExecutionId: `tool_exec_17888000000${String(index).padStart(2, "0")}_x`, runId: `run_${index}` }));
    }
    double.reads.length = 0;

    const found = await repository.list({ projectId: "dr-lurie", limit: 5 });
    expect(found).toHaveLength(5);
    // Meta + one project index + the five selected records: never the other 55 call blobs.
    expect(double.reads.length).toBeLessThan(10);
  });

  it("a limited read returns the NEWEST records, oldest-first, matching the memory backend", async () => {
    const double = store();
    double.blobs.set(PROJECT_INDEX_META_KEY, { schemaVersion: "tool_execution_project_index.v1", backfilledAt: "2026-09-10T00:00:00.000Z" });
    const repository = new BlobToolExecutionRepository(double.client as never);
    // Ids carry Date.now(), so key order is time order — which is what lets the bound be applied
    // from the listing alone, without reading a blob to find out how old it is.
    for (const [index, stamp] of ["1788800000001", "1788800000002", "1788800000003"].entries()) {
      await repository.record(record({
        toolExecutionId: `tool_exec_${stamp}_x`,
        runId: `run_${index}`,
        startedAt: new Date(Number(stamp)).toISOString()
      }));
    }
    const found = await repository.list({ projectId: "dr-lurie", limit: 2 });
    expect(found.map((entry) => entry.toolExecutionId)).toEqual(["tool_exec_1788800000002_x", "tool_exec_1788800000003_x"]);
  });

  it("uses the call timestamp and id tie-breaker, not run/id key order, for resumed runs and every limit", async () => {
    const double = store();
    double.blobs.set(PROJECT_INDEX_META_KEY, { schemaVersion: "tool_execution_project_index.v1", backfilledAt: "2026-09-10T00:00:00.000Z" });
    const blob = new BlobToolExecutionRepository(double.client as never);
    const memory = new MemoryToolExecutionRepository();
    const entries = [
      record({ toolExecutionId: "tool_exec_a", runId: "run_newer_id", startedAt: "2026-09-10T10:00:00.000Z" }),
      record({ toolExecutionId: "tool_exec_z", runId: "run_resumed_old", startedAt: "2026-09-10T12:00:00.000Z" }),
      record({ toolExecutionId: "tool_exec_b", runId: "run_tie", startedAt: "2026-09-10T12:00:00.000Z" })
    ];
    for (const entry of entries) {
      await blob.record(entry);
      await memory.record(entry);
    }
    for (const limit of [0, 1, 2, 3]) {
      const expected = (await memory.list({ projectId: "dr-lurie", limit })).map((entry) => entry.toolExecutionId);
      expect((await blob.list({ projectId: "dr-lurie", limit })).map((entry) => entry.toolExecutionId)).toEqual(expected);
      // The node direct index has the same order and limit contract as the project index.
      expect((await blob.list({ nodeId: "publish_executor", limit })).map((entry) => entry.toolExecutionId))
        .toEqual((await memory.list({ nodeId: "publish_executor", limit })).map((entry) => entry.toolExecutionId));
    }
    // The tie resolves by execution id, so tool_exec_z is the single newest call.
    expect((await blob.list({ projectId: "dr-lurie", limit: 1 })).map((entry) => entry.toolExecutionId)).toEqual(["tool_exec_z"]);
  });

  it("backfills every pre-index project once, then a sparse tenant read is project-bounded", async () => {
    const double = store();
    for (let index = 0; index < 101; index += 1) {
      // Pre-index data: direct run/node copies only, as persisted by the prior ledger version.
      double.blobs.set(`tool_executions/by-run/run_${index}/legacy_${index}.json`, record({ toolExecutionId: `legacy_${index}`, runId: `run_${index}`, projectId: index === 100 ? "sparse" : "other", startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }));
    }
    const first = new BlobToolExecutionRepository(double.client as never);
    expect((await first.list({ projectId: "sparse", limit: 1 })).map((entry) => entry.toolExecutionId)).toEqual(["legacy_100"]);
    expect(double.blobs.has(PROJECT_INDEX_META_KEY)).toBe(true);

    double.reads.length = 0;
    const steady = new BlobToolExecutionRepository(double.client as never);
    expect((await steady.list({ projectId: "sparse", limit: 1 })).map((entry) => entry.toolExecutionId)).toEqual(["legacy_100"]);
    // Meta + sparse project's index + the one selected record — not 101 ledger downloads.
    expect(double.reads.length).toBeLessThanOrEqual(3);

    double.reads.length = 0;
    expect(await steady.list({ projectId: "absent", limit: 1 })).toEqual([]);
    // An absent project is two small key reads, not a sparse-tenant fleet scan.
    expect(double.reads.length).toBeLessThanOrEqual(2);
  });

  it("keeps no-run tenant calls queryable through the project index", async () => {
    const double = store();
    double.blobs.set(PROJECT_INDEX_META_KEY, { schemaVersion: "tool_execution_project_index.v1", backfilledAt: "2026-09-10T00:00:00.000Z" });
    const repository = new BlobToolExecutionRepository(double.client as never);
    await repository.record(record({ toolExecutionId: "tool_exec_no_run", runId: "(no-run)", nodeId: "(no-node)", projectId: "dr-lurie" }));
    expect((await repository.list({ projectId: "dr-lurie" })).map((entry) => entry.runId)).toEqual(["(no-run)"]);
  });
});
