import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { ConversationTurnReference, ConversationTurnSupersession } from "../../conversations/conversationTurnTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { LearningRepository } from "../interfaces/LearningRepository.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const MAX_WRITE_RETRIES = 5;
type ConversationTurnLearningLedger = { supersessions: ConversationTurnSupersession[]; references: ConversationTurnReference[] };
// C-1: the ledger used to live under `learning/`, the same prefix listObservations scanned. It has
// its own top-level prefix now so no ledger can ever be mistaken for an observation again — and the
// listing below no longer scans blobs at all, so the two are independent fixes of one defect.
const ledgerKeyFor = (projectId: string, conversationId: string) => `conversation-turn-gc/${encodeURIComponent(projectId)}/${encodeURIComponent(conversationId)}.json`;
const emptyLedger = (): ConversationTurnLearningLedger => ({ supersessions: [], references: [] });

export class BlobLearningRepository implements LearningRepository {
  constructor(private readonly workspaceRepository: WorkspaceRepository, private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string }): Promise<LearningObservation> {
    return this.workspaceRepository.recordObservation(observation, metadata, provenance);
  }

  // C-1. This used to list the `learning/` blob prefix and parse every blob it found as an
  // observation. Nothing has ever WRITTEN an observation there — recordObservation delegates to the
  // workspace document, and so do archive and archiveByPredicate — so the `learning/{id}.json`
  // convention this read expected never existed. What did live under that prefix was the
  // conversation-turn ledger, which has no `createdAt`: one ledger returned the ledger AS an
  // observation and hid the real ones, and two made the sort throw for every caller of
  // learning_list_observations. Reading from the same store the writes go to is the fix; the ledger
  // moving to its own prefix (above) is belt and braces.
  async listObservations(options?: { includeArchived?: boolean }): Promise<LearningObservation[]> {
    return this.workspaceRepository.listObservations(options);
  }

  async archiveObservation(id: string, reason?: string): Promise<LearningObservation> {
    return this.workspaceRepository.archiveObservation(id, reason);
  }

  async archiveObservationsByPredicate(predicate: (observation: LearningObservation) => boolean, reason?: string): Promise<{ archived: number; ids: string[] }> {
    return this.workspaceRepository.archiveObservationsByPredicate(predicate, reason);
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
