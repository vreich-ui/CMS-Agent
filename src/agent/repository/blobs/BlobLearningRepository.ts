import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { ConversationTurnReference, ConversationTurnSupersession } from "../../conversations/conversationTurnTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { LearningRepository } from "../interfaces/LearningRepository.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const MAX_WRITE_RETRIES = 5;
type ConversationTurnLearningLedger = { supersessions: ConversationTurnSupersession[]; references: ConversationTurnReference[] };
const ledgerKeyFor = (projectId: string, conversationId: string) => `learning/conversation-turn-gc/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}.json`;
const emptyLedger = (): ConversationTurnLearningLedger => ({ supersessions: [], references: [] });

export class BlobLearningRepository implements LearningRepository {
  constructor(private readonly workspaceRepository: WorkspaceRepository, private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string }): Promise<LearningObservation> {
    return this.workspaceRepository.recordObservation(observation, metadata, provenance);
  }

  async listObservations(): Promise<LearningObservation[]> {
    const result = await this.store.list({ prefix: "learning/" });
    if (result.blobs.length === 0) return this.workspaceRepository.listObservations();
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<LearningObservation>(this.store, blob.key)));
    return records.filter((record): record is LearningObservation => record !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((record) => clone(record));
  }

  async recordConversationTurnSupersession(evidence: ConversationTurnSupersession): Promise<ConversationTurnSupersession> {
    await this.mutateLedger(evidence.projectId, evidence.conversationId, (ledger) => ({
      ...ledger,
      supersessions: ledger.supersessions.some((item) => item.supersessionId === evidence.supersessionId) ? ledger.supersessions : [...ledger.supersessions, clone(evidence)]
    }));
    return clone(evidence);
  }

  async listConversationTurnSupersessions(scope: { projectId: string; conversationId: string }): Promise<ConversationTurnSupersession[]> {
    const ledger = await this.readLedger(scope.projectId, scope.conversationId);
    return ledger.supersessions.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)).map(clone);
  }

  async recordConversationTurnReference(reference: ConversationTurnReference): Promise<ConversationTurnReference> {
    await this.mutateLedger(reference.projectId, reference.conversationId, (ledger) => ({
      ...ledger,
      references: ledger.references.some((item) => item.referenceId === reference.referenceId) ? ledger.references : [...ledger.references, clone(reference)]
    }));
    return clone(reference);
  }

  async listConversationTurnReferences(scope: { projectId: string; conversationId: string; turnId?: string }): Promise<ConversationTurnReference[]> {
    const ledger = await this.readLedger(scope.projectId, scope.conversationId);
    return ledger.references.filter((reference) => !scope.turnId || reference.turnId === scope.turnId)
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)).map(clone);
  }

  private async readLedger(projectId: string, conversationId: string): Promise<ConversationTurnLearningLedger> {
    return clone((await getBlobJson<ConversationTurnLearningLedger>(this.store, ledgerKeyFor(projectId, conversationId))) ?? emptyLedger());
  }

  private async mutateLedger(projectId: string, conversationId: string, mutate: (ledger: ConversationTurnLearningLedger) => ConversationTurnLearningLedger): Promise<void> {
    const key = ledgerKeyFor(projectId, conversationId);
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<ConversationTurnLearningLedger>(this.store, key);
      const result = await this.store.setJSON(key, mutate(clone(current.data ?? emptyLedger())), current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
      if (!result || (result as { modified?: boolean }).modified !== false) return;
    }
    throw new Error(`conversation_turn_learning_ledger_conflict:${projectId}:${conversationId}`);
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }
}
