import { beforeEach, describe, expect, it, vi } from "vitest";
import { GcsStoreClient } from "../../../src/agent/repository/gcs/gcsStoreClient.js";
import { BlobWorkspaceRepository } from "../../../src/agent/repository/blobs/BlobWorkspaceRepository.js";
import { createDefaultWorkspaceDocument, type WorkspaceDocument } from "../../../src/agent/mcp/workspace/store.js";
import { workspaceStoreSeedNodes } from "../../../src/agent/workspace/workspaceStoreNodes.js";

// W1 acceptance. The claim under test is not "this got faster" — it is a COUNT: how many times does
// one burst of reads open the object store? Before W1 the answer was "once per read, unconditionally"
// (15 concurrent reads → 15 metadata calls + 15 downloads + 15 re-parses of an unchanged 321 KB
// document; docs/perf/workbench-2026-09-16.md). Counting round trips is deterministic and runs in CI,
// where a millisecond budget would only ever be flaky.

type StoredObject = { contents: string; generation: number };
const statusError = (code: number) => Object.assign(new Error(`gcs_${code}`), { code });

const makeCountingBucket = () => {
  const objects = new Map<string, StoredObject>();
  const counters = { getMetadata: 0, download: 0, save: 0 };
  let nextGeneration = 1;
  const bucket = {
    counters,
    objects,
    reset() { counters.getMetadata = 0; counters.download = 0; counters.save = 0; },
    file(name: string, opts?: { generation?: number }) {
      const self = {
        metadata: undefined as { generation: number } | undefined,
        async save(data: string, saveOpts?: { preconditionOpts?: { ifGenerationMatch?: number } }) {
          counters.save++;
          const match = saveOpts?.preconditionOpts?.ifGenerationMatch;
          if (match !== undefined && (objects.get(name)?.generation ?? 0) !== match) throw statusError(412);
          const generation = nextGeneration++;
          objects.set(name, { contents: data, generation });
          self.metadata = { generation };
        },
        async download(): Promise<[Buffer]> {
          counters.download++;
          const current = objects.get(name);
          if (!current || (opts?.generation !== undefined && current.generation !== opts.generation)) throw statusError(404);
          return [Buffer.from(current.contents, "utf8")];
        },
        async getMetadata(): Promise<[{ generation: number }]> {
          counters.getMetadata++;
          const current = objects.get(name);
          if (!current) throw statusError(404);
          return [{ generation: current.generation }];
        },
        async delete() { objects.delete(name); }
      };
      return self;
    },
    async getFiles({ prefix = "" }: { prefix?: string } = {}) {
      return [[...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([name, value]) => ({ name, metadata: { generation: value.generation } }))];
    }
  };
  return bucket;
};

const productionShapedDocument = (): WorkspaceDocument => {
  const document = createDefaultWorkspaceDocument();
  document.nodes = workspaceStoreSeedNodes();
  document.workspaceVersion = 42;
  return document;
};

/** The reads a cold Workbench paint funnels into the workspace document, 15 of them at once. */
const burst = (repository: BlobWorkspaceRepository, nodeId: string) => {
  const reads = [
    () => repository.getNodes(),
    () => repository.getNode(nodeId),
    () => repository.getWorkspaceVersion(),
    () => repository.listRelationships(),
    () => repository.listConversationalAgents(),
    () => repository.listStageOutputs(),
    () => repository.getCurrentRevisionId(),
    () => repository.listObservations(),
    () => repository.getEvents(),
    () => repository.getVersions()
  ];
  return Promise.all(Array.from({ length: 15 }, (_, i) => reads[i % reads.length]()));
};

describe("W1 workspace read model", () => {
  let bucket: ReturnType<typeof makeCountingBucket>;
  let client: GcsStoreClient;
  let document: WorkspaceDocument;

  beforeEach(() => {
    bucket = makeCountingBucket();
    client = new GcsStoreClient("", bucket as never, "test-bucket");
    document = productionShapedDocument();
    bucket.objects.set("workspace/current.json", { contents: JSON.stringify(document), generation: 1 });
    bucket.reset();
  });

  it("answers a cold burst of 15 concurrent reads with ONE download", async () => {
    const repository = new BlobWorkspaceRepository(client as never);
    await burst(repository, document.nodes[0].id);
    // Before W1: 15 and 15. The whole burst now shares one in-flight refresh.
    expect(bucket.counters.download).toBe(1);
    expect(bucket.counters.getMetadata).toBe(1);
  });

  it("answers a warm burst with no store access at all", async () => {
    const repository = new BlobWorkspaceRepository(client as never);
    await repository.getNodes();
    bucket.reset();
    await burst(repository, document.nodes[0].id);
    expect(bucket.counters.download).toBe(0);
    expect(bucket.counters.getMetadata).toBe(0);
  });

  it("past the TTL, an unchanged document costs one version check and no transfer", async () => {
    vi.useFakeTimers();
    try {
      const repository = new BlobWorkspaceRepository(client as never);
      await repository.getNodes();
      bucket.reset();
      vi.advanceTimersByTime(5000);
      await repository.getNodes();
      expect(bucket.counters.getMetadata).toBe(1);
      expect(bucket.counters.download).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("past the TTL, a document another writer changed is re-read, never served stale", async () => {
    vi.useFakeTimers();
    try {
      const repository = new BlobWorkspaceRepository(client as never);
      expect(await repository.getWorkspaceVersion()).toBe(42);
      // Another instance commits a new version straight to the store.
      bucket.objects.set("workspace/current.json", { contents: JSON.stringify({ ...document, workspaceVersion: 43 }), generation: 99 });
      vi.advanceTimersByTime(5000);
      expect(await repository.getWorkspaceVersion()).toBe(43);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a mutation read its base from the cache", async () => {
    const repository = new BlobWorkspaceRepository(client as never);
    await repository.getNodes();
    // A newer version lands in the store INSIDE the TTL window. A read may legitimately serve the
    // cached one; a mutation must not, or its compare-and-swap would be computed from stale bytes
    // and conflict forever.
    bucket.objects.set("workspace/current.json", { contents: JSON.stringify({ ...document, workspaceVersion: 43 }), generation: 99 });
    bucket.reset();
    const target = document.nodes[0].id;
    const result = await repository.updateNodePrompt(target, "rewritten by the test");
    expect(result.workspaceVersion).toBe(44);
    expect(bucket.counters.download).toBeGreaterThanOrEqual(1);
  });

  it("does not let a caller's mutation of a returned node leak into the next read", async () => {
    const repository = new BlobWorkspaceRepository(client as never);
    const first = await repository.getNode(document.nodes[0].id);
    expect(first).toBeDefined();
    (first as { prompt: string }).prompt = "clobbered in-process";
    const second = await repository.getNode(document.nodes[0].id);
    expect(second?.prompt).not.toBe("clobbered in-process");
  });

  it("reports the document size on health so growth is observable", async () => {
    const repository = new BlobWorkspaceRepository(client as never);
    await repository.getNodes();
    const details = (await repository.health()).details as { documentBytes?: number } | undefined;
    expect(details?.documentBytes).toBeGreaterThan(100_000);
  });
});

describe("W1 stage outputs live outside the workspace document", () => {
  let bucket: ReturnType<typeof makeCountingBucket>;
  let client: GcsStoreClient;
  let document: WorkspaceDocument;

  beforeEach(() => {
    bucket = makeCountingBucket();
    client = new GcsStoreClient("", bucket as never, "test-bucket");
    document = productionShapedDocument();
  });

  const storedDocument = (): WorkspaceDocument => JSON.parse(bucket.objects.get("workspace/current.json")!.contents);

  it("keeps the index in the document and the value in its own blob", async () => {
    bucket.objects.set("workspace/current.json", { contents: JSON.stringify(document), generation: 1 });
    const repository = new BlobWorkspaceRepository(client as never);
    const saved = await repository.saveStageOutput("draft_writer", { body: "x".repeat(5000) }, "run_1:exec_1:draft_writer");

    const indexed = storedDocument().stageOutputs;
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toEqual({ id: saved.id, stage: "draft_writer", createdAt: saved.createdAt });
    expect(indexed[0]).not.toHaveProperty("value");
    expect(bucket.objects.has(`stage-outputs/${encodeURIComponent(saved.id)}.json`)).toBe(true);

    // ...and reads still answer with the value, through both verbs.
    expect((await repository.getStageOutput(saved.id))?.value).toEqual({ body: "x".repeat(5000) });
    expect((await repository.listStageOutputs("draft_writer"))[0].value).toEqual({ body: "x".repeat(5000) });
  });

  it("still answers rows written before the split, from inside the document", async () => {
    document.stageOutputs = [{ id: "legacy_1", stage: "seo_writer", value: { legacy: true }, createdAt: new Date().toISOString() }];
    bucket.objects.set("workspace/current.json", { contents: JSON.stringify(document), generation: 1 });
    const repository = new BlobWorkspaceRepository(client as never);
    expect((await repository.getStageOutput("legacy_1"))?.value).toEqual({ legacy: true });
    expect((await repository.listStageOutputs())[0].value).toEqual({ legacy: true });
  });

  it("drains legacy rows out of the document a bounded slice at a time", async () => {
    document.stageOutputs = Array.from({ length: 40 }, (_, i) => ({ id: `legacy_${i}`, stage: "seo_writer", value: { i }, createdAt: new Date(2026, 0, 1 + i).toISOString() }));
    bucket.objects.set("workspace/current.json", { contents: JSON.stringify(document), generation: 1 });
    const repository = new BlobWorkspaceRepository(client as never);

    await repository.saveStageOutput("draft_writer", { first: true });
    const afterOne = storedDocument().stageOutputs.filter((output) => output.value !== undefined);
    expect(afterOne).toHaveLength(15); // 40 legacy - 25 drained
    // Every drained row still reads correctly, now from its own blob.
    expect((await repository.getStageOutput("legacy_0"))?.value).toEqual({ i: 0 });

    await repository.saveStageOutput("draft_writer", { second: true });
    expect(storedDocument().stageOutputs.filter((output) => output.value !== undefined)).toHaveLength(0);
    expect((await repository.getStageOutput("legacy_39"))?.value).toEqual({ i: 39 });
  });

  it("exports every value, so a backup is still complete", async () => {
    bucket.objects.set("workspace/current.json", { contents: JSON.stringify(document), generation: 1 });
    const repository = new BlobWorkspaceRepository(client as never);
    await repository.saveStageOutput("draft_writer", { body: "exported" }, "run_1:exec_1:draft_writer");
    const exported = await repository.exportWorkspace();
    expect(exported.stageOutputs).toHaveLength(1);
    expect(exported.stageOutputs[0].value).toEqual({ body: "exported" });
  });
});

// W7 — the stage-output drain used to strip a row's value from the document and only THEN try to
// write the blob, best-effort, on the stated ground that "a failed drain is retried by the next
// save, because the row is still in the document with its value intact". The same mutate had just
// deleted it. One failed blob write and the value was gone for good — and `exportWorkspace`, the
// backup path, would have exported the hole.
describe("the stage-output drain never destroys what it could not move", () => {
  it("leaves a legacy row's value in the document when its blob write fails, and drains it on the next try", async () => {
    const bucket = makeCountingBucket();
    const client = new GcsStoreClient("", bucket as never, "test-bucket");
    const document = productionShapedDocument();
    const legacyCreatedAt = new Date().toISOString();
    // A row written before the value moved out of the document: value in-document, no blob.
    document.stageOutputs = [{ id: "stage_legacy_w7", stage: "draft_writer", value: { keep: "me" }, createdAt: legacyCreatedAt }];
    bucket.objects.set("workspace/current.json", { contents: JSON.stringify(document), generation: 1 });

    const repository = new BlobWorkspaceRepository(client as never);
    const legacyKey = "stage-outputs/stage_legacy_w7.json";
    const realSave = bucket.file;
    // Fail exactly the drained row's blob write, and nothing else.
    bucket.file = ((name: string, opts?: { generation?: number }) => {
      const file = realSave.call(bucket, name, opts);
      if (name !== legacyKey) return file;
      return { ...file, save: async () => { throw new Error("503 from the store"); } };
    }) as typeof bucket.file;

    // Any save triggers the drain.
    await repository.saveStageOutput("research", { fresh: 1 });

    // THE ASSERTION. The value survived, because the row was not stripped.
    expect(bucket.objects.has(legacyKey)).toBe(false);
    expect((await repository.getStageOutput("stage_legacy_w7"))?.value).toEqual({ keep: "me" });

    // ...and once the store recovers, the next save moves it out for real.
    bucket.file = realSave;
    await repository.saveStageOutput("research", { fresh: 2 });
    expect(bucket.objects.has(legacyKey)).toBe(true);
    const drainedRow = JSON.parse(bucket.objects.get("workspace/current.json")!.contents).stageOutputs
      .find((row: { id: string }) => row.id === "stage_legacy_w7");
    expect(drainedRow).not.toHaveProperty("value");
    expect((await repository.getStageOutput("stage_legacy_w7"))?.value).toEqual({ keep: "me" });
  });
});
