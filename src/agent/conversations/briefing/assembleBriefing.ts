// CMP-W1.5 / W2 / W2b.2 / W4 — the one place the briefing's I/O happens, and the one place its size
// is enforced.
//
// Every other module in this directory is pure or a single named read. This file is the seam: it
// gathers the tenant's standing facts once per tenant per day, the bound object once per turn, and
// the run state once per turn when a chat names a run — then renders `## House briefing`,
// `## Bound object` and `## What this chat is about` for assembleConversationPrompt to place.
//
// THE THREE RULES THIS FILE EXISTS TO HOLD.
//
// 1. A BRIEFING NEVER FAILS A TURN. Chat is the operator's lifeline (the same reason
//    resolveConversationSkills refuses to fail on a missing skill). Every gather below is wrapped so
//    that a dead tenant, an expired token or a hung read degrades to a NAMED line in the prompt and
//    the turn proceeds on rev 8's behaviour — read before you write — rather than erroring.
//
// 2. A BRIEFING NEVER COSTS THE SECOND TURN ANYTHING. The tenant half is cached per project for a
//    day: a conversation's first turn pays for it, every later turn in every later conversation on
//    that tenant does not. The per-turn half (the bound object, the run) is deliberately NOT cached
//    — those are exactly the facts that change while the editor is looking at them.
//
// 3. A BRIEFING NEVER CARRIES A SECRET. Nothing in this directory reads `tokenEnvVar`,
//    `tokenSecretRef`, `mcpEndpoint`, `allowedTools`, `toolPolicies` or a model name off the project
//    record, and the size test in tests/agent/conversations/briefingAssembly.test.ts asserts the
//    assembled text against the record's own secret-adjacent fields.
import type { AgentConverseInput, ConversationTool } from "../conversationContract.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import type { EditorialVoiceBody } from "../../projects/projectHooks.js";
import { getProjectHooks } from "../../projects/projectHooks.js";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import type { ImprovementRepository } from "../../repository/interfaces/ImprovementRepository.js";
import { getEditorialStrategy } from "../../projects/genesisEditorialStrategy.js";
import { getSitePrefetch } from "../../workspace/sitePrefetch.js";
import { RunScopedCache } from "../../workspace/conductor.js";
import { renderOperationsMenu, resolveAutonomyMode, type AutonomyMode } from "./operationsMenu.js";
import { renderToolSemantics } from "./toolSemantics.js";
import { renderTenantBaseline, type TenantBaselineFacts } from "./tenantBaseline.js";
import { dialectObjectTypes, renderContractDigestBlock, resolveContractDigests, type ContractDigestResult } from "./contractDigest.js";
import { prefetchObjectDossier, renderObjectDossier } from "./objectDossier.js";
import { SAFE_READ_FAILURES, safeWarningCode } from "./safeReason.js";
import { renderChatOrigin, runFactsFrom, type ChatOriginFacts, type ConversationOrigin } from "./chatOrigin.js";
import { clientManagerPlaybookNodeId, renderHouseLessons } from "./houseLessons.js";

/**
 * The plan's ceiling, in the same rough currency the rest of this repo estimates tokens in
 * (`Math.ceil(chars / 4)`, as nodeRuntime.ts and executor.ts both do). It is a COST bound, not a
 * context-window one: gpt-4.1 would happily take ten times this, and the point is that the briefing
 * rides on every turn of every conversation, so its size is a recurring bill rather than a one-off.
 */
export const MAX_BRIEFING_TOKENS = 6_000;
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const TENANT_BRIEFING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A DEGRADED tenant half lives for a minute, not a day — a review finding on this change.
 *
 * `buildTenantHalf` returns a complete entry whether its reads landed or not, and the first cut
 * cached both the same way. One transient outage during the first turn of the day would therefore
 * have pinned "Editorial strategy: not set", "Visual standard: could not be read" and "Contract
 * unavailable" across every conversation on that tenant for 24 hours, long after the tenant came
 * back. A short negative TTL keeps the degradation honest AND self-healing.
 */
export const DEGRADED_BRIEFING_TTL_MS = 60 * 1000;

/**
 * The whole gather shares ONE deadline, derived from the turn the editor is waiting on.
 *
 * Each underlying read carries its own 15 s timeout, and before this they ran in series: a tenant
 * that HANGS (rather than refusing) could hold a turn for ~90 s before the model was even called,
 * which is past `waitForReplay`'s own `timeout_ms + 5s` deadline for a duplicate turn. A third of
 * the turn's budget, capped at 12 s, is the bound; whatever has not arrived by then is rendered as a
 * degradation and the turn goes ahead. The reads keep running behind it and populate the caches, so
 * the cost of a slow tenant is paid once rather than every turn.
 */
export const briefingBudgetMs = (turnTimeoutMs: number): number => Math.min(12_000, Math.max(2_000, Math.floor(turnTimeoutMs / 3)));

const withDeadline = async <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export type BriefingBlocks = {
  /** `## House briefing` — the tenant half plus the menu, contracts, tools and lessons. */
  house: string;
  /** `## Bound object`, when the conversation is bound to one. */
  boundObject?: string;
  /** `## What this chat is about`, when the caller sent an origin. */
  origin?: string;
  /** Diagnostics for tests and the audit script; never rendered into the prompt. */
  diagnostics: { tokens: number; truncated: boolean; degradations: string[] };
};

export type BriefingDeps = {
  projectRepository: ProjectRepository;
  workspaceRepository?: WorkspaceRepository;
  executionRepository?: ExecutionRepository;
  improvementRepository?: ImprovementRepository;
  now?: () => number;
};

type TenantCacheEntry = { builtAtMs: number; baseline: string; degradations: string[] };
const tenantBriefingCache = new Map<string, TenantCacheEntry>();

/**
 * The briefing's OWN read cache, deliberately not `conductorCache`.
 *
 * `getSitePrefetch` and `getReducedContract` both memoize through a `RunScopedCache` keyed by runId,
 * and that cache never expires — it is built for a run, which ends. A chat's "run id" is the
 * project, which does not, so sharing the conductor's cache would have memoized a tenant's contract
 * and site facts for the life of the process. This instance is invalidated by project whenever the
 * tenant half's own TTL lapses, which is the single expiry rule for everything the briefing reads.
 */
const briefingReadCache = new RunScopedCache();

/** Test seam — a process-lifetime cache would otherwise leak between cases. */
export const __resetBriefingCacheForTests = (): void => { tenantBriefingCache.clear(); briefingReadCache.clear(); };

// Every gather is best-effort by construction. A thrown error becomes a named degradation line, so
// a reader of the assembled prompt can always tell "this tenant has none" from "this read failed" —
// the distinction sitePrefetch's own houseStatus tri-state exists to preserve.
const attempt = async <T>(label: string, degradations: string[], work: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await work();
  } catch (error: unknown) {
    degradations.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

const buildTenantHalf = async (
  config: ProjectConnectionConfig,
  recordVoice: EditorialVoiceBody | undefined,
  cacheKeyRunId: string,
  deps: BriefingDeps
): Promise<TenantCacheEntry> => {
  const degradations: string[] = [];

  // In PARALLEL. These are two independent reads against the same tenant; running them in series
  // doubled the worst case for no benefit (a review finding on this change).
  const [strategy, site] = await Promise.all([
    attempt("editorial strategy", degradations, () =>
      getEditorialStrategy({ projectId: config.projectId, runId: cacheKeyRunId }, { projectRepository: deps.projectRepository, cache: briefingReadCache })),
    attempt("visual standard", degradations, () =>
      getSitePrefetch({ runId: cacheKeyRunId, projectId: config.projectId }, { projectRepository: deps.projectRepository, cache: briefingReadCache }))
  ]);

  const facts: TenantBaselineFacts = {
    publicationName: config.name,
    autonomyMode: resolveAutonomyMode(config.publishingPolicy),
    publishEnabled: config.publishingPolicy.publishEnabled,
    strategy: strategy?.strategy,
    // NEVER `strategy.warning`: that prose names this deployment's env vars (see safeReason.ts).
    strategyNote: safeWarningCode(strategy?.warningCode),
    voice: recordVoice,
    // The runner supplies `project.editorialVoiceFallback`, which is by definition the tenant's voice
    // of LAST RESORT (G6) rather than an authored `editorial_voice` object. Saying so is the point of
    // the line: an agent that cannot tell a fallback from a decision will cite one as the other.
    voiceIsFallback: Boolean(recordVoice),
    visualStandard: site?.visualStandard,
    hookKnowledge: getProjectHooks(config.projectId)?.knowledge
  };

  return { builtAtMs: (deps.now ?? Date.now)(), baseline: renderTenantBaseline(facts), degradations };
};

const tenantHalf = async (
  config: ProjectConnectionConfig,
  recordVoice: EditorialVoiceBody | undefined,
  cacheKeyRunId: string,
  deps: BriefingDeps
): Promise<TenantCacheEntry> => {
  const now = (deps.now ?? Date.now)();
  const cached = tenantBriefingCache.get(config.projectId);
  // A degraded entry expires in a minute; a good one lasts the day. See DEGRADED_BRIEFING_TTL_MS.
  const ttl = cached?.degradations.length ? DEGRADED_BRIEFING_TTL_MS : TENANT_BRIEFING_TTL_MS;
  if (cached && now - cached.builtAtMs < ttl) return cached;
  // The reads underneath expire WITH this entry — one expiry rule, not two. Without this, the
  // RunScopedCache below would hold the tenant's site facts for the life of the process.
  if (cached) briefingReadCache.invalidateRun(cacheKeyRunId);
  const built = await buildTenantHalf(config, recordVoice, cacheKeyRunId, deps);
  tenantBriefingCache.set(config.projectId, built);
  return built;
};

/**
 * Trim from the BOTTOM, by whole sections, when the briefing overruns its budget.
 *
 * Order matters and is a judgement, stated here rather than left implicit: the tool list goes first
 * (the model has every tool's full description on the wire regardless — this block only reorganises
 * them), then the lessons, then the contracts. The tenant half and the operations menu are never
 * dropped: they are the two things the model cannot recover by any tool call it is allowed to make
 * without spending the very round trips this whole change exists to remove.
 */
const fitToBudget = (sections: string[], alwaysKeep: number): { text: string; truncated: boolean } => {
  const kept = [...sections];
  let truncated = false;
  while (kept.length > alwaysKeep && estimateTokens(kept.join("\n\n")) > MAX_BRIEFING_TOKENS) {
    kept.pop();
    truncated = true;
  }
  if (truncated) kept.push("_Part of this briefing was dropped to stay inside its size budget. If you need a fact it would have carried, read for it._");
  return { text: kept.join("\n\n"), truncated };
};

export type AssembleBriefingParams = {
  config: ProjectConnectionConfig;
  context: AgentConverseInput["context"];
  conversationId: string;
  tools: ConversationTool[];
  turnTimeoutMs: number;
  recordVoice?: EditorialVoiceBody;
};

/**
 * Assemble the briefing, inside one shared deadline.
 *
 * The three things this function guarantees, in order of how badly they break if they fail: the
 * turn never throws, the turn never waits longer than `briefingBudgetMs`, and whatever could not be
 * gathered says so by name rather than by absence.
 */
export const assembleBriefing = async (params: AssembleBriefingParams, deps: BriefingDeps): Promise<BriefingBlocks> => {
  const { config, context, conversationId } = params;
  const autonomyMode: AutonomyMode = resolveAutonomyMode(config.publishingPolicy);
  // The read caches are keyed by the PROJECT, not the conversation: two conversations on the same
  // tenant share the read, and a per-conversation key would grow without bound as chats accumulate.
  const cacheKeyRunId = `chat:${config.projectId}`;
  const degradations: string[] = [];

  // The pure half. It needs no tenant and no store, so it is what survives when everything else
  // times out — which is exactly why the never-drop set below is the header, the tenant half and
  // the menu, and why this is computed before anything is awaited.
  const header = "## House briefing\nEverything below is already known. It is here so you do not spend the editor's turn discovering it. Verify before you write; do not re-read to learn.";
  const menu = renderOperationsMenu(autonomyMode);
  const tools = `### Tools on this turn\n${renderToolSemantics(params.tools)}`;

  const gathered = await withDeadline((async () => {
    const tenant = await tenantHalf(config, params.recordVoice, cacheKeyRunId, deps);
    degradations.push(...tenant.degradations);

    // Contracts are resolved PER TURN, not cached in the tenant half — a review finding. The tenant
    // half lives for a day; the bound object's digest is resolved per turn; caching one and not the
    // other produced a prompt that could show the OLD digest for a type in `### Object contracts`
    // and the NEW one in `## Bound object`, while rev 9 tells the model to trust both. One
    // resolution per turn cannot disagree with itself, and the fetch underneath is memoized by
    // `briefingReadCache` for the tenant half's own TTL, so this costs nothing on a warm instance.
    const digests = await attempt("object contracts", degradations, () =>
      resolveContractDigests({ projectId: config.projectId, runId: cacheKeyRunId, objectTypes: dialectObjectTypes(config) }, { ...deps, cache: briefingReadCache })) ?? [];

    const lessons = deps.improvementRepository
      ? renderHouseLessons(await attempt("house lessons", degradations, () => deps.improvementRepository!.getPlaybook(clientManagerPlaybookNodeId(config.projectId))))
      : "";

    let boundObject: string | undefined;
    if (context.object_type && context.object_id) {
      const objectType = context.object_type;
      const objectId = context.object_id;
      const facts = await attempt("bound object", degradations, () =>
        prefetchObjectDossier({ objectType, objectId, turnTimeoutMs: params.turnTimeoutMs }, { config, conversationId }));
      // W2.1 — the object's own contract digest travels WITH the object, so a reader never has to
      // match a type name in one block against a digest in another. Taken from the SAME resolution
      // the block above used when the dialect names this type; resolved once more only when it does
      // not, which is the case the tenant half could not have covered.
      const own = digests.find((entry) => entry.objectType === objectType)
        ?? (await attempt("bound object contract", degradations, () =>
          resolveContractDigests({ projectId: config.projectId, runId: cacheKeyRunId, objectTypes: [objectType] }, { ...deps, cache: briefingReadCache })))?.[0];
      boundObject = renderObjectDossier({
        ...(facts ?? { objectType, objectId, unavailableReason: SAFE_READ_FAILURES.unreachable }),
        contractDigest: own?.source === "contract" ? own.digest : undefined
      });
    }

    let origin: string | undefined;
    const conversationOrigin = (context as { origin?: ConversationOrigin }).origin;
    if (conversationOrigin) {
      const facts: ChatOriginFacts = { origin: conversationOrigin };
      if (conversationOrigin.run_id && deps.executionRepository) {
        const run = await attempt("run state", degradations, () => deps.executionRepository!.getRun(conversationOrigin.run_id!));
        if (run) facts.run = runFactsFrom(run);
        else facts.runUnavailableReason = "no run with that id is in this workspace";
      } else if (conversationOrigin.run_id) {
        facts.runUnavailableReason = "this turn was assembled without an execution store";
      }
      origin = renderChatOrigin(facts);
    }

    return { baseline: tenant.baseline, contracts: renderContractDigestBlock(digests), lessons, boundObject, origin };
  })(), briefingBudgetMs(params.turnTimeoutMs), undefined);

  if (!gathered) degradations.push("briefing gather: ran past this turn's budget; the reads continue in the background and the next turn will have them");

  const sections = [
    header,
    gathered?.baseline ?? "### This house\n- The tenant's standing facts did not arrive inside this turn's budget. Read what you need before acting on it, and do not report a fact as absent on the strength of this line.",
    menu,
    ...(gathered?.contracts ? [gathered.contracts] : []),
    ...(gathered?.lessons ? [gathered.lessons] : []),
    tools
  ];
  // Never-drop count: the header, the tenant half, and the operations menu.
  const { text: house, truncated } = fitToBudget(sections, 3);

  return {
    house,
    boundObject: gathered?.boundObject,
    origin: gathered?.origin,
    diagnostics: { tokens: estimateTokens([house, gathered?.boundObject ?? "", gathered?.origin ?? ""].join("\n\n")), truncated, degradations }
  };
};
