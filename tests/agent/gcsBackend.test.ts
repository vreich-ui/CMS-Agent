import { afterEach, describe, expect, it } from "vitest";
import type { Bucket } from "@google-cloud/storage";
import { GcsStoreClient } from "../../src/agent/repository/gcs/gcsStoreClient.js";
import { registerCmsAgentStoreFactory, type BlobStoreClient } from "../../src/agent/repository/blobs/blobClient.js";
import { BlobExecutionRepository } from "../../src/agent/repository/blobs/BlobExecutionRepository.js";
import { BlobWorkspaceRepository } from "../../src/agent/repository/blobs/BlobWorkspaceRepository.js";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { RunConcurrencyError } from "../../src/agent/repository/interfaces/ExecutionRepository.js";
import { migrateStore, verifyStore } from "../../src/agent/entrypoints/migrateStoreJob.js";
import type { WorkflowExecutionRecord } from "../../src/agent/workspace/executionTypes.js";

// In-memory stand-in for a GCS bucket implementing exactly the surface GcsStoreClient touches:
// per-object monotonic generations and ifGenerationMatch preconditions (412), 404s for missing
// objects, prefix listing with generation metadata.
type StoredObject = { contents: string; generation: number };
const statusError = (code: number) => Object.assign(new Error(`gcs_${code}`), { code });
const makeFakeBucket = () => {
  const objects = new Map<string, StoredObject>();
  let nextGeneration = 1;
  const bucket = {
    objects,
    file(name: string, opts?: { generation?: number }) {
      const self: {
        metadata?: { generation: number };
        save: (data: string, saveOpts?: { preconditionOpts?: { ifGenerationMatch?: number } }) => Promise<void>;
        download: () => Promise<[Buffer]>;
        getMetadata: () => Promise<[{ generation: number }]>;
        delete: () => Promise<void>;
      } = {
        async save(data, saveOpts) {
          const match = saveOpts?.preconditionOpts?.ifGenerationMatch;
          if (match !== undefined && (objects.get(name)?.generation ?? 0) !== match) throw statusError(412);
          const generation = nextGeneration++;
          objects.set(name, { contents: data, generation });
          self.metadata = { generation };
        },
        async download() {
          const current = objects.get(name);
          if (!current || (opts?.generation !== undefined && current.generation !== opts.generation)) throw statusError(404);
          return [Buffer.from(current.contents, "utf8")];
        },
        async getMetadata() {
          const current = objects.get(name);
          if (!current) throw statusError(404);
          return [{ generation: current.generation }];
        },
        async delete() {
          if (!objects.delete(name)) throw statusError(404);
        }
      };
      return self;
    },
    async getFiles(options: { prefix?: string } = {}) {
      const prefix = options.prefix ?? "";
      return [[...objects.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, object]) => ({ name, metadata: { generation: object.generation } }))];
    }
  };
  return bucket;
};

const clientFor = (bucket: ReturnType<typeof makeFakeBucket>, prefix = "") =>
  new GcsStoreClient(prefix, bucket as unknown as Bucket) as unknown as BlobStoreClient;

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  registerCmsAgentStoreFactory(undefined);
});

describe("GcsStoreClient (BlobStoreClient over GCS)", () => {
  it("round-trips JSON with generation-based etags", async () => {
    const store = clientFor(makeFakeBucket());
    expect(await store.get("runs/missing.json", { type: "json" })).toBeNull();

    const first = await store.setJSON("runs/a.json", { value: 1 });
    expect(first).toMatchObject({ modified: true });
    expect(first.etag).toBeDefined();
    expect(await store.get("runs/a.json", { type: "json" })).toEqual({ value: 1 });

    const withMetadata = await store.getWithMetadata!("runs/a.json", { type: "json" });
    expect(withMetadata).toMatchObject({ data: { value: 1 }, etag: first.etag });
  });

  it("enforces onlyIfNew and onlyIfMatch as hard preconditions", async () => {
    const store = clientFor(makeFakeBucket());
    const first = await store.setJSON("workspace/current.json", { workspaceVersion: 1 });

    expect(await store.setJSON("workspace/current.json", { workspaceVersion: 99 }, { onlyIfNew: true })).toMatchObject({ modified: false });
    expect(await store.setJSON("workspace/current.json", { workspaceVersion: 99 }, { onlyIfMatch: "424242" })).toMatchObject({ modified: false });
    expect(await store.get("workspace/current.json", { type: "json" })).toEqual({ workspaceVersion: 1 });

    const second = await store.setJSON("workspace/current.json", { workspaceVersion: 2 }, { onlyIfMatch: first.etag! });
    expect(second.modified).toBe(true);
    expect(second.etag).not.toBe(first.etag);
  });

  it("namespaces all keys under the configured prefix (per-project seam)", async () => {
    const bucket = makeFakeBucket();
    const store = clientFor(bucket, "projects/p1/");
    await store.setJSON("runs/a.json", { value: 1 });

    expect(bucket.objects.has("projects/p1/runs/a.json")).toBe(true);
    const { blobs } = await store.list({ prefix: "runs/" });
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.key).toBe("runs/a.json");
    await store.delete("runs/a.json");
    expect(bucket.objects.size).toBe(0);
    await expect(store.delete("runs/a.json")).resolves.toBeUndefined();
  });
});

describe("lost-update race closed on GCS (Phase 2 acceptance)", () => {
  it("rejects the losing concurrent run writer with RunConcurrencyError", async () => {
    const bucket = makeFakeBucket();
    const repoA = new BlobExecutionRepository(clientFor(bucket));
    const repoB = new BlobExecutionRepository(clientFor(bucket));
    const created = await repoA.createRun({ runId: "run_race", workflowId: "w", projectId: "p", status: "queued", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "mock" } as unknown as WorkflowExecutionRecord);

    const readA = (await repoA.getRun(created.runId))!;
    const readB = (await repoB.getRun(created.runId))!;
    await repoA.saveRun({ ...readA, status: "running" });
    await expect(repoB.saveRun({ ...readB, status: "cancelled" })).rejects.toBeInstanceOf(RunConcurrencyError);
    expect((await repoA.getRun(created.runId))!.status).toBe("running");
  });

  it("rejects the losing concurrent workspace writer instead of clobbering", async () => {
    const bucket = makeFakeBucket();
    const repoA = new BlobWorkspaceRepository(clientFor(bucket));
    const repoB = new BlobWorkspaceRepository(clientFor(bucket));
    await repoA.getWorkspaceVersion(); // seeds the document
    await repoB.getWorkspaceVersion(); // loads it, capturing the current etag

    await repoA.updateNodePrompt("input_triage", "Writer A committed first.");
    const staleDocument = structuredClone((repoB as unknown as { document: unknown }).document);
    await expect((repoB as unknown as { save: (document: unknown) => Promise<void> }).save(staleDocument)).rejects.toThrow(/workspace_version_conflict/);
    await expect(new BlobWorkspaceRepository(clientFor(bucket)).getNode("input_triage")).resolves.toMatchObject({ prompt: "Writer A committed first." });
  });

  it("settles first-write seeding races via create-only writes (loser adopts the winner)", async () => {
    const bucket = makeFakeBucket();
    const repoA = new BlobWorkspaceRepository(clientFor(bucket));
    const repoB = new BlobWorkspaceRepository(clientFor(bucket));
    const [versionA, versionB] = await Promise.all([repoA.getWorkspaceVersion(), repoB.getWorkspaceVersion()]);

    expect(versionA).toBe(versionB);
    expect([...bucket.objects.keys()].filter((name) => name === "workspace/current.json")).toHaveLength(1);
  });
});

describe("gcs backend routing", () => {
  it("RepositoryManager reuses the blob repositories over the registered GCS store, with honest health", async () => {
    process.env.WORKSPACE_STORE = "gcs";
    const bucket = makeFakeBucket();
    registerCmsAgentStoreFactory(() => clientFor(bucket));

    const manager = new RepositoryManager({ backend: "gcs" });
    expect(manager.getWorkspaceRepository()).toBeInstanceOf(BlobWorkspaceRepository);
    expect(manager.getExecutionRepository()).toBeInstanceOf(BlobExecutionRepository);

    const health = await manager.getRepositoryHealth();
    expect(health.backend).toBe("gcs");
    expect(health.workspace.backend).toBe("gcs");
    expect(health.storageHealth).toBe("healthy");
    expect(bucket.objects.has("workspace/current.json")).toBe(true);
  });

  it("fails loudly when WORKSPACE_STORE=gcs has no registered store factory", () => {
    process.env.WORKSPACE_STORE = "gcs";
    expect(() => new RepositoryManager({ backend: "gcs" }).getWorkspaceRepository()).toThrow(/registerCmsAgentStoreFactory/);
  });
});

describe("store migration (blobs → gcs)", () => {
  const makeSourceStore = (seed: Record<string, unknown>): BlobStoreClient => {
    const data = new Map(Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]));
    return {
      get: async (key: string) => (data.has(key) ? structuredClone(data.get(key)) : null),
      setJSON: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); return { modified: true }; },
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({ blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: "source" })), directories: [] }),
      delete: async (key: string) => { data.delete(key); }
    } as unknown as BlobStoreClient;
  };

  const seed = {
    "workspace/current.json": { workspaceVersion: 7 },
    "runs/run_1.json": { runId: "run_1", rev: 3 },
    "usage/u1.json": { usageId: "u1" },
    "changes/c1.json": { record_type: "workspace_change_event" }
  };

  it("copies every key and verifies byte-for-byte, with dry-run counting only", async () => {
    const source = makeSourceStore(seed);
    const bucket = makeFakeBucket();
    const target = clientFor(bucket);

    const dry = await migrateStore({ source, target, dryRun: true });
    expect(dry).toMatchObject({ mode: "dry_run", keys: 4, copied: 0 });
    expect(bucket.objects.size).toBe(0);

    const result = await migrateStore({ source, target });
    expect(result).toMatchObject({ mode: "migrate", keys: 4, copied: 4, skipped: 0 });
    expect(result.byPrefix).toMatchObject({ workspace: 1, runs: 1, usage: 1, changes: 1 });

    const verify = await verifyStore({ source, target });
    expect(verify).toMatchObject({ keys: 4, matched: 4, mismatched: [], missingInTarget: [] });
  });

  it("verify reports mismatched and missing keys", async () => {
    const source = makeSourceStore(seed);
    const bucket = makeFakeBucket();
    const target = clientFor(bucket);
    await migrateStore({ source, target });
    await target.setJSON("runs/run_1.json", { runId: "run_1", rev: 999 });
    await target.delete("usage/u1.json");

    const verify = await verifyStore({ source, target });
    expect(verify.matched).toBe(2);
    expect(verify.mismatched).toEqual(["runs/run_1.json"]);
    expect(verify.missingInTarget).toEqual(["usage/u1.json"]);
  });
});
