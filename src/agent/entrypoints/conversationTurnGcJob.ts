import { applyConversationTurnGcPlan, DEFAULT_CONVERSATION_TURN_GC_DELETE_LIMIT, planConversationTurnGc } from "../conversations/conversationTurnGc.js";
import type { ConversationTurnRepository } from "../repository/interfaces/ConversationTurnRepository.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";
import { repositoryManager } from "../runtime/repositories.js";

export const DEFAULT_CONVERSATION_TURN_GC_CONVERSATION_LIMIT = 25;
export const MAX_CONVERSATION_TURN_GC_CONVERSATION_LIMIT = 100;

export type ConversationTurnGcJobOptions = {
  projectId: string;
  conversationId?: string;
  apply?: boolean;
  maxConversations?: number;
  maxDeletesPerConversation?: number;
  conversationTurnRepository?: ConversationTurnRepository;
  learningRepository?: LearningRepository;
};

export type ConversationTurnGcJobResult = {
  mode: "dry_run" | "apply";
  conversationsScanned: number;
  turnsScanned: number;
  eligible: number;
  selected: number;
  deleted: number;
  alreadyDeleted: number;
  reasons: Record<string, number>;
};

const bounded = (value: number | undefined, fallback: number) => Math.min(MAX_CONVERSATION_TURN_GC_CONVERSATION_LIMIT, Math.max(1, Math.floor(value ?? fallback)));

// This job is intentionally plan-first. The default never mutates; an operator must inspect its
// compact counts/reasons and explicitly pass --apply for a bounded second invocation.
export async function runConversationTurnGcJob(options: ConversationTurnGcJobOptions): Promise<ConversationTurnGcJobResult> {
  bootstrapWorkspaceStore();
  const conversations = options.conversationTurnRepository ?? repositoryManager.getConversationTurnRepository();
  const learning = options.learningRepository ?? repositoryManager.getLearningRepository();
  const maxConversations = bounded(options.maxConversations, DEFAULT_CONVERSATION_TURN_GC_CONVERSATION_LIMIT);
  const ids = options.conversationId ? [options.conversationId] : await conversations.listConversationIds(maxConversations);
  const result: ConversationTurnGcJobResult = { mode: options.apply ? "apply" : "dry_run", conversationsScanned: 0, turnsScanned: 0, eligible: 0, selected: 0, deleted: 0, alreadyDeleted: 0, reasons: {} };
  for (const conversationId of ids.slice(0, maxConversations)) {
    const plan = await planConversationTurnGc({ conversationTurnRepository: conversations, learningRepository: learning, projectId: options.projectId, conversationId, maxDeletes: options.maxDeletesPerConversation ?? DEFAULT_CONVERSATION_TURN_GC_DELETE_LIMIT });
    result.conversationsScanned += 1;
    result.turnsScanned += plan.scannedTurns;
    result.eligible += plan.eligible;
    result.selected += plan.selected;
    for (const [reason, count] of Object.entries(plan.reasons)) result.reasons[reason] = (result.reasons[reason] ?? 0) + count;
    if (options.apply && plan.selected > 0) {
      const applied = await applyConversationTurnGcPlan({ conversationTurnRepository: conversations, plan });
      result.deleted += applied.deleted;
      result.alreadyDeleted += applied.alreadyDeleted;
    }
  }
  return result;
}

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const integerFlag = (argv: string[], name: string): number | undefined => {
  const raw = flagValue(argv, name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} must be a positive integer.`);
  return value;
};

export async function cliMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const projectId = flagValue(argv, "project") ?? env.PROJECT_ID;
  if (!projectId) throw new Error("--project / PROJECT_ID is required.");
  const result = await runConversationTurnGcJob({
    projectId,
    conversationId: flagValue(argv, "conversation") ?? env.CONVERSATION_ID,
    apply: argv.includes("--apply"),
    maxConversations: integerFlag(argv, "max-conversations"),
    maxDeletesPerConversation: integerFlag(argv, "max-deletes")
  });
  console.log(JSON.stringify(result));
  return 0;
}
