import { WorkspaceStateStore, createDefaultWorkspaceDocument, parseWorkspaceDocumentTolerant, type WorkspaceDocument } from "../../mcp/workspace/store.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";
import { getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const key = "workspace/current.json";

export class BlobWorkspaceRepository extends WorkspaceStateStore implements WorkspaceRepository {
  // ETag of the stored document this instance last accepted (from a load it trusted or a save it
  // committed). Saves are conditional on it, turning the load→mutate→save cycle into a hard
  // compare-and-swap wherever the store exposes ETags (always on GCS, environment-dependent on
  // Netlify Blobs). When the store yields no ETag the write degrades to the historical
  // unconditional behavior, still guarded by the version checks in the mutate() funnel.
  private lastEtag: string | undefined;

  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) { super(createDefaultWorkspaceDocument()); }

  protected override async load(): Promise<WorkspaceDocument> {
    const { data: raw, etag } = await getBlobJsonWithEtag<unknown>(this.store, key);
    if (raw === null) {
      // No stored document visible. Under eventual consistency a read can lag a write this same
      // instance just committed, so prefer the locally-committed document (and keep the ETag from
      // our own committed save) over re-seeding a default.
      if (this.document.workspaceVersion > 0) return this.document;
      await this.seedIfAbsent(createDefaultWorkspaceDocument());
      return this.document;
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
    if (this.document.workspaceVersion > document.workspaceVersion) return this.document;
    this.lastEtag = etag;
    if (droppedNodes > 0) {
      this.healedDroppedNodes += droppedNodes;
      await this.save(document);
      return document;
    }
    this.document = document;
    return document;
  }

  // First-write seeding races between instances are settled by the store: create-only write, and
  // the loser adopts the winner's document instead of clobbering it.
  private async seedIfAbsent(document: WorkspaceDocument): Promise<void> {
    const write = await this.store.setJSON(key, document, { onlyIfNew: true });
    if (write && (write as { modified?: boolean }).modified === false) {
      const current = await getBlobJsonWithEtag<unknown>(this.store, key);
      if (current.data !== null) {
        this.document = parseWorkspaceDocumentTolerant(current.data).document;
        this.lastEtag = current.etag;
        return;
      }
    }
    this.document = document;
    this.lastEtag = (write as { etag?: string } | undefined)?.etag ?? this.lastEtag;
  }

  protected override async save(document: WorkspaceDocument) {
    const write = await this.store.setJSON(key, document, this.lastEtag !== undefined ? { onlyIfMatch: this.lastEtag } : undefined);
    if (write && (write as { modified?: boolean }).modified === false) {
      // A concurrent writer moved the stored document past the version this mutation was computed
      // from. Surfacing the same conflict family as the mutate() funnel keeps the caller contract
      // uniform: reload and retry. Nothing was overwritten — that is the point.
      throw new Error("workspace_version_conflict: a concurrent writer updated workspace/current.json after this mutation loaded it; reload and retry (store compare-and-swap rejected the save).");
    }
    this.document = document;
    this.lastEtag = (write as { etag?: string } | undefined)?.etag ?? this.lastEtag;
  }

  async health(): Promise<RepositoryHealth> {
    return {
      ...healthyRepositoryStatus(storeBackendLabel()),
      version: "blobs.v1",
      // Surface self-healing so a dropped corrupt node is observable, never silent.
      ...(this.healedDroppedNodes > 0 ? { details: { healedDroppedNodes: this.healedDroppedNodes } } : {})
    };
  }
}
