import { assertStableConversationActor, MAX_CONVERSATION_TURNS, type ConversationMirrorEntry, type ConversationTrimMarker, type ConversationTurnRecord } from "../../conversations/conversationTurnTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ConversationTurnRepository } from "../interfaces/ConversationTurnRepository.js";
import { getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const keyFor = (conversationId: string) => `conversations/${encodeURIComponent(conversationId)}.json`;
const MAX_WRITE_RETRIES = 5;

const appendBounded = (entries: ConversationMirrorEntry[], record: ConversationTurnRecord): ConversationMirrorEntry[] => {
  const existingMarker = entries.find((entry): entry is ConversationTrimMarker => entry.recordType === "trim_marker");
  const turns = [...entries.filter((entry): entry is ConversationTurnRecord => entry.recordType === "turn"), clone(record)]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const trimmed = Math.max(0, turns.length - MAX_CONVERSATION_TURNS);
  const kept = trimmed > 0 ? turns.slice(trimmed) : turns;
  if (!existingMarker && trimmed === 0) return kept;
  const marker: ConversationTrimMarker = {
    recordType: "trim_marker",
    conversationId: record.conversationId,
    projectId: record.projectId,
    trimmedTurnCount: (existingMarker?.trimmedTurnCount ?? 0) + trimmed,
    createdAt: existingMarker?.createdAt ?? record.createdAt
  };
  return [marker, ...kept];
};

export class BlobConversationTurnRepository implements ConversationTurnRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async record(record: ConversationTurnRecord): Promise<ConversationTurnRecord> {
    assertStableConversationActor(record.actor);
    const key = keyFor(record.conversationId);
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<ConversationMirrorEntry[]>(this.store, key);
      const next = appendBounded(current.data ?? [], record);
      const result = await this.store.setJSON(key, next, current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
      if (!result || (result as { modified?: boolean }).modified !== false) return clone(record);
    }
    throw new Error(`conversation_turn_write_conflict:${record.conversationId}`);
  }

  async list(conversationId: string): Promise<ConversationMirrorEntry[]> {
    const current = await getBlobJsonWithEtag<ConversationMirrorEntry[]>(this.store, keyFor(conversationId));
    return clone(current.data ?? []);
  }

  clear(): void { /* Persistent stores are not globally cleared in production. */ }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }
}
