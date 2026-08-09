import type { ConversationMirrorEntry, ConversationTurnRecord } from "../../conversations/conversationTurnTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface ConversationTurnRepository {
  record(record: ConversationTurnRecord): Promise<ConversationTurnRecord>;
  list(conversationId: string): Promise<ConversationMirrorEntry[]>;
  clear(): void;
  health(): Promise<RepositoryHealth>;
}
