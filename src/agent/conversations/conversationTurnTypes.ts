// CMS-Agent stores these records for learning and audit only. Platform's ChatDoc remains the
// human-facing conversation authority (transcript, visibility, approvals, and wait state).
export const MAX_CONVERSATION_TURNS = 200;

// Attribution, not authorization. The caller is responsible for authenticating and authorizing
// the actor; CMS-Agent records this stable identifier for history and learning only.
export type ConversationTurnActor = {
  kind: "human" | "agent" | "system";
  id: string;
};

export type ConversationTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsdEstimate: number;
};

// A deliberately small request mirror. CA1 does not make CMS-Agent the transcript authority and
// must not retain the caller's full conversation payload.
export type ConversationRequestPreview = {
  messageCount: number;
  latestMessagePreview?: string;
  toolNames?: string[];
};

export type ConversationTurnRecord = {
  recordType: "turn";
  turnId: string;
  conversationId: string;
  projectId: string;
  agentRef: string;
  agentRev: string;
  actor: ConversationTurnActor;
  requestPreview: ConversationRequestPreview;
  assistantText?: string;
  toolCalls?: unknown[];
  usage: ConversationTurnUsage;
  createdAt: string;
};

// This is kept at the head of a conversation mirror after records are evicted. It makes bounded
// retention observable without preserving the evicted turns themselves.
export type ConversationTrimMarker = {
  recordType: "trim_marker";
  conversationId: string;
  projectId: string;
  trimmedTurnCount: number;
  createdAt: string;
};

// A compact, durable explanation for a deletion. It intentionally carries neither request nor
// response content: the learning ledger holds the decision evidence and this mirror explains why
// the content is no longer present.
export type ConversationSupersessionTombstone = {
  recordType: "supersession_tombstone";
  conversationId: string;
  projectId: string;
  supersededTurnId: string;
  supersedingTurnId: string;
  supersessionId: string;
  reason: string;
  source: "learning" | "evaluation" | "improvement";
  sourceId: string;
  deletedAt: string;
};

export type ConversationMirrorEntry = ConversationTurnRecord | ConversationTrimMarker | ConversationSupersessionTombstone;

// The learning layer is the sole authority that can make a turn stale. This is deliberately
// explicit rather than inferred from timestamps, sessions, similarity, or a model judgement.
export type ConversationTurnSupersession = {
  supersessionId: string;
  projectId: string;
  conversationId: string;
  supersededTurnId: string;
  supersedingTurnId: string;
  reason: string;
  source: "learning" | "evaluation" | "improvement";
  sourceId: string;
  recordedAt: string;
};

// Artifacts do not currently contain conversation-turn ids, so the learning layer maintains this
// small, durable reference graph rather than guessing from text or unrelated workflow ids.
export type ConversationTurnReference = {
  referenceId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  artifactType: "learning" | "evaluation" | "improvement";
  artifactId: string;
  recordedAt: string;
};

export type ConversationTurnGcDeletion = Pick<ConversationTurnSupersession,
  "supersessionId" | "supersededTurnId" | "supersedingTurnId" | "reason" | "source" | "sourceId"> & {
  expectedCreatedAt: string;
};

export type ConversationTurnGcApplyResult = { deleted: number; alreadyDeleted: number };

// Durable idempotency state is stored separately from the learning/audit mirror. A pending claim is
// operational coordination only and must never look like a completed ConversationTurnRecord.
export type ConversationTurnClaim = {
  conversationId: string;
  turnId: string;
  requestHash: string;
  ownerToken: string;
  status: "pending" | "completed" | "failed";
  response?: Record<string, unknown>;
  error?: { code: string; message: string };
  updatedAt: string;
};

export type ConversationTurnClaimResult =
  | { status: "acquired"; claim: ConversationTurnClaim }
  | { status: "pending"; claim: ConversationTurnClaim }
  | { status: "replay"; claim: ConversationTurnClaim; response: Record<string, unknown> }
  | { status: "conflict"; claim: ConversationTurnClaim };

const emailLike = /\S+@\S+\.\S+/;

// Platform owns identity lookup. Rejecting an email-shaped actor id here protects the learning
// mirror if a future caller accidentally sends an email in the stable-id field.
export const assertStableConversationActor = (actor: ConversationTurnActor): void => {
  if (emailLike.test(actor.id)) throw new Error("conversation_turn_actor_id_must_be_a_stable_id_not_email");
};
