import { WorkspaceStateStore, createDefaultWorkspaceDocument, makeId, parseWorkspaceDocumentTolerant, type StageOutput, type WorkspaceDocument } from "../../mcp/workspace/store.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";
import { CachedJsonBlob, getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const key = "workspace/current.json";
const stageOutputKey = (id: string) => `stage-outputs/${encodeURIComponent(id)}.json`;

// How many legacy in-document stage outputs one save drains. The workspace document is read and
// rewritten by every mutation, so a migration that moved all of them at once would make ONE request
// pay for the whole backlog — the same shape as the run-index backfill incident (see
// BlobExecutionRepository.ensureIndex). Draining a bounded slice per save empties the backlog over
// the course of normal operation instead, and scripts/stage-output-split.mjs finishes it in one go.
const STAGE_OUTPUT_DRAIN_PER_SAVE = 25;
// A fleet-wide read of every stage output (export, an unfiltered listing) must not open 400 sockets.
const STAGE_OUTPUT_READ_CONCURRENCY = 8;

export class BlobWorkspaceRepository extends WorkspaceStateStore implements WorkspaceRepository {
  // ETag of the stored document this instance last accepted (from a load it trusted or a save it
  // committed). Saves are conditional on it, turning the load→mutate→save cycle into a hard
  // compare-and-swap wherever the store exposes ETags (always on GCS, environment-dependent on
  // Netlify Blobs). When the store yields no ETag the write degrades to the historical
  // unconditional behavior, still guarded by the version checks in the mutate() funnel.
  private lastEtag: string | undefined;

  // W1 — the read model. Before it, every one of WorkspaceStateStore's 21 read paths meant a full
  // download and re-parse of this document: a cold Workbench paint cost ~20 GCS round trips and
  // ~3.2 MB re-downloaded of bytes that never changed between the first read and the last
  // (docs/perf/workbench-2026-09-16.md). The cache collapses a burst into one refresh; see
  // CachedJsonBlob for the TTL / version-check / coalescing mechanics.
  private readonly cache: CachedJsonBlob<unknown>;

  // Size of the document as last downloaded, for the health surface and the stage-output split's
  // before/after accounting. Bytes only — never content.
  private lastDocumentBytes = 0;

  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {
    super(createDefaultWorkspaceDocument());
    this.cache = new CachedJsonBlob<unknown>(this.store, key, {
      onDownload: (data) => { this.lastDocumentBytes = JSON.stringify(data).length; }
    });
  }

  /**
   * `fresh` is the read half of a read-modify-write and bypasses both the TTL and the version
   * check — mutate() passes it, so a cached value can never be the base of a CAS.
   *
   * Every load returns a STRUCTURED CLONE. Before W1 each read re-parsed the document, so a caller
   * that mutated a node it was handed damaged only its own request; with a cached document that
   * same mutation would persist in-instance and be served to every later read. Cloning costs
   * ~1.7 ms against a 311 KB document — less than the 2.5 ms parse it replaces, and the round trips
   * it saves are worth two orders of magnitude more than either.
   */
  protected override async load(options?: { fresh?: boolean }): Promise<WorkspaceDocument> {
    const { data: raw, etag } = await this.cache.read(options);
    if (raw === null) {
      // No stored document visible. Under eventual consistency a read can lag a write this same
      // instance just committed, so prefer the locally-committed document (and keep the ETag from
      // our own committed save) over re-seeding a default.
      if (this.document.workspaceVersion > 0) return structuredClone(this.document);
      await this.seedIfAbsent(createDefaultWorkspaceDocument());
      return structuredClone(this.document);
    }
    // Tolerant parse: a single unusable node record must not brick every read/mutate. Invalid nodes
    // are dropped and the healed document is written back so the repair is permanent.
    const { document, droppedNodes } = parseWorkspaceDocumentTolerant(raw);
    // Optimistic-concurrency consistency: never return a version older than one this instance has
    // already committed. An eventually-consistent read can lag a write we just made; returning the
    // stale document would make getWorkspaceVersion() / expectedWorkspaceVersion checks report an
    // older "current" version than a mutation already produced. This guard runs BEFORE the heal
    // write-back so a stale corrupt snapshot can never be persisted over a newer committed version.
    // The stale read's ETag is discarded too — writing against it could only fail the CAS.
    if (this.document.workspaceVersion > document.workspaceVersion) return structuredClone(this.document);
    this.lastEtag = etag;
    if (droppedNodes > 0) {
      this.healedDroppedNodes += droppedNodes;
      await this.save(document);
      return structuredClone(document);
    }
    this.document = document;
    return structuredClone(document);
  }

  // First-write seeding races between instances are settled by the store: create-only write, and
  // the loser adopts the winner's document instead of clobbering it.
  private async seedIfAbsent(document: WorkspaceDocument): Promise<void> {
    const write = await this.store.setJSON(key, document, { onlyIfNew: true });
    if (write && (write as { modified?: boolean }).modified === false) {
      this.cache.invalidate();
      const current = await this.cache.read({ fresh: true });
      if (current.data !== null) {
        this.document = parseWorkspaceDocumentTolerant(current.data).document;
        this.lastEtag = current.etag;
        return;
      }
    }
    this.document = document;
    const seedResult = write as { etag?: string; etagVerified?: boolean } | undefined;
    this.lastEtag = seedResult?.etag ?? this.lastEtag;
    // Same rule as save() below: an unconfirmed etag is not something to cache against.
    if (seedResult?.etag !== undefined && seedResult.etagVerified !== false) this.cache.adopt(document, this.lastEtag);
    else this.cache.invalidate();
  }

  protected override async save(document: WorkspaceDocument) {
    const write = await this.store.setJSON(key, document, this.lastEtag !== undefined ? { onlyIfMatch: this.lastEtag } : undefined);
    if (write && (write as { modified?: boolean }).modified === false) {
      // A concurrent writer moved the stored document past the version this mutation was computed
      // from. Surfacing the same conflict family as the mutate() funnel keeps the caller contract
      // uniform: reload and retry. Nothing was overwritten — that is the point.
      //
      // The cache is dropped before throwing: whatever this instance holds is provably behind the
      // stored document, and the retry must not be able to read it back out of the TTL window.
      this.cache.invalidate();
      throw new Error("workspace_version_conflict: a concurrent writer updated workspace/current.json after this mutation loaded it; reload and retry (store compare-and-swap rejected the save).");
    }
    this.document = document;
    const result = write as { etag?: string; etagVerified?: boolean } | undefined;
    const etag = result?.etag;
    this.lastEtag = etag ?? this.lastEtag;
    // Adopt what we just wrote, so the read that follows a mutation costs nothing. A store that
    // reported no etag cannot be version-checked, so drop the cache instead of trusting it.
    //
    // W7 — and the same goes for an etag the store could not confirm came from THIS write
    // (`etagVerified: false` means it came from a metadata re-read, which may have picked up a
    // racing writer's generation). Adopting one of those pins our own superseded bytes to a
    // generation that will keep passing the version check, with no TTL to end it. Only the etag
    // that is ours is worth caching against; anything else costs one download and tells the truth.
    if (etag !== undefined && result?.etagVerified !== false) this.cache.adopt(document, etag);
    else this.cache.invalidate();
  }

  // -------------------------------------------------------------------------------------------
  // W1 — stage output values live outside the workspace document.
  //
  // `saveStageOutput` went through mutate(), so every completed node rewrote the ENTIRE workspace
  // document with one more output value appended to it — on the run hot path, and growing without
  // bound (436 rows workspace-wide as of 2026-09-15). The document is what all 21 read paths load,
  // so every stage output ever written was a tax on every read of every node's prompt.
  //
  // The index stays in the document — `{ id, stage, createdAt }` is a few dozen bytes and keeps
  // listing/filtering a pure in-memory operation. Only the VALUE moves, to `stage-outputs/<id>`.
  // Rows written before this change keep their in-document value and are still answered from it,
  // so nothing has to be migrated before this is correct; the drain below empties them over time.
  // -------------------------------------------------------------------------------------------

  override async saveStageOutput(stage: string, value: unknown, id = makeId("stage")): Promise<StageOutput> {
    const output: StageOutput = { id, stage, value, createdAt: new Date().toISOString() };
    // Value first: an indexed row whose blob is missing would read as an output with no value,
    // which is indistinguishable from an output whose value genuinely is null.
    await this.store.setJSON(stageOutputKey(id), output);

    // W7 CORRECTION — THE DRAIN USED TO DESTROY WHAT IT FAILED TO MOVE.
    //
    // It stripped the values from the index inside the mutate and wrote the blobs AFTERWARDS, with
    // `.catch(() => undefined)`, on the stated ground that "a failed drain is retried by the next
    // save, because the row is still in the document with its value intact". It was not: the very
    // same mutate had just deleted it. One 503 on one blob write and that stage output was gone —
    // `getStageOutput` would hydrate a missing blob and hand back a row with no value, which is
    // exactly the state the "Value first" rule above exists to prevent, and `exportWorkspace` (the
    // backup path) would export the hole.
    //
    // The old reasoning against writing first — "a crash leaves the value duplicated in both places
    // with no way to tell which is current" — does not hold either. A stage output is IMMUTABLE:
    // its id is minted per save and its value never changes, so both copies are the same bytes, and
    // `getStageOutput` prefers the in-document one deterministically. A duplicate costs a few
    // hundred bytes until the next drain; a lost value cannot be recovered at all.
    //
    // So: copy out first, then strip only what the store confirmed it has.
    const candidates = (await this.load()).stageOutputs
      .filter((existing) => existing.id !== id && existing.value !== undefined)
      .slice(0, STAGE_OUTPUT_DRAIN_PER_SAVE);
    const moved = new Set<string>();
    if (candidates.length) {
      await Promise.all(
        candidates.map(async (entry) => {
          try {
            await this.store.setJSON(stageOutputKey(entry.id), entry);
            moved.add(entry.id);
          } catch {
            // Left in the document with its value, and retried by the next save — which is what the
            // old comment claimed and this ordering actually delivers.
          }
        })
      );
    }
    await this.mutateStageIndex((document) => {
      const kept = document.stageOutputs.filter((existing) => existing.id !== id);
      document.stageOutputs = [
        ...kept.map((existing) => (moved.has(existing.id) ? { id: existing.id, stage: existing.stage, createdAt: existing.createdAt } : existing)),
        { id, stage, createdAt: output.createdAt }
      ];
    });
    return output;
  }

  override async getStageOutput(id: string): Promise<StageOutput | undefined> {
    const entry = (await this.load()).stageOutputs.find((output) => output.id === id);
    if (!entry) return undefined;
    return entry.value !== undefined ? entry : await this.hydrate(entry);
  }

  override async listStageOutputs(stage?: string): Promise<StageOutput[]> {
    const entries = (await this.load()).stageOutputs.filter((output) => !stage || output.stage === stage);
    return this.hydrateAll(entries);
  }

  /** Export must be complete — it is the backup path — so every value is fetched, bounded. */
  override async exportWorkspace(): Promise<WorkspaceDocument> {
    const document = await this.load();
    return { ...document, stageOutputs: await this.hydrateAll(document.stageOutputs) };
  }

  private async hydrate(entry: StageOutput): Promise<StageOutput> {
    if (entry.value !== undefined) return entry;
    const stored = await getBlobJson<StageOutput>(this.store, stageOutputKey(entry.id));
    // A missing blob returns the index row as-is (no `value`), which is what every caller already
    // handles for an output that has none — never a thrown error on a read path.
    return stored ? { ...entry, value: stored.value } : entry;
  }

  private async hydrateAll(entries: StageOutput[]): Promise<StageOutput[]> {
    const out = new Array<StageOutput>(entries.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(STAGE_OUTPUT_READ_CONCURRENCY, entries.length) }, async () => {
      while (cursor < entries.length) {
        const index = cursor++;
        out[index] = await this.hydrate(entries[index]);
      }
    }));
    return out;
  }

  /** mutate() is protected on the base class; this is the one stage-output write that needs it. */
  private async mutateStageIndex(update: (document: WorkspaceDocument) => void): Promise<void> {
    await this.mutate(update, undefined, "stage.output_saved");
  }

  async health(): Promise<RepositoryHealth> {
    return {
      ...healthyRepositoryStatus(storeBackendLabel()),
      version: "blobs.v1",
      // Surface self-healing so a dropped corrupt node is observable, never silent. documentBytes
      // is the stage-output split's before/after evidence, and a standing size alarm besides.
      ...(this.healedDroppedNodes > 0 || this.lastDocumentBytes > 0
        ? { details: { ...(this.healedDroppedNodes > 0 ? { healedDroppedNodes: this.healedDroppedNodes } : {}), ...(this.lastDocumentBytes > 0 ? { documentBytes: this.lastDocumentBytes } : {}) } }
        : {})
    };
  }
}
