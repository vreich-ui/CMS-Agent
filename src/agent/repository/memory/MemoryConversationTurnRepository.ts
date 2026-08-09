import { assertStableConversationActor, MAX_CONVERSATION_TURNS, type ConversationMirrorEntry, type ConversationTrimMarker, type ConversationTurnRecord } from "../../conversations/conversationTurnTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ConversationTurnRepository } from "../interfaces/ConversationTurnRepository.js";

const clone = <T>(value: T): T => structuredClone(value);

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

export class MemoryConversationTurnRepository implements ConversationTurnRepository {
  private readonly records = new Map<string, ConversationMirrorEntry[]>();

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

  clear(): void { this.records.clear(); }

  async health(): Promise<RepositoryHealth> { return healthyRepositoryStatus(this.backend); }
}
