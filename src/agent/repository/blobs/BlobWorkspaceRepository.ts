import { WorkspaceStateStore, createDefaultWorkspaceDocument, parseWorkspaceDocumentTolerant, type WorkspaceDocument } from "../../mcp/workspace/store.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";
import { getBlobJson, getCmsAgentBlobStore, type BlobStoreClient } from "./blobClient.js";

const key = "workspace/current.json";

export class BlobWorkspaceRepository extends WorkspaceStateStore implements WorkspaceRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) { super(createDefaultWorkspaceDocument()); }

  protected override async load(): Promise<WorkspaceDocument> {
    const raw = await getBlobJson<unknown>(this.store, key);
    if (raw === null) {
      // No stored document visible. Under eventual consistency a read can lag a write this same
      // instance just committed, so prefer the locally-committed document over re-seeding a default.
      if (this.document.workspaceVersion > 0) return this.document;
      const document = createDefaultWorkspaceDocument();
      await this.save(document);
      return document;
    }
    // Tolerant parse: a single unusable node record must not brick every read/mutate. Invalid nodes
    // are dropped and the healed document is written back so the repair is permanent.
    const { document, droppedNodes } = parseWorkspaceDocumentTolerant(raw);
    if (droppedNodes > 0) {
      this.healedDroppedNodes += droppedNodes;
      await this.save(document);
      return document;
    }
    // Optimistic-concurrency consistency: never return a version older than one this instance has
    // already committed. An eventually-consistent read can lag a write we just made; returning the
    // stale document would make getWorkspaceVersion() / expectedWorkspaceVersion checks report an
    // older "current" version than a mutation already produced. Prefer the newer of the two.
    if (this.document.workspaceVersion > document.workspaceVersion) return this.document;
    this.document = document;
    return document;
  }

  protected override async save(document: WorkspaceDocument) {
    await this.store.setJSON(key, document);
    this.document = document;
  }

  async health(): Promise<RepositoryHealth> {
    return {
      ...healthyRepositoryStatus("blobs"),
      version: "blobs.v1",
      // Surface self-healing so a dropped corrupt node is observable, never silent.
      ...(this.healedDroppedNodes > 0 ? { details: { healedDroppedNodes: this.healedDroppedNodes } } : {})
    };
  }
}
