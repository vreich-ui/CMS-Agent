import type { ConversationMirrorEntry, ConversationTurnClaim, ConversationTurnClaimResult, ConversationTurnGcApplyResult, ConversationTurnGcDeletion, ConversationTurnRecord } from "../../conversations/conversationTurnTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface ConversationTurnRepository {
  record(record: ConversationTurnRecord): Promise<ConversationTurnRecord>;
  list(conversationId: string): Promise<ConversationMirrorEntry[]>;
  listConversationIds(limit: number): Promise<string[]>;
  applySupersessionGc(scope: { projectId: string; conversationId: string; deletions: ConversationTurnGcDeletion[] }): Promise<ConversationTurnGcApplyResult>;
  claim(conversationId: string, turnId: string, requestHash: string): Promise<ConversationTurnClaimResult>;
  getClaim(conversationId: string, turnId: string): Promise<ConversationTurnClaim | undefined>;
  completeClaim(claim: ConversationTurnClaim, response: Record<string, unknown>): Promise<void>;
  failClaim(claim: ConversationTurnClaim, error: { code: string; message: string }): Promise<void>;
  clear(): void;
  health(): Promise<RepositoryHealth>;
}
