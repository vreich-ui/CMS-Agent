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
      const document = createDefaultWorkspaceDocument();
      await this.save(document);
      return document;
    }
    // Tolerant parse: a single unusable node record must not brick every read/mutate. Invalid nodes
    // are dropped and the healed document is written back so the repair is permanent.
    const { document, droppedNodes } = parseWorkspaceDocumentTolerant(raw);
    if (droppedNodes > 0) await this.save(document);
    return document;
  }

  protected override async save(document: WorkspaceDocument) {
    await this.store.setJSON(key, document);
    this.document = document;
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" }; }
}
