import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { ConversationTurnReference, ConversationTurnSupersession } from "../../conversations/conversationTurnTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface LearningRepository {
  recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string; projectId?: string }): Promise<LearningObservation>;
  listObservations(options?: { includeArchived?: boolean }): Promise<LearningObservation[]>;
  archiveObservation(id: string, reason?: string): Promise<LearningObservation>;
  archiveObservationsByPredicate(predicate: (observation: LearningObservation) => boolean, reason?: string): Promise<{ archived: number; ids: string[] }>;
  recordConversationTurnSupersession(evidence: ConversationTurnSupersession): Promise<ConversationTurnSupersession>;
  listConversationTurnSupersessions(scope: { projectId: string; conversationId: string }): Promise<ConversationTurnSupersession[]>;
  recordConversationTurnReference(reference: ConversationTurnReference): Promise<ConversationTurnReference>;
  listConversationTurnReferences(scope: { projectId: string; conversationId: string; turnId?: string }): Promise<ConversationTurnReference[]>;
  health(): Promise<RepositoryHealth>;
  /**
   * Track B — atomic dedup for `tracking:strategy.v1` ingestion. `keys` are
   * `strategyIngestionKey` values (stable identity: this tenant, this window, this group).
   * Returns the SUBSET that this call newly claimed — i.e. the keys that were NOT already on
   * file and are therefore this caller's to write. A key not in the returned set was already
   * claimed (by an earlier successful ingest, or by a concurrent/retried call that reached the
   * claim first) and must be treated as a duplicate, never written again.
   *
   * Replaces a "listObservations() snapshot, then decide, then write" sequence, which is a
   * read-then-blind-write race: two concurrent or retried passes can each observe the key as
   * absent and both proceed to record an observation. This call is the single compare-and-set
   * point instead — implementations MUST use their store's real CAS primitive (`onlyIfMatch` /
   * `onlyIfNew`), never a process-local lock or an in-memory check that does not survive a retry
   * loop against a store that can reject a stale write.
   */
  claimStrategyIngestionKeys(projectId: string, keys: readonly string[]): Promise<Set<string>>;
}
