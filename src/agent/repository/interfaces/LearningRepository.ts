import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { ConversationTurnReference, ConversationTurnSupersession } from "../../conversations/conversationTurnTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface LearningRepository {
  recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string }): Promise<LearningObservation>;
  listObservations(options?: { includeArchived?: boolean }): Promise<LearningObservation[]>;
  archiveObservation(id: string, reason?: string): Promise<LearningObservation>;
  archiveObservationsByPredicate(predicate: (observation: LearningObservation) => boolean, reason?: string): Promise<{ archived: number; ids: string[] }>;
  recordConversationTurnSupersession(evidence: ConversationTurnSupersession): Promise<ConversationTurnSupersession>;
  listConversationTurnSupersessions(scope: { projectId: string; conversationId: string }): Promise<ConversationTurnSupersession[]>;
  recordConversationTurnReference(reference: ConversationTurnReference): Promise<ConversationTurnReference>;
  listConversationTurnReferences(scope: { projectId: string; conversationId: string; turnId?: string }): Promise<ConversationTurnReference[]>;
  health(): Promise<RepositoryHealth>;
}
