import { randomUUID } from "node:crypto";
import { assertStableConversationActor, MAX_CONVERSATION_TURNS, type ConversationMirrorEntry, type ConversationSupersessionTombstone, type ConversationTrimMarker, type ConversationTurnClaim, type ConversationTurnClaimResult, type ConversationTurnGcApplyResult, type ConversationTurnGcDeletion, type ConversationTurnRecord } from "../../conversations/conversationTurnTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ConversationTurnRepository } from "../interfaces/ConversationTurnRepository.js";
import { getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const keyFor = (conversationId: string) => `conversations/${encodeURIComponent(conversationId)}.json`;
const claimKeyFor = (conversationId: string, turnId: string) => `conversation-turn-claims/${encodeURIComponent(conversationId)}/${encodeURIComponent(turnId)}.json`;
const MAX_WRITE_RETRIES = 5;

const appendBounded = (entries: ConversationMirrorEntry[], record: ConversationTurnRecord): ConversationMirrorEntry[] => {
  const existingMarker = entries.find((entry): entry is ConversationTrimMarker => entry.recordType === "trim_marker");
  const turns = [...entries.filter((entry): entry is ConversationTurnRecord => entry.recordType === "turn" && entry.turnId !== record.turnId), clone(record)]
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

  async listConversationIds(limit: number): Promise<string[]> {
    const result = await this.store.list({ prefix: "conversations/" });
    return result.blobs.map((blob) => blob.key)
      .filter((key) => key.startsWith("conversations/") && key.endsWith(".json"))
      .map((key) => decodeURIComponent(key.slice("conversations/".length, -".json".length)))
      .sort().slice(0, Math.max(0, limit));
  }

  async applySupersessionGc(scope: { projectId: string; conversationId: string; deletions: ConversationTurnGcDeletion[] }): Promise<ConversationTurnGcApplyResult> {
    const key = keyFor(scope.conversationId);
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<ConversationMirrorEntry[]>(this.store, key);
      const entries = current.data ?? [];
      const existingTombstones = new Set(entries.filter((entry): entry is ConversationSupersessionTombstone => entry.recordType === "supersession_tombstone").map((entry) => entry.supersededTurnId));
      const turnById = new Map(entries.filter((entry): entry is ConversationTurnRecord => entry.recordType === "turn").map((entry) => [entry.turnId, entry]));
      const accepted = scope.deletions.filter((deletion) => {
        const turn = turnById.get(deletion.supersededTurnId);
        return !!turn && turn.projectId === scope.projectId && turn.createdAt === deletion.expectedCreatedAt && !existingTombstones.has(deletion.supersededTurnId);
      });
      const alreadyDeleted = scope.deletions.filter((deletion) => existingTombstones.has(deletion.supersededTurnId)).length;
      if (accepted.length === 0) return { deleted: 0, alreadyDeleted };
      const ids = new Set(accepted.map((deletion) => deletion.supersededTurnId));
      const deletedAt = new Date().toISOString();
      const tombstones: ConversationSupersessionTombstone[] = accepted.map((deletion) => ({
        recordType: "supersession_tombstone", conversationId: scope.conversationId, projectId: scope.projectId,
        supersededTurnId: deletion.supersededTurnId, supersedingTurnId: deletion.supersedingTurnId,
        supersessionId: deletion.supersessionId, reason: deletion.reason, source: deletion.source, sourceId: deletion.sourceId, deletedAt
      }));
      const next = [...entries.filter((entry) => entry.recordType !== "turn" || !ids.has(entry.turnId)), ...tombstones];
      const result = await this.store.setJSON(key, next, current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
      if (!result || (result as { modified?: boolean }).modified !== false) return { deleted: accepted.length, alreadyDeleted };
    }
    throw new Error(`conversation_turn_gc_conflict:${scope.conversationId}`);
  }

  async claim(conversationId: string, turnId: string, requestHash: string): Promise<ConversationTurnClaimResult> {
    const key = claimKeyFor(conversationId, turnId);
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<ConversationTurnClaim>(this.store, key);
      if (current.data?.requestHash !== undefined && current.data.requestHash !== requestHash) return { status: "conflict", claim: clone(current.data) };
      if (current.data?.status === "completed" && current.data.response) return { status: "replay", claim: clone(current.data), response: clone(current.data.response) };
      if (current.data?.status === "pending") return { status: "pending", claim: clone(current.data) };
      const claim: ConversationTurnClaim = { conversationId, turnId, requestHash, ownerToken: randomUUID(), status: "pending", updatedAt: new Date().toISOString() };
      const result = await this.store.setJSON(key, claim, current.etag ? { onlyIfMatch: current.etag } : current.data ? undefined : { onlyIfNew: true });
      if (!result || (result as { modified?: boolean }).modified !== false) return { status: "acquired", claim: clone(claim) };
    }
    const winner = await getBlobJsonWithEtag<ConversationTurnClaim>(this.store, key);
    if (!winner.data) throw new Error(`conversation_turn_claim_conflict:${conversationId}:${turnId}`);
    return winner.data.requestHash !== requestHash
      ? { status: "conflict", claim: clone(winner.data) }
      : winner.data.status === "completed" && winner.data.response
        ? { status: "replay", claim: clone(winner.data), response: clone(winner.data.response) }
        : { status: "pending", claim: clone(winner.data) };
  }

  async getClaim(conversationId: string, turnId: string): Promise<ConversationTurnClaim | undefined> {
    const current = await getBlobJsonWithEtag<ConversationTurnClaim>(this.store, claimKeyFor(conversationId, turnId));
    return current.data ? clone(current.data) : undefined;
  }

  async completeClaim(claim: ConversationTurnClaim, response: Record<string, unknown>): Promise<void> {
    await this.updateClaim(claim, { status: "completed", response: clone(response), error: undefined });
  }

  async failClaim(claim: ConversationTurnClaim, error: { code: string; message: string }): Promise<void> {
    await this.updateClaim(claim, { status: "failed", error: clone(error), response: undefined }, true);
  }

  private async updateClaim(claim: ConversationTurnClaim, patch: Partial<ConversationTurnClaim>, bestEffort = false): Promise<void> {
    const key = claimKeyFor(claim.conversationId, claim.turnId);
    const current = await getBlobJsonWithEtag<ConversationTurnClaim>(this.store, key);
    if (!current.data || current.data.ownerToken !== claim.ownerToken || current.data.requestHash !== claim.requestHash || current.data.status !== "pending") {
      if (bestEffort) return;
      throw new Error(`conversation_turn_claim_conflict:${claim.conversationId}:${claim.turnId}`);
    }
    const result = await this.store.setJSON(key, { ...current.data, ...patch, updatedAt: new Date().toISOString() }, current.etag ? { onlyIfMatch: current.etag } : undefined);
    if ((result as { modified?: boolean } | undefined)?.modified === false && !bestEffort) throw new Error(`conversation_turn_claim_conflict:${claim.conversationId}:${claim.turnId}`);
  }

  clear(): void { /* Persistent stores are not globally cleared in production. */ }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }
}
