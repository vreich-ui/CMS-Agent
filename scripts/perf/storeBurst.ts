/**
 * W0 — offline reproduction of the Workbench first-paint burst against the REAL workspace read
 * path (`BlobWorkspaceRepository` over `GcsStoreClient`), with a simulated GCS bucket that counts
 * round trips and charges a fixed per-operation latency.
 *
 * Why this exists: the live harness (`scripts/perf/workbench-load.mjs`) needs a bearer for the
 * control plane, and its numbers move with whatever else the plane is serving. This one is
 * deterministic, runs in CI, and isolates the single question H1 asks — how many times does one
 * first paint download and re-parse `workspace/current.json`?
 *
 *   npm run perf:store-burst            (defaults: 15 concurrent reads, 40 ms per GCS op)
 *   npm run perf:store-burst -- --ops 15 --latency 40 --json docs/perf/raw/store-burst.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GcsStoreClient } from "../../src/agent/repository/gcs/gcsStoreClient.js";
import { BlobWorkspaceRepository } from "../../src/agent/repository/blobs/BlobWorkspaceRepository.js";
import { createDefaultWorkspaceDocument, parseWorkspaceDocumentTolerant } from "../../src/agent/mcp/workspace/store.js";
import { workspaceStoreSeedNodes } from "../../src/agent/workspace/workspaceStoreNodes.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const OPS = Number(flag("ops", "15"));
const LATENCY_MS = Number(flag("latency", "40"));
const JSON_OUT = flag("json", "");

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export type BucketCounters = { getMetadata: number; download: number; save: number; bytesDownloaded: number };

/**
 * The narrow slice of `@google-cloud/storage`'s Bucket that GcsStoreClient touches, with a
 * per-operation delay and a counter for every round trip. Generations are monotonic so
 * ifGenerationMatch behaves as it does in production.
 */
export const makeCountingBucket = (latencyMs: number) => {
  const objects = new Map<string, { contents: string; generation: number }>();
  const counters: BucketCounters = { getMetadata: 0, download: 0, save: 0, bytesDownloaded: 0 };
  let nextGeneration = 1;
  const notFound = () => Object.assign(new Error("gcs_404"), { code: 404 });
  const bucket = {
    counters,
    objects,
    file(name: string, opts?: { generation?: number }) {
      const self = {
        metadata: undefined as { generation: number } | undefined,
        async save(data: string, saveOpts?: { preconditionOpts?: { ifGenerationMatch?: number } }) {
          counters.save++;
          await sleep(latencyMs);
          const match = saveOpts?.preconditionOpts?.ifGenerationMatch;
          if (match !== undefined && (objects.get(name)?.generation ?? 0) !== match) throw Object.assign(new Error("gcs_412"), { code: 412 });
          const generation = nextGeneration++;
          objects.set(name, { contents: data, generation });
          self.metadata = { generation };
        },
        async download(): Promise<[Buffer]> {
          counters.download++;
          await sleep(latencyMs);
          const current = objects.get(name);
          if (!current || (opts?.generation !== undefined && current.generation !== opts.generation)) throw notFound();
          counters.bytesDownloaded += Buffer.byteLength(current.contents);
          return [Buffer.from(current.contents, "utf8")];
        },
        async getMetadata(): Promise<[{ generation: number }]> {
          counters.getMetadata++;
          await sleep(latencyMs);
          const current = objects.get(name);
          if (!current) throw notFound();
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

/** A workspace document the size of the production one: every canonical seed node, prompts and
 *  schemas included. `workspace_get_nodes` measured 310 KB live; this lands in the same band. */
export const productionShapedDocument = () => {
  const document = createDefaultWorkspaceDocument();
  document.nodes = workspaceStoreSeedNodes();
  document.workspaceVersion = 42;
  return document;
};

/** The 15 reads a cold first paint funnels into the workspace document. Every one of them is a
 *  `load()` — see store.ts's read paths — regardless of how little of the document it returns. */
const burstReads = (repo: BlobWorkspaceRepository, nodeId: string, count: number) => {
  const reads: Array<() => Promise<unknown>> = [
    () => repo.getNodes(),
    () => repo.getNode(nodeId),
    () => repo.getWorkspaceVersion(),
    () => repo.listRelationships(),
    () => repo.listConversationalAgents(),
    () => repo.listStageOutputs(),
    () => repo.getCurrentRevisionId(),
    () => repo.listObservations(),
    () => repo.getEvents(),
    () => repo.getVersions()
  ];
  return Array.from({ length: count }, (_, i) => reads[i % reads.length]);
};

async function main() {
  const bucket = makeCountingBucket(LATENCY_MS);
  const client = new GcsStoreClient("", bucket as never, "perf-bucket");
  const document = productionShapedDocument();
  const documentBytes = Buffer.byteLength(JSON.stringify(document));
  bucket.objects.set("workspace/current.json", { contents: JSON.stringify(document), generation: 1 });

  const nodeId = document.nodes[0]?.id ?? "draft_writer";

  // COLD burst: a brand-new instance takes the first fifteen concurrent verbs of a page load with
  // nothing cached. This is the number coalescing has to move — before W1 it was one full
  // download-and-reparse per read.
  const coldRepo = new BlobWorkspaceRepository(client as never);
  const coldBefore = { ...bucket.counters };
  const coldStarted = performance.now();
  await Promise.all(burstReads(coldRepo, nodeId, OPS).map((read) => read()));
  const coldWallMs = Math.round(performance.now() - coldStarted);
  const cold = {
    getMetadata: bucket.counters.getMetadata - coldBefore.getMetadata,
    download: bucket.counters.download - coldBefore.download,
    bytesDownloaded: bucket.counters.bytesDownloaded - coldBefore.bytesDownloaded,
    wallMs: coldWallMs
  };

  // WARM burst: the same instance a moment later — the operator switching tabs, the rail
  // refetching. This is the number the micro-TTL has to move.
  const repo = new BlobWorkspaceRepository(client as never);
  await repo.getNodes();
  const warm = { ...bucket.counters };

  const started = performance.now();
  await Promise.all(burstReads(repo, nodeId, OPS).map((read) => read()));
  const wallMs = Math.round(performance.now() - started);

  const burst = {
    getMetadata: bucket.counters.getMetadata - warm.getMetadata,
    download: bucket.counters.download - warm.download,
    bytesDownloaded: bucket.counters.bytesDownloaded - warm.bytesDownloaded
  };

  // The transport is only half of H1. Every download is followed by JSON.parse + a zod
  // `parseWorkspaceDocumentTolerant` pass over the whole document, and Cloud Run gives this
  // service ONE vCPU — so those passes do not overlap, they queue. Measure both.
  const serialized = JSON.stringify(document);
  const parseStarted = performance.now();
  for (let i = 0; i < 10; i++) JSON.parse(serialized);
  const jsonParseMs = (performance.now() - parseStarted) / 10;
  const tolerantStarted = performance.now();
  for (let i = 0; i < 10; i++) parseWorkspaceDocumentTolerant(JSON.parse(serialized));
  const tolerantParseMs = (performance.now() - tolerantStarted) / 10;

  const report = {
    at: new Date().toISOString(),
    reads: OPS,
    simulatedGcsLatencyMs: LATENCY_MS,
    documentBytes,
    documentNodes: document.nodes.length,
    cold: { ...cold, roundTrips: cold.getMetadata + cold.download, megabytesDownloaded: Number((cold.bytesDownloaded / 1024 / 1024).toFixed(2)) },
    burst: {
      ...burst,
      roundTrips: burst.getMetadata + burst.download,
      roundTripsPerRead: Number(((burst.getMetadata + burst.download) / OPS).toFixed(2)),
      megabytesDownloaded: Number((burst.bytesDownloaded / 1024 / 1024).toFixed(2)),
      wallMs,
      jsonParseMs: Number(jsonParseMs.toFixed(1)),
      tolerantParseMs: Number(tolerantParseMs.toFixed(1)),
      cpuBoundMsPerBurst: Number((tolerantParseMs * burst.download).toFixed(0))
    }
  };

  console.log(`workspace document: ${(documentBytes / 1024).toFixed(0)} KB, ${document.nodes.length} nodes`);
  console.log(`COLD burst of ${OPS} concurrent reads (nothing cached) @ ${LATENCY_MS} ms/GCS op:`);
  console.log(`  round trips             : ${report.cold.roundTrips} (${cold.getMetadata} metadata + ${cold.download} download)`);
  console.log(`  bytes downloaded        : ${report.cold.megabytesDownloaded} MB`);
  console.log(`  wall clock              : ${cold.wallMs} ms`);
  console.log(`WARM burst of ${OPS} concurrent reads @ ${LATENCY_MS} ms/GCS op:`);
  console.log(`  getMetadata round trips : ${burst.getMetadata}`);
  console.log(`  download round trips    : ${burst.download}`);
  console.log(`  bytes re-downloaded     : ${report.burst.megabytesDownloaded} MB`);
  console.log(`  round trips per read    : ${report.burst.roundTripsPerRead}`);
  console.log(`  wall clock              : ${wallMs} ms`);
  console.log(`  parse cost per download : ${report.burst.tolerantParseMs} ms (JSON.parse alone ${report.burst.jsonParseMs} ms)`);
  console.log(`  serialised CPU per burst: ${report.burst.cpuBoundMsPerBurst} ms on one vCPU`);

  if (JSON_OUT) {
    const target = resolve(process.cwd(), JSON_OUT);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nraw: ${JSON_OUT}`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
