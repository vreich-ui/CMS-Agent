import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ChangeRepository } from "../interfaces/ChangeRepository.js";
import type { RecordEnvelope } from "../RecordEnvelope.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";
import { filterAndPageEvents } from "../memory/MemoryChangeRepository.js";
import type { WorkspaceChangeEvent, WorkspaceChangeFilters, WorkspaceChangeRecordInput, WorkspaceRevision } from "../../workspace/changeTypes.js";

const changeKey = (eventId: string) => `changes/${eventId}.json`;
const revisionKey = (revisionId: string) => `revisions/${revisionId}.json`;

const envelope = <T>(id: string, recordType: string, schemaVersion: string, createdAt: string, data: T): RecordEnvelope<T> => ({
  id,
  record_type: recordType,
  schema_version: schemaVersion,
  created_at: createdAt,
  updated_at: createdAt,
  data
});

// Append-only blob-backed change history. First production adopter of the RecordEnvelope
// persistence convention (docs/architecture/repositories.md): one enveloped JSON blob per
// immutable record; nothing here ever updates or deletes an existing key.
export class BlobChangeRepository implements ChangeRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" };
  }

  async record(input: WorkspaceChangeRecordInput) {
    const writes: Promise<unknown>[] = [
      this.store.setJSON(changeKey(input.event.eventId), envelope(input.event.eventId, "workspace_change_event", "workspace_change_event.v1", input.event.createdAt, input.event))
    ];
    if (input.revision) {
      writes.push(this.store.setJSON(revisionKey(input.revision.revisionId), envelope(input.revision.revisionId, "workspace_revision", "workspace_revision.v1", input.revision.createdAt, input.revision)));
    }
    await Promise.all(writes);
  }

  private async listAllEvents(): Promise<WorkspaceChangeEvent[]> {
    const { blobs } = await this.store.list({ prefix: "changes/" });
    const envelopes = await Promise.all(blobs.map((blob) => getBlobJson<RecordEnvelope<WorkspaceChangeEvent>>(this.store, blob.key)));
    return envelopes.filter((record): record is RecordEnvelope<WorkspaceChangeEvent> => Boolean(record)).map((record) => record.data);
  }

  async listEvents(filters: WorkspaceChangeFilters = {}) {
    return filterAndPageEvents(await this.listAllEvents(), filters);
  }

  async getEvent(eventId: string) {
    const record = await getBlobJson<RecordEnvelope<WorkspaceChangeEvent>>(this.store, changeKey(eventId));
    return record?.data;
  }

  async getRevision(revisionId: string) {
    const record = await getBlobJson<RecordEnvelope<WorkspaceRevision>>(this.store, revisionKey(revisionId));
    return record?.data;
  }

  async listRevisions() {
    const { blobs } = await this.store.list({ prefix: "revisions/" });
    const envelopes = await Promise.all(blobs.map((blob) => getBlobJson<RecordEnvelope<WorkspaceRevision>>(this.store, blob.key)));
    return envelopes
      .filter((record): record is RecordEnvelope<WorkspaceRevision> => Boolean(record))
      .map((record) => record.data)
      .sort((a, b) => a.workspaceVersion - b.workspaceVersion);
  }
}
