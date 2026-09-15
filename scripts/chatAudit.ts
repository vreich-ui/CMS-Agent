#!/usr/bin/env tsx
// CMP-W0.1 — `npm run chat:audit -- [--project <id>] [--limit 20] [--json]`
//
// A READ-ONLY baseline audit of the admin chat's conversation-turn mirror. It answers, per
// conversation, "how much did the model thrash before it actually said something to the editor?" —
// tool calls before the first real answer, how often it asked a question instead of acting,
// how quickly it took its first action, and how much of that action was catalog/contract lookups
// it could plausibly have cached or skipped. This is the BEFORE measurement for CMP work that will
// try to shrink those numbers; it makes no judgement about what a "good" value is and changes
// nothing in the store.
//
// WHAT A CLEAN RUN DOES AND DOES NOT MEAN. A low toolCallsBeforeFirstAnswer / questionsAsked here
// means the sampled conversations were efficient — it says nothing about conversations this run
// did not see. `--project` filters AFTER fetching conversation ids (the turn store has no
// project-scoped listing — see `ConversationTurnRepository.listConversationIds`), so `--limit`
// bounds the id-lookup window, not the number of matching rows: a narrow `--project` audit on a
// busy store may need a larger `--limit` to find enough conversations. This also only reads the
// CA1 learning/audit mirror (`ConversationTurnRecord`), never Platform's ChatDoc — see
// `conversationTurnTypes.ts`'s header — so a conversation Platform holds but never mirrored here
// (or one this process's turn-write raced) will not appear.
//
// CONTRACT-READ ATTRIBUTION. `object_contract` calls always count. An `object_get` call counts only
// when it is provably about the conversation's own bound object; the turn mirror has no field for
// that ("context.object_id" is never persisted onto a ConversationTurnRecord — see
// conversationalRunner.ts's `requestPreview`), so the "bound object" is inferred from tool-call args
// actually seen: if every args.object_id in the conversation names exactly one object, that is
// treated as bound and only object_get calls matching it count; otherwise (zero or more than one
// distinct id — i.e. no single bound object is discoverable) EVERY object_get in the conversation
// counts, so contractReads never *under*-counts silently. Which rule applied is always in the
// output as `contractReadRule` — never left ambiguous.
//
// MALFORMED TOOL CALLS. `toolCalls` is typed `unknown[]` on the record (it is the wire shape from
// `conversationContract.ts`'s `toolCallSchema`, stored without re-validation), so a stored entry
// that does not have the {id, name, args} shape is skipped rather than crashing the audit or being
// silently absorbed into a count — it is tallied in `skippedToolCalls` (per row and per project) so
// a store with a lot of malformed history is visible, not invisible.
import { pathToFileURL } from "node:url";
import type { ConversationMirrorEntry, ConversationTurnRecord } from "../src/agent/conversations/conversationTurnTypes.js";

// ---------------------------------------------------------------------------------------------
// Pure metric computation. No store access, no argv, no console — this is the part the tests own.
// ---------------------------------------------------------------------------------------------

export const CATALOG_READ_TOOL_NAMES = new Set(["operation_list", "operation_get", "operation_preflight"]);

export type ContractReadRule =
  // Exactly one object_id was seen across this conversation's tool-call args, so it was treated as
  // the conversation's bound object and only object_get calls naming it count as contract reads.
  | "bound_object_id_matched"
  // Zero, or more than one, distinct object_id was seen — there is no single bound object this
  // audit can name from the turn records alone, so EVERY object_get call counts (never undercount).
  | "no_single_bound_object_id_counted_all_object_get";

export type ConversationAudit = {
  turnCount: number;
  toolCallsBeforeFirstAnswer: number;
  questionsAsked: number;
  turnsToFirstAction: number;
  catalogReads: number;
  contractReads: number;
  contractReadRule: ContractReadRule;
  skippedToolCalls: number;
};

type ParsedToolCall = { name: string; args: Record<string, unknown> };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Narrows one stored `toolCalls[]` entry to the wire shape (`{id, name, args}` from
// `conversationContract.ts`'s `toolCallSchema`). Returns undefined for anything that does not match
// closely enough to trust — the caller is responsible for tallying that as skipped, never dropping
// it without a trace.
const parseToolCall = (raw: unknown): ParsedToolCall | undefined => {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  if (typeof raw.name !== "string" || raw.name.length === 0) return undefined;
  if (!isPlainObject(raw.args)) return undefined;
  return { name: raw.name, args: raw.args };
};

// A turn's assistant text "answers the editor" when it is non-empty text with no tool calls
// attached — the mirror-image of a turn that only acted. Trailing/leading whitespace is trimmed
// before either check runs, matching the questionsAsked rule ("trailing whitespace trimmed").
const trimmedAssistantText = (turn: ConversationTurnRecord): string | undefined => {
  const text = turn.assistantText?.trim();
  return text && text.length > 0 ? text : undefined;
};

// Structural presence of tool calls on a turn — used for turnsToFirstAction, which is about
// whether the turn carried a tool call AT ALL (even a malformed one is still evidence the model
// tried to act), not about how many of those entries this audit could parse cleanly.
const rawToolCallCount = (turn: ConversationTurnRecord): number => (Array.isArray(turn.toolCalls) ? turn.toolCalls.length : 0);

export const auditConversation = (turns: ConversationTurnRecord[]): ConversationAudit => {
  // Defensive: the store's `list()` makes no ordering guarantee to callers, and the mirror can be
  // rewritten by GC/supersession between reads — never trust arrival order over createdAt.
  const sorted = [...turns].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  let skippedToolCalls = 0;
  let turnsToFirstAction = 0;
  let firstAnswerIndex = -1;
  let questionsAsked = 0;
  let catalogReads = 0;
  let objectContractCalls = 0;
  const objectGetCalls: ParsedToolCall[] = [];
  const seenObjectIds = new Set<string>();
  // Parsed (non-malformed) tool calls, one array per turn, in turn order — needed after the loop to
  // sum "before the first answer" once firstAnswerIndex is known.
  const parsedPerTurn: ParsedToolCall[][] = [];

  sorted.forEach((turn, index) => {
    if (rawToolCallCount(turn) > 0 && turnsToFirstAction === 0) turnsToFirstAction = index + 1;

    const rawCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
    const parsed: ParsedToolCall[] = [];
    for (const raw of rawCalls) {
      const call = parseToolCall(raw);
      if (!call) { skippedToolCalls += 1; continue; }
      parsed.push(call);
      if (CATALOG_READ_TOOL_NAMES.has(call.name)) catalogReads += 1;
      if (call.name === "object_contract") objectContractCalls += 1;
      if (call.name === "object_get") objectGetCalls.push(call);
      const objectId = call.args.object_id;
      if (typeof objectId === "string" && objectId.length > 0) seenObjectIds.add(objectId);
    }
    parsedPerTurn.push(parsed);

    const answerText = trimmedAssistantText(turn);
    if (firstAnswerIndex === -1 && answerText !== undefined && rawToolCallCount(turn) === 0) firstAnswerIndex = index;
    if (answerText !== undefined && answerText.endsWith("?")) questionsAsked += 1;
  });

  // Leading turns are everything strictly before the first answer. A conversation that never
  // answers (still mid-flight, or every turn acted) has no "before" boundary to sum up to, so the
  // honest total is every tool call the conversation made so far — never zero, which would read as
  // "answered immediately" when the truth is "has not answered yet".
  const leadingTurnCount = firstAnswerIndex === -1 ? sorted.length : firstAnswerIndex;
  const toolCallsBeforeFirstAnswer = parsedPerTurn.slice(0, leadingTurnCount).reduce((sum, calls) => sum + calls.length, 0);

  const contractReadRule: ContractReadRule = seenObjectIds.size === 1 ? "bound_object_id_matched" : "no_single_bound_object_id_counted_all_object_get";
  const boundObjectId = contractReadRule === "bound_object_id_matched" ? [...seenObjectIds][0] : undefined;
  const attributedObjectGetCount = contractReadRule === "bound_object_id_matched"
    ? objectGetCalls.filter((call) => call.args.object_id === boundObjectId).length
    : objectGetCalls.length;

  return {
    turnCount: sorted.length,
    toolCallsBeforeFirstAnswer,
    questionsAsked,
    turnsToFirstAction,
    catalogReads,
    contractReads: objectContractCalls + attributedObjectGetCount,
    contractReadRule,
    skippedToolCalls
  };
};

// ---------------------------------------------------------------------------------------------
// Store access, argument parsing and formatting. Everything below here is deliberately outside
// auditConversation() so the metric logic stays testable without a live store.
// ---------------------------------------------------------------------------------------------

const die = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const isTurnRecord = (entry: ConversationMirrorEntry): entry is ConversationTurnRecord => entry.recordType === "turn";

type ConversationRow = ConversationAudit & { conversationId: string; projectId: string | undefined };

const liveConversationTurnRepository = async () => {
  const store = (process.env.WORKSPACE_STORE ?? "memory").trim();
  if (store === "" || store === "memory") {
    die(
      'WORKSPACE_STORE is unset, so it defaults to "memory" — the turn mirror would read as EMPTY and this audit would report "no conversations" for a chat that has real history. ' +
      "Point it at the production store (WORKSPACE_STORE=gcs GCS_BUCKET=<bucket> [GCS_KEY_PREFIX=...], with GCP credentials)."
    );
  }
  const { bootstrapWorkspaceStore } = await import("../src/agent/entrypoints/runConductorJob.js");
  bootstrapWorkspaceStore();
  const { repositoryManager } = await import("../src/agent/runtime/repositories.js");
  return repositoryManager.getConversationTurnRepository();
};

const parseArgs = (argv: string[]) => {
  const json = argv.includes("--json");
  const projectIndex = argv.indexOf("--project");
  const projectId = projectIndex >= 0 ? argv[projectIndex + 1] : undefined;
  if (projectIndex >= 0 && !projectId) die("--project requires a value, e.g. --project my-site");
  const limitIndex = argv.indexOf("--limit");
  const limitRaw = limitIndex >= 0 ? argv[limitIndex + 1] : undefined;
  if (limitIndex >= 0 && !limitRaw) die("--limit requires a value, e.g. --limit 50");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0) die(`--limit must be a positive integer, got ${JSON.stringify(limitRaw)}`);
  return { json, projectId, limit };
};

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

type ProjectSummary = {
  projectId: string;
  conversations: number;
  meanToolCallsBeforeFirstAnswer: number;
  meanQuestionsAsked: number;
  meanTurnsToFirstAction: number;
  meanCatalogReads: number;
  meanContractReads: number;
  totalSkippedToolCalls: number;
};

const summarizeByProject = (rows: ConversationRow[]): ProjectSummary[] => {
  const byProject = new Map<string, ConversationRow[]>();
  for (const row of rows) {
    const key = row.projectId ?? "(unknown — conversation had no turn records)";
    const bucket = byProject.get(key) ?? [];
    bucket.push(row);
    byProject.set(key, bucket);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectId, projectRows]) => ({
      projectId,
      conversations: projectRows.length,
      meanToolCallsBeforeFirstAnswer: mean(projectRows.map((row) => row.toolCallsBeforeFirstAnswer)),
      meanQuestionsAsked: mean(projectRows.map((row) => row.questionsAsked)),
      meanTurnsToFirstAction: mean(projectRows.map((row) => row.turnsToFirstAction)),
      meanCatalogReads: mean(projectRows.map((row) => row.catalogReads)),
      meanContractReads: mean(projectRows.map((row) => row.contractReads)),
      totalSkippedToolCalls: projectRows.reduce((sum, row) => sum + row.skippedToolCalls, 0)
    }));
};

const fmt = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));

const renderText = (rows: ConversationRow[], summaries: ProjectSummary[]): string => {
  const lines: string[] = [];
  lines.push(`[chat:audit] ${rows.length} conversation(s) audited.\n`);
  lines.push("per-project summary:");
  lines.push("  project | conversations | mean toolCallsBeforeFirstAnswer | mean questionsAsked | mean turnsToFirstAction | mean catalogReads | mean contractReads | skippedToolCalls(total)");
  for (const summary of summaries) {
    lines.push(
      `  ${summary.projectId} | ${summary.conversations} | ${fmt(summary.meanToolCallsBeforeFirstAnswer)} | ${fmt(summary.meanQuestionsAsked)} | ${fmt(summary.meanTurnsToFirstAction)} | ${fmt(summary.meanCatalogReads)} | ${fmt(summary.meanContractReads)} | ${summary.totalSkippedToolCalls}`
    );
  }
  lines.push("");
  lines.push("per-conversation rows:");
  lines.push("  conversationId | project | turns | toolCallsBeforeFirstAnswer | questionsAsked | turnsToFirstAction | catalogReads | contractReads | contractReadRule | skippedToolCalls");
  for (const row of rows) {
    lines.push(
      `  ${row.conversationId} | ${row.projectId ?? "(unknown)"} | ${row.turnCount} | ${row.toolCallsBeforeFirstAnswer} | ${row.questionsAsked} | ${row.turnsToFirstAction} | ${row.catalogReads} | ${row.contractReads} | ${row.contractReadRule} | ${row.skippedToolCalls}`
    );
  }
  return lines.join("\n");
};

const main = async (): Promise<void> => {
  const { json, projectId, limit } = parseArgs(process.argv.slice(2));
  const repository = await liveConversationTurnRepository();

  const conversationIds = await repository.listConversationIds(limit);
  const rows: ConversationRow[] = [];
  for (const conversationId of conversationIds) {
    const entries = await repository.list(conversationId);
    const turns = entries.filter(isTurnRecord);
    const conversationProjectId = turns[0]?.projectId;
    if (projectId && conversationProjectId !== projectId) continue;
    rows.push({ conversationId, projectId: conversationProjectId, ...auditConversation(turns) });
  }

  const summaries = summarizeByProject(rows);
  if (json) {
    process.stdout.write(`${JSON.stringify({ conversations: rows, projectSummary: summaries }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(rows, summaries)}\n`);
  }
  process.exit(0);
};

// Never run main() as a side effect of import — tests import auditConversation() (and the other
// pure helpers) from this same file, and must not stand up a live store to do it. Match the guard
// used by scripts/netlify-env-audit.ts and scripts/contractCheck.ts.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
