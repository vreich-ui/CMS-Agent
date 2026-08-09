import type { ConversationTurnGcDeletion, ConversationTurnRecord } from "./conversationTurnTypes.js";
import type { ConversationTurnRepository } from "../repository/interfaces/ConversationTurnRepository.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";

export const DEFAULT_CONVERSATION_TURN_GC_DELETE_LIMIT = 25;
export const MAX_CONVERSATION_TURN_GC_DELETE_LIMIT = 100;

export type ConversationTurnGcReason = "superseded" | "no_supersession_evidence" | "referenced_by_artifact" | "active_replay_claim" | "not_later_interaction" | "scope_mismatch";
export type ConversationTurnGcPlan = {
  projectId: string;
  conversationId: string;
  scannedTurns: number;
  eligible: number;
  selected: number;
  reasons: Record<ConversationTurnGcReason, number>;
  deletions: ConversationTurnGcDeletion[];
};

const emptyReasons = (): Record<ConversationTurnGcReason, number> => ({
  superseded: 0, no_supersession_evidence: 0, referenced_by_artifact: 0, active_replay_claim: 0, not_later_interaction: 0, scope_mismatch: 0
});

// Plans are built solely from explicit, durable learning evidence. In particular, absence of a
// reference is not evidence of supersession, and a later timestamp/session is never sufficient.
export async function planConversationTurnGc(deps: {
  conversationTurnRepository: ConversationTurnRepository;
  learningRepository: LearningRepository;
  projectId: string;
  conversationId: string;
  maxDeletes?: number;
}): Promise<ConversationTurnGcPlan> {
  const maxDeletes = Math.min(MAX_CONVERSATION_TURN_GC_DELETE_LIMIT, Math.max(1, Math.floor(deps.maxDeletes ?? DEFAULT_CONVERSATION_TURN_GC_DELETE_LIMIT)));
  const entries = await deps.conversationTurnRepository.list(deps.conversationId);
  const allTurns = entries.filter((entry): entry is ConversationTurnRecord => entry.recordType === "turn");
  const turns = allTurns.filter((turn) => turn.projectId === deps.projectId);
  const reasons = emptyReasons();
  reasons.scope_mismatch = allTurns.length - turns.length;
  const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
  const [evidence, references] = await Promise.all([
    deps.learningRepository.listConversationTurnSupersessions({ projectId: deps.projectId, conversationId: deps.conversationId }),
    deps.learningRepository.listConversationTurnReferences({ projectId: deps.projectId, conversationId: deps.conversationId })
  ]);
  const evidenceByTurn = new Map<string, typeof evidence>();
  for (const item of evidence) {
    const list = evidenceByTurn.get(item.supersededTurnId) ?? [];
    list.push(item);
    evidenceByTurn.set(item.supersededTurnId, list);
  }
  const referencedTurnIds = new Set(references.map((reference) => reference.turnId));
  const deletions: ConversationTurnGcDeletion[] = [];

  for (const turn of turns.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const candidates = evidenceByTurn.get(turn.turnId) ?? [];
    if (candidates.length === 0) { reasons.no_supersession_evidence += 1; continue; }
    if (referencedTurnIds.has(turn.turnId)) { reasons.referenced_by_artifact += 1; continue; }
    const valid = candidates.find((item) => {
      const superseding = byId.get(item.supersedingTurnId);
      return item.supersededTurnId !== item.supersedingTurnId && !!superseding && superseding.createdAt > turn.createdAt;
    });
    if (!valid) { reasons.not_later_interaction += 1; continue; }
    const claim = await deps.conversationTurnRepository.getClaim(deps.conversationId, turn.turnId);
    if (claim?.status === "pending") { reasons.active_replay_claim += 1; continue; }
    reasons.superseded += 1;
    if (deletions.length < maxDeletes) {
      deletions.push({
        supersessionId: valid.supersessionId,
        supersededTurnId: turn.turnId,
        supersedingTurnId: valid.supersedingTurnId,
        reason: valid.reason,
        source: valid.source,
        sourceId: valid.sourceId,
        expectedCreatedAt: turn.createdAt
      });
    }
  }
  return { projectId: deps.projectId, conversationId: deps.conversationId, scannedTurns: turns.length, eligible: reasons.superseded, selected: deletions.length, reasons, deletions };
}

export async function applyConversationTurnGcPlan(deps: {
  conversationTurnRepository: ConversationTurnRepository;
  plan: ConversationTurnGcPlan;
}): Promise<{ deleted: number; alreadyDeleted: number }> {
  return deps.conversationTurnRepository.applySupersessionGc({
    projectId: deps.plan.projectId,
    conversationId: deps.plan.conversationId,
    deletions: deps.plan.deletions
  });
}
