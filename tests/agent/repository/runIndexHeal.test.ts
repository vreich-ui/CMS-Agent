import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobExecutionRepository, RUN_INDEX_HEAL_FAILED, RUN_INDEX_HEAL_OK, RUN_INDEX_VERSION } from "../../../src/agent/repository/blobs/BlobExecutionRepository.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W1 acceptance for H2. `workflow_list_runs {detail:"summary"}` is supposed to open no run records
// at all; it opens one per row whose index entry predates RUN_INDEX_VERSION, and the write that
// makes that repair permanent used to be `.catch(() => undefined)`. A store whose index writes were
// failing therefore re-read up to `limit` run blobs on EVERY listing, silently, forever — the only
// mechanism that explains a 60 KB listing measuring 23 s while a 310 KB read measured 7 s.

const runRecord = (runId: string): WorkflowExecutionRecord => ({
  runId, projectId: "dr-lurie", workflowId: "publishing_conductor", status: "completed",
  startedAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
  nodes: [{ nodeId: "input_triage", status: "completed" }], artifacts: [], errors: [],
  approvalsRequired: [], stageOutputs: {}, dryRun: true, rev: 1
} as unknown as WorkflowExecutionRecord);

/** A store whose index writes can be made to fail, so the silent-heal defect is reproducible. */
const makeStore = (options: { indexWritesFail?: boolean } = {}) => {
  const data = new Map<string, unknown>();
  const reads: string[] = [];
  const store = {
    async get(key: string) { reads.push(key); return structuredClone(data.get(key) ?? null); },
    async getWithMetadata(key: string) { reads.push(key); const value = data.get(key); return value === undefined ? null : { data: structuredClone(value), etag: "1", metadata: {} }; },
    async setJSON(key: string, value: unknown) {
      if (options.indexWritesFail && key.startsWith("run-index/")) return { modified: false };
      data.set(key, structuredClone(value));
      return { modified: true, etag: "2" };
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: "1" })), directories: [] };
    },
    async delete(key: string) { data.delete(key); }
  } as unknown as BlobStoreClient;
  return { store, data, reads };
};

/** Seeds runs plus an index whose rows are one version behind — exactly production's shape. */
const seedStaleIndex = (data: Map<string, unknown>, runIds: string[]) => {
  for (const runId of runIds) data.set(`runs/${runId}.json`, runRecord(runId));
  data.set("run-index/!meta.json", { backfilledAt: "2026-09-01T00:00:00.000Z", v: RUN_INDEX_VERSION - 1 });
  data.set(`run-index/${encodeURIComponent("dr-lurie")}.json`, {
    runs: runIds.map((runId) => ({
      runId, projectId: "dr-lurie", workflowId: "publishing_conductor", status: "completed",
      startedAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z", v: RUN_INDEX_VERSION - 1
    }))
  });
};

const runBlobReads = (reads: string[]) => reads.filter((key) => key.startsWith("runs/")).length;

describe("W1 — the run index heal is loud, batched and never repeated", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { info.mockRestore(); warn.mockRestore(); });

  it("repairs stale rows once, reports it, and reads no run blob on the next listing", async () => {
    const { store, data, reads } = makeStore();
    seedStaleIndex(data, ["run_a", "run_b", "run_c"]);
    const repository = new BlobExecutionRepository(store);

    const first = await repository.listRunSummariesPage({ projectId: "dr-lurie", limit: 50 });
    expect(first.rows).toHaveLength(3);
    expect(runBlobReads(reads)).toBe(3);
    expect(info.mock.calls.some(([name]) => name === RUN_INDEX_HEAL_OK)).toBe(true);

    reads.length = 0;
    const second = await repository.listRunSummariesPage({ projectId: "dr-lurie", limit: 50 });
    expect(second.rows).toHaveLength(3);
    // The whole point: a repaired index is read as an index.
    expect(runBlobReads(reads)).toBe(0);
  });

  it("says so when the repair does not persist, instead of re-reading forever in silence", async () => {
    const { store, data, reads } = makeStore({ indexWritesFail: true });
    seedStaleIndex(data, ["run_a", "run_b", "run_c"]);
    const repository = new BlobExecutionRepository(store);

    await repository.listRunSummariesPage({ projectId: "dr-lurie", limit: 50 });
    expect(runBlobReads(reads)).toBe(3);
    expect(warn.mock.calls.some(([name]) => name === RUN_INDEX_HEAL_FAILED)).toBe(true);

    // ...and the rows it already paid for are remembered, so the SAME instance does not buy them
    // again on the next paint. Before W1 this was three more blob reads, and three more after that.
    reads.length = 0;
    const second = await repository.listRunSummariesPage({ projectId: "dr-lurie", limit: 50 });
    expect(second.rows).toHaveLength(3);
    expect(runBlobReads(reads)).toBe(0);

    const details = (await repository.health()).details as { runIndexRepairsFailed: number };
    expect(details.runIndexRepairsFailed).toBe(3);
  });
});
