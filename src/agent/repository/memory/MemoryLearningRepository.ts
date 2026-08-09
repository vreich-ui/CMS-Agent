import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { ConversationTurnReference, ConversationTurnSupersession } from "../../conversations/conversationTurnTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { LearningRepository } from "../interfaces/LearningRepository.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";

export class MemoryLearningRepository implements LearningRepository {
  private readonly supersessions = new Map<string, ConversationTurnSupersession>();
  private readonly turnReferences = new Map<string, ConversationTurnReference>();
  constructor(private readonly workspaceRepository: WorkspaceRepository, private readonly backend: RepositoryBackend = "memory") {}

  recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string }): Promise<LearningObservation> {
    return this.workspaceRepository.recordObservation(observation, metadata, provenance);
  }

  listObservations(): Promise<LearningObservation[]> {
    return this.workspaceRepository.listObservations();
  }

  async recordConversationTurnSupersession(evidence: ConversationTurnSupersession): Promise<ConversationTurnSupersession> {
    this.supersessions.set(`${evidence.projectId}\u0000${evidence.conversationId}\u0000${evidence.supersessionId}`, structuredClone(evidence));
    return structuredClone(evidence);
  }

  async listConversationTurnSupersessions(scope: { projectId: string; conversationId: string }): Promise<ConversationTurnSupersession[]> {
    return [...this.supersessions.values()]
      .filter((evidence) => evidence.projectId === scope.projectId && evidence.conversationId === scope.conversationId)
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)).map((evidence) => structuredClone(evidence));
  }

  async recordConversationTurnReference(reference: ConversationTurnReference): Promise<ConversationTurnReference> {
    this.turnReferences.set(`${reference.projectId}\u0000${reference.conversationId}\u0000${reference.referenceId}`, structuredClone(reference));
    return structuredClone(reference);
  }

  async listConversationTurnReferences(scope: { projectId: string; conversationId: string; turnId?: string }): Promise<ConversationTurnReference[]> {
    return [...this.turnReferences.values()]
      .filter((reference) => reference.projectId === scope.projectId && reference.conversationId === scope.conversationId && (!scope.turnId || reference.turnId === scope.turnId))
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)).map((reference) => structuredClone(reference));
  }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
