import { randomUUID } from "node:crypto";
import { assertStableConversationActor, MAX_CONVERSATION_TURNS, type ConversationMirrorEntry, type ConversationSupersessionTombstone, type ConversationTrimMarker, type ConversationTurnClaim, type ConversationTurnClaimResult, type ConversationTurnGcApplyResult, type ConversationTurnGcDeletion, type ConversationTurnRecord } from "../../conversations/conversationTurnTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ConversationTurnRepository } from "../interfaces/ConversationTurnRepository.js";

const clone = <T>(value: T): T => structuredClone(value);

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

export class MemoryConversationTurnRepository implements ConversationTurnRepository {
  private readonly records = new Map<string, ConversationMirrorEntry[]>();
  private readonly claims = new Map<string, ConversationTurnClaim>();

  constructor(private readonly backend: RepositoryBackend = "memory") {}

  async record(record: ConversationTurnRecord): Promise<ConversationTurnRecord> {
    assertStableConversationActor(record.actor);
    const current = this.records.get(record.conversationId) ?? [];
    this.records.set(record.conversationId, appendBounded(current, record));
    return clone(record);
  }

  async list(conversationId: string): Promise<ConversationMirrorEntry[]> {
    return clone(this.records.get(conversationId) ?? []);
  }

  async listConversationIds(limit: number): Promise<string[]> {
    return [...this.records.keys()].sort().slice(0, Math.max(0, limit));
  }

  async applySupersessionGc(scope: { projectId: string; conversationId: string; deletions: ConversationTurnGcDeletion[] }): Promise<ConversationTurnGcApplyResult> {
    const current = this.records.get(scope.conversationId) ?? [];
    const existingTombstones = new Set(current.filter((entry): entry is ConversationSupersessionTombstone => entry.recordType === "supersession_tombstone").map((entry) => entry.supersededTurnId));
    const turnById = new Map(current.filter((entry): entry is ConversationTurnRecord => entry.recordType === "turn").map((entry) => [entry.turnId, entry]));
    const now = new Date().toISOString();
    const accepted = scope.deletions.filter((deletion) => {
      const turn = turnById.get(deletion.supersededTurnId);
      return !!turn && turn.projectId === scope.projectId && turn.createdAt === deletion.expectedCreatedAt && !existingTombstones.has(deletion.supersededTurnId);
    });
    if (accepted.length === 0) return { deleted: 0, alreadyDeleted: scope.deletions.filter((deletion) => existingTombstones.has(deletion.supersededTurnId)).length };
    const ids = new Set(accepted.map((deletion) => deletion.supersededTurnId));
    const tombstones: ConversationSupersessionTombstone[] = accepted.map((deletion) => ({
      recordType: "supersession_tombstone", conversationId: scope.conversationId, projectId: scope.projectId,
      supersededTurnId: deletion.supersededTurnId, supersedingTurnId: deletion.supersedingTurnId,
      supersessionId: deletion.supersessionId, reason: deletion.reason, source: deletion.source, sourceId: deletion.sourceId, deletedAt: now
    }));
    this.records.set(scope.conversationId, [...current.filter((entry) => entry.recordType !== "turn" || !ids.has(entry.turnId)), ...tombstones]);
    return { deleted: accepted.length, alreadyDeleted: scope.deletions.filter((deletion) => existingTombstones.has(deletion.supersededTurnId)).length };
  }

  async claim(conversationId: string, turnId: string, requestHash: string): Promise<ConversationTurnClaimResult> {
    const key = `${conversationId}\u0000${turnId}`;
    const existing = this.claims.get(key);
    if (existing?.requestHash !== undefined && existing.requestHash !== requestHash) return { status: "conflict", claim: clone(existing) };
    if (existing?.status === "completed" && existing.response) return { status: "replay", claim: clone(existing), response: clone(existing.response) };
    if (existing?.status === "pending") return { status: "pending", claim: clone(existing) };
    const claim: ConversationTurnClaim = { conversationId, turnId, requestHash, ownerToken: randomUUID(), status: "pending", updatedAt: new Date().toISOString() };
    this.claims.set(key, claim);
    return { status: "acquired", claim: clone(claim) };
  }

  async getClaim(conversationId: string, turnId: string): Promise<ConversationTurnClaim | undefined> {
    const claim = this.claims.get(`${conversationId}\u0000${turnId}`);
    return claim ? clone(claim) : undefined;
  }

  async completeClaim(claim: ConversationTurnClaim, response: Record<string, unknown>): Promise<void> {
    const key = `${claim.conversationId}\u0000${claim.turnId}`;
    const current = this.claims.get(key);
    if (!current || current.ownerToken !== claim.ownerToken || current.requestHash !== claim.requestHash || current.status !== "pending") throw new Error(`conversation_turn_claim_conflict:${claim.conversationId}:${claim.turnId}`);
    this.claims.set(key, { ...current, status: "completed", response: clone(response), updatedAt: new Date().toISOString() });
  }

  async failClaim(claim: ConversationTurnClaim, error: { code: string; message: string }): Promise<void> {
    const key = `${claim.conversationId}\u0000${claim.turnId}`;
    const current = this.claims.get(key);
    if (!current || current.ownerToken !== claim.ownerToken || current.status !== "pending") return;
    this.claims.set(key, { ...current, status: "failed", error: clone(error), updatedAt: new Date().toISOString() });
  }

  clear(): void { this.records.clear(); this.claims.clear(); }

  async health(): Promise<RepositoryHealth> { return healthyRepositoryStatus(this.backend); }
}
