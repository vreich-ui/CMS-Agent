// `editorial_planner` — the orchestration half (Track C, Wolf 2026-09-14).
//
// WHAT THIS MODULE IS. The thing that turns "a tenant has a commissioning policy" into "a run is in
// flight", without a human anywhere in the loop. It gathers, asks a model for candidate briefs once,
// hands everything to the deterministic planner (`plan.ts`) and — only for `commission` — starts the
// runs the plan actually authorized.
//
// THE DIVISION OF LABOUR IS THE WHOLE DESIGN. Nothing in here decides how many runs, how much money,
// or what counts as a duplicate. Those live in `plan.ts`, are pure, and are unit-tested without a
// model. This module is allowed to fetch, to prompt, and to start — and that is all. A future
// maintainer adding "just one more check" here should move it to plan.ts instead; a cap that lives
// beside an await is a cap nobody can test.
//
// STARTING A RUN GOES THROUGH THE PUBLIC PATH. `startDryRun` + a `runNextNode` kick: the exact two
// engine calls platform's `run_workspace_workflow` makes when a human starts a run from admin chat.
// There is deliberately no private starter, so a commissioned run is subject to every gate an asked
// run is — the workflow gate, the subject gate, the request-id grammar, the budget guard, the publish
// approval policy. The ONLY difference is the `commissionedBy` stamp saying nobody asked.
//
// IT NEVER THROWS FOR A TENANT-SHAPED REASON. No strategy, no commissioning block, commissioning
// off, a dead tenant MCP, a model turn that returns nothing usable — each is a named, reported
// outcome. A daily job over every tenant must not lose tenant B because tenant A is misconfigured.
import { getEditorialStrategy } from "../projects/genesisEditorialStrategy.js";
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { invokeTenantReadTool } from "../tools/tenantInvoke.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { UsageRepository } from "../repository/interfaces/UsageRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import { getNodeRunner } from "../execution/runnerRegistry.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import { listRunsPage, runNextNode, startDryRun } from "../workspace/executor.js";
import { readCommissioning, type Commissioning } from "./commissioningTypes.js";
import { getCommissionReservationStore, type CommissionReservation, type CommissionReservationStore } from "./commissioningReservations.js";
import {
  COMMISSIONED_BY,
  MEASURED_RUN_COST_USD,
  type CandidateBrief,
  type CommissionPlan,
  type CommissionRequest,
  type RunFact,
  buildCommissionPlan,
  dedupeKeyOf,
  plannerHaltBlockage,
  seedCandidates,
  topicFromRequestId
} from "./plan.js";

export const PLANNER_NODE_ID = COMMISSIONED_BY;

/**
 * The model turn's ceiling, in USD. Enforced by the runner's own budget guard (`budgetGuard.ts`), so
 * a prompt that somehow provokes an enormous response is refused BEFORE it is sent rather than
 * discovered on the bill. Half a dollar against a ≈$4 run: the planning turn must never be a
 * meaningful fraction of what it plans.
 */
export const PLANNER_MODEL_BUDGET_USD = 0.5;

/** How far back "recent runs" reaches. Thirty days is the dedupe horizon AND the failure-streak horizon. */
export const PLANNER_RUN_WINDOW_DAYS = 30;

/** How many published items the planner dedupes against. The tenant's whole catalogue, bounded. */
export const PLANNER_INVENTORY_LIMIT = 500;

export type PlannerDeps = {
  projectRepository?: ProjectRepository;
  executionRepository?: ExecutionRepository;
  workspaceRepository?: WorkspaceRepository;
  usageRepository?: UsageRepository;
  learningRepository?: LearningRepository;
  now?: () => Date;
  /** Test seam: replaces the one model turn. Returning [] is a legitimate outcome, not a failure. */
  proposeCandidates?: (context: ModelTurnContext) => Promise<CandidateBrief[]>;
  /** Test seam: replaces the tenant read path. */
  readTenant?: (projectId: string, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /**
   * C7 — durable uniqueness. Resolved LAZILY at the point of use, never in `deps()`: the default
   * store binds to the blob/GCS transport on construction, and a test that never commissions must
   * not be made to stand up a store just by calling `planForProject`.
   */
  reservationStore?: CommissionReservationStore;
};

export type ModelTurnContext = {
  projectId: string;
  commissioning: Commissioning;
  strategySummary: { goal: string; offer: string; audienceSegments: string[]; cadence: string; angleMix: { angle: string; share: number }[] };
  publishedTitles: string[];
  openTopics: string[];
  observations: string[];
  wanted: number;
};

export type PlannerSkip = { projectId: string; planned: false; reason: "no_project_record" | "no_strategy" | "no_commissioning_block" | "commissioning_disabled" | "nothing_to_plan" | "pass_in_flight" | "run_history_unreadable"; detail: string };
export type PlannerPlanned = { projectId: string; planned: true; /** The tenant's own switch — planning is allowed while it is off; starting a run is not. */ enabled: boolean; plan: CommissionPlan; blockage?: ReturnType<typeof plannerHaltBlockage>; inputs: { inventoryCount: number; recentRunCount: number; candidateCount: number; seedCount: number; modelCandidateCount: number; pricedRunCostUsd: number; degraded: string[] } };
export type PlannerResult = PlannerSkip | PlannerPlanned;

export type CommissionOutcome = { requestId: string; runId?: string; started: boolean; error?: string; topic: string; rationale: string };
export type CommissionResult = PlannerResult & { commissioned?: CommissionOutcome[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const deps = (overrides: PlannerDeps = {}) => ({
  projectRepository: overrides.projectRepository ?? repositoryManager.getProjectRepository(),
  executionRepository: overrides.executionRepository ?? repositoryManager.getExecutionRepository(),
  workspaceRepository: overrides.workspaceRepository,
  usageRepository: overrides.usageRepository ?? repositoryManager.getUsageRepository(),
  learningRepository: overrides.learningRepository ?? repositoryManager.getLearningRepository(),
  now: overrides.now ?? (() => new Date()),
  proposeCandidates: overrides.proposeCandidates,
  readTenant: overrides.readTenant,
  reservationStore: overrides.reservationStore
});

// ── gathering ────────────────────────────────────────────────────────────────

/**
 * The tenant's published catalogue, as `{slug,title}` pairs. Uses `object_list`, which is in the
 * server-side READ_TOOL_ALLOWLIST — `analytics_top_content` would be a better ranking signal and is
 * deliberately NOT reached for here: adding a verb to that allowlist is its own reviewed change, not
 * something a new feature helps itself to.
 */
const readInventory = async (
  projectId: string,
  read: (projectId: string, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>
): Promise<{ items: { slug?: string; title?: string }[]; degraded?: string }> => {
  const answer = await read(projectId, "object_list", { object_type: "content_item", limit: PLANNER_INVENTORY_LIMIT });
  if (!answer.ok) return { items: [], degraded: `inventory_unavailable: ${answer.error ?? "object_list refused"}` };
  const rows = collectObjectRows(answer.result);
  // An EMPTY inventory from a reachable tenant is a real answer (a new site), and it must not be
  // confused with an unreachable one — a planner that treats "cannot read" as "nothing published"
  // would commission the entire catalogue again on the first bad network day.
  return { items: rows };
};

/** Descend an MCP result to a list of object rows, by shape rather than by a memorized path (the T10 lesson). */
export const collectObjectRows = (result: unknown): { slug?: string; title?: string; objectId?: string }[] => {
  const seen: { slug?: string; title?: string; objectId?: string }[] = [];
  const pushRow = (row: unknown) => {
    if (!isRecord(row)) return;
    const body = isRecord(row.body) ? row.body : row;
    const slug = typeof body.slug === "string" ? body.slug : typeof row.slug === "string" ? row.slug : undefined;
    const title = typeof body.title === "string" ? body.title : typeof row.title === "string" ? row.title : undefined;
    // `object_id` is the load-bearing one on this fleet: a tenant's object_list answers with ids and
    // NO bodies, so slug and title are both absent on every row (verified live on dr-lurie).
    const objectId = typeof row.object_id === "string" ? row.object_id : typeof row.objectId === "string" ? row.objectId : undefined;
    if (slug || title || objectId) seen.push({ ...(slug ? { slug } : {}), ...(title ? { title } : {}), ...(objectId ? { objectId } : {}) });
  };
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) pushRow(entry);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ["objects", "items", "rows", "results", "structuredContent", "object", "record", "data"]) {
      if (value[key] !== undefined) visit(value[key], depth + 1);
    }
    if (Array.isArray(value.content)) {
      const text = value.content.find((block): block is { text: string } => isRecord(block) && typeof block.text === "string")?.text;
      if (text) {
        try {
          visit(JSON.parse(text), depth + 1);
        } catch {
          /* a non-JSON text block is not an inventory; ignore it rather than guess */
        }
      }
    }
  };
  visit(result, 0);
  return seen;
};

/**
 * `getEditorialStrategy` takes its own read seam, shaped `(config, tool, args)` rather than
 * `(projectId, tool, args)`. Bridging it here — rather than reaching around it with a second
 * `object_get` of our own — keeps ONE strategy reader in this repo: its policy check, its 15s
 * timeout, its shape-first descent and its four named degradation modes all still apply to the
 * planner's read, and a test that fakes the tenant fakes the strategy too.
 */
const strategyDeps = (d: ReturnType<typeof deps>) => ({
  projectRepository: d.projectRepository,
  ...(d.readTenant
    ? { callReadTool: (config: { projectId: string }, tool: string, args: Record<string, unknown>) => d.readTenant!(config.projectId, tool, args) }
    : {})
});

const defaultReadTenant = async (projectRepository: ProjectRepository, projectId: string, tool: string, args: Record<string, unknown>) => {
  const config = await projectRepository.get(projectId);
  if (!config) return { ok: false, error: `Unknown projectId: ${projectId}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    // W5 T3 — the planner's tenant reads go through the choke point too, so a plan that quietly
    // read a tenant is visible in tool.list_executions alongside the run that used it.
    const answer = await invokeTenantReadTool({ projectId: config.projectId, project: config, toolId: tool, args, caller: "engine", signal: controller.signal });
    return answer.ok ? { ok: true, result: answer.result } : { ok: false, error: answer.error ?? answer.code };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The last 30 days of runs for this project, as the facts the planner reasons over — status, when,
 * who commissioned it, what it cost and what topic it claimed.
 *
 * COST comes from the usage ledger in ONE call for the whole window, not from `get_run_cost` per
 * run: a tenant with sixty runs would otherwise make sixty calls every morning to answer one
 * question about today's budget.
 */
export const runFactsFor = async (
  projectId: string,
  window: { from: string },
  store: ExecutionRepository,
  usage: UsageRepository
): Promise<RunFact[]> => {
  const { runs } = await listRunsPage({ projectId, from: window.from, limit: 100 }, store);
  const ledger = await usage.list({ projectId, from: window.from }).catch(() => []);
  const costByRun = new Map<string, number>();
  for (const record of ledger) {
    if (!record.runId) continue;
    costByRun.set(record.runId, (costByRun.get(record.runId) ?? 0) + (typeof record.costUsdEstimate === "number" ? record.costUsdEstimate : 0));
  }
  return runs.map((run) => ({
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    ...(costByRun.has(run.runId) ? { costUsd: costByRun.get(run.runId)! } : {}),
    ...(run.commissionedBy ? { commissionedBy: run.commissionedBy } : {}),
    ...(topicKeyOf(run) ? { topicKey: topicKeyOf(run)! } : {})
  }));
};

/** The topic an in-flight run has already claimed — its commissioned content source, or its brief. */
const topicKeyOf = (run: WorkflowExecutionRecord): string | undefined => {
  const input = run.initialInput;
  if (!isRecord(input)) return undefined;
  const source = input.contentSource;
  if (isRecord(source) && typeof source.topic === "string" && source.topic.trim()) return source.topic.trim();
  return typeof input.instructions === "string" && input.instructions.trim() ? input.instructions.trim().split("\n")[0] : undefined;
};

/**
 * What a run on this project should be PRICED at for the daily budget — the expensive end of what
 * actually happens, because a budget set against the average is wrong on exactly the days it
 * matters.
 *
 * TWO RULES THAT ARE NOT OPTIONAL, and the first version of this had neither:
 *
 * 1. ONLY FINISHED RUNS ARE PRICED. A run that died at the approval gate, or failed at node three,
 *    paid for a handful of nodes. dr-lurie's history is dominated by exactly those. Pricing off
 *    them made p95 ≈ $0.30, which turned a declared $10/day into 33 authorized slots — $80 of real
 *    work under a budget that still reported itself as $10. A partial run is evidence about a
 *    failure, never evidence about what a run costs.
 *
 * 2. THE MEASURED COST IS A FLOOR, NOT A FALLBACK. Even a clean history can price low for a while
 *    (short pieces, a cheap week), and every dollar under the true cost becomes an extra run. The
 *    measured ≈$4 is what a real publishing run has been observed to cost, so the price never goes
 *    below it — the budget may be pessimistic, and must never be optimistic.
 *
 * Returns undefined with fewer than three FINISHED priced runs: two data points are not a
 * distribution, and `plan.ts` then prices at the measured cost, which is the same floor.
 */
const PRICEABLE_STATUSES = new Set(["completed", "published", "released"]);

export const p95RunCost = (facts: readonly RunFact[]): number | undefined => {
  const costs = facts
    .filter((fact) => PRICEABLE_STATUSES.has(fact.status))
    .map((fact) => fact.costUsd)
    .filter((cost): cost is number => typeof cost === "number" && cost > 0)
    .sort((a, b) => a - b);
  if (costs.length < 3) return undefined;
  const p95 = costs[Math.min(costs.length - 1, Math.ceil(costs.length * 0.95) - 1)]!;
  return Math.max(MEASURED_RUN_COST_USD, p95);
};

// ── the one model turn ───────────────────────────────────────────────────────

const CANDIDATE_SCHEMA = {
  type: "object",
  required: ["candidates"],
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        required: ["topic", "readerState", "archetypeId", "instructions", "rationale"],
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          readerState: { type: "string", enum: ["recognition", "understanding", "investigation", "selection"] },
          archetypeId: { type: "string" },
          instructions: { type: "string" },
          rationale: { type: "string" }
        }
      }
    }
  }
} as const;

const plannerPrompt = (context: ModelTurnContext): string =>
  [
    "You are commissioning editorial work for a publication, from its own strategy. You are NOT writing the articles.",
    "",
    `PUBLICATION GOAL: ${context.strategySummary.goal}`,
    `OFFER: ${context.strategySummary.offer}`,
    `AUDIENCE SEGMENTS: ${context.strategySummary.audienceSegments.join("; ") || "(none named)"}`,
    `CADENCE: ${context.strategySummary.cadence}`,
    `ANGLE MIX: ${context.strategySummary.angleMix.map((entry) => `${entry.angle} ${entry.share}`).join(", ") || "(none named)"}`,
    "",
    "READER ARCHETYPES (use one of these ids, never invent one):",
    ...context.commissioning.archetypes.map((archetype) => `- ${archetype.id}: ${archetype.job}`),
    "",
    `READER-STATE MIX the publication wants: ${Object.entries(context.commissioning.readerStateMix).map(([state, weight]) => `${state} ${weight}`).join(", ")}`,
    "",
    `ALREADY PUBLISHED (do not propose any of these again): ${context.publishedTitles.slice(0, 120).join(" | ") || "(nothing yet)"}`,
    `ALREADY IN FLIGHT: ${context.openTopics.join(" | ") || "(nothing)"}`,
    context.commissioning.exclusions.length ? `NEVER COMMISSION: ${context.commissioning.exclusions.join(" | ")}` : "",
    context.observations.length ? `WHAT THIS PUBLICATION HAS LEARNED:\n${context.observations.slice(0, 10).map((line) => `- ${line}`).join("\n")}` : "",
    "",
    `Propose ${context.wanted} DISTINCT pieces, best first. For each:`,
    "- topic: a short subject phrase, not a headline.",
    "- readerState: which of recognition/understanding/investigation/selection this piece serves. Favour the states the mix weights highest and the published set covers least.",
    "- archetypeId: one of the ids above.",
    "- instructions: ONE sentence briefing the writer, ending with the single concrete next step the reader should take.",
    "- rationale: ONE sentence on why this piece and not another, referring to the gap it fills.",
    "",
    "Propose nothing that duplicates the published or in-flight lists, even loosely. If there is genuinely nothing worth commissioning, return an empty array — a quiet day is a legitimate answer."
  ]
    .filter(Boolean)
    .join("\n");

/**
 * The synthetic-node idiom (`improvement/rubricJudge.ts`): a node that is never persisted in the
 * graph, run through the ordinary runner registry so it inherits schema-constrained JSON, validation
 * retries, the per-call budget guard and usage recording without a second copy of any client code.
 */
const syntheticPlannerNode = (prompt: string): WorkspaceNode =>
  ({
    id: PLANNER_NODE_ID,
    name: "Editorial planner",
    kind: "planning",
    description: "Synthetic commissioning node; never persisted in the workspace graph.",
    prompt,
    schema: CANDIDATE_SCHEMA,
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: CANDIDATE_SCHEMA,
    allowedTools: [],
    requiredInputs: [],
    produces: ["commission_candidates.v1"],
    riskLevel: "read",
    dependsOn: [],
    status: "active",
    position: { x: 0, y: 0 },
    updatedAt: new Date().toISOString(),
    assignedSkills: [],
    modelConfig: { budgetUsd: PLANNER_MODEL_BUDGET_USD, ...(process.env.EDITORIAL_PLANNER_MODEL ? { model: process.env.EDITORIAL_PLANNER_MODEL } : {}) },
    metadata: { synthetic: true }
  }) as unknown as WorkspaceNode;

const syntheticPlannerRun = (projectId: string): WorkflowExecutionRecord =>
  ({
    runId: `planner_${Date.now().toString(36)}`,
    workflowId: "editorial_planner",
    projectId,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
    artifacts: [],
    errors: [],
    approvalsRequired: [],
    stageOutputs: {},
    dryRun: true,
    executionMode: "openai",
    budgetUsd: PLANNER_MODEL_BUDGET_USD
  }) as unknown as WorkflowExecutionRecord;

export const proposeCandidatesWithModel = async (context: ModelTurnContext, executionRepository: ExecutionRepository): Promise<CandidateBrief[]> => {
  const node = syntheticPlannerNode(plannerPrompt(context));
  const result = await getNodeRunner("openai", node.modelConfig as Record<string, unknown> | undefined).run(
    { node, input: { wanted: context.wanted } },
    { run: syntheticPlannerRun(context.projectId), executionRepository }
  );
  // A refused or failed turn is NOT an error here. The seeds are the floor, and a tenant with seeds
  // publishes today regardless of whether the model had anything to add.
  if (!result.ok) return [];
  const output = result.output;
  const rows = isRecord(output) && Array.isArray(output.candidates) ? output.candidates : [];
  return rows
    .map((row, index): CandidateBrief | undefined => {
      if (!isRecord(row)) return undefined;
      const topic = typeof row.topic === "string" ? row.topic.trim() : "";
      const instructions = typeof row.instructions === "string" ? row.instructions.trim() : "";
      const rationale = typeof row.rationale === "string" ? row.rationale.trim() : "";
      const archetypeId = typeof row.archetypeId === "string" ? row.archetypeId.trim() : "";
      const readerState = row.readerState;
      if (!topic || !instructions || !archetypeId || typeof readerState !== "string") return undefined;
      return {
        topic,
        readerState: readerState as CandidateBrief["readerState"],
        archetypeId,
        instructions,
        rationale: rationale || `Proposed by the planner as candidate ${index + 1}.`,
        // Model candidates rank BELOW seeds at equal priority: a strategist's explicit seed outranks
        // a proposal, which is the whole reason seeds exist.
        priority: -index
      };
    })
    .filter((candidate): candidate is CandidateBrief => Boolean(candidate));
};

// ── plan ─────────────────────────────────────────────────────────────────────

export const planForProject = async (projectId: string, overrides: PlannerDeps = {}): Promise<PlannerResult> => {
  const d = deps(overrides);
  const now = d.now();
  const degraded: string[] = [];

  const config = await d.projectRepository.get(projectId);
  if (!config) return { projectId, planned: false, reason: "no_project_record", detail: `No project record for ${projectId}.` };

  const resolved = await getEditorialStrategy({ projectId }, strategyDeps(d));
  if (!resolved.strategy) return { projectId, planned: false, reason: "no_strategy", detail: resolved.warning ?? "No editorial_strategy could be resolved." };
  if (resolved.source !== "object" && resolved.source !== "default") degraded.push(`strategy_source:${resolved.source}`);

  const commissioning = readCommissioning(resolved.strategy);
  if (!commissioning) {
    return { projectId, planned: false, reason: "no_commissioning_block", detail: `${projectId}'s editorial_strategy has no commissioning block; this site publishes only what somebody asks for.` };
  }

  const read = overrides.readTenant ?? ((id: string, tool: string, args: Record<string, unknown>) => defaultReadTenant(d.projectRepository, id, tool, args));
  const from = new Date(now.getTime() - PLANNER_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [inventory, recentRuns, observations] = await Promise.all([
    readInventory(projectId, read),
    runFactsFor(projectId, { from }, d.executionRepository, d.usageRepository).catch((error) => {
      degraded.push(`runs_unavailable:${error instanceof Error ? error.message : String(error)}`);
      return [] as RunFact[];
    }),
    d.learningRepository
      .listObservations()
      .then((rows) =>
        rows
          .filter((row) => (row as { projectId?: string }).projectId === projectId || (row.metadata as { projectId?: string } | undefined)?.projectId === projectId)
          .map((row) => row.observation)
      )
      .catch(() => [] as string[])
  ]);
  if (inventory.degraded) degraded.push(inventory.degraded);

  const seeds = seedCandidates(commissioning);
  const pricedRunCostUsd = p95RunCost(recentRuns);

  // The model turn is asked for a couple more than the caps can possibly allow, so dedupe rejections
  // do not silently turn a two-run day into a one-run day.
  const wanted = Math.max(0, Math.min(8, commissioning.runsPerDay + 2));
  let modelCandidates: CandidateBrief[] = [];
  if (wanted > 0) {
    const context: ModelTurnContext = {
      projectId,
      commissioning,
      strategySummary: {
        goal: resolved.strategy.goal,
        offer: resolved.strategy.offer,
        audienceSegments: resolved.strategy.audience_segments ?? [],
        cadence: resolved.strategy.cadence,
        angleMix: resolved.strategy.angle_mix ?? []
      },
      // What the MODEL is shown as "already published". The id's topic segment is spelled out with
      // spaces rather than handed over raw: `req_plugin_azelaic_acid_20260904_01` tells a model
      // nothing, "azelaic acid" tells it everything.
      publishedTitles: inventory.items
        .map((item: { slug?: string; title?: string; objectId?: string }) => item.title ?? item.slug ?? (item.objectId ? topicFromRequestId(item.objectId) : undefined) ?? "")
        .filter(Boolean),
      openTopics: recentRuns.filter((run: RunFact) => Boolean(run.topicKey)).map((run: RunFact) => run.topicKey!),
      observations,
      wanted
    };
    try {
      modelCandidates = await (overrides.proposeCandidates ?? ((ctx: ModelTurnContext) => proposeCandidatesWithModel(ctx, d.executionRepository)))(context);
    } catch (error) {
      degraded.push(`model_turn_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const plan = buildCommissionPlan({
    projectId,
    commissioning,
    candidates: [...seeds, ...modelCandidates],
    inventory: inventory.items,
    recentRuns,
    ...(pricedRunCostUsd !== undefined ? { pricedRunCostUsd } : {}),
    ...(config.objectDialect?.requestIdPattern ? { requestIdPattern: config.objectDialect.requestIdPattern } : {}),
    now
  });

  return {
    projectId,
    planned: true,
    enabled: commissioning.enabled,
    plan,
    ...(plan.halt ? { blockage: plannerHaltBlockage(projectId, plan.halt) } : {}),
    inputs: {
      inventoryCount: inventory.items.length,
      recentRunCount: recentRuns.length,
      candidateCount: seeds.length + modelCandidates.length,
      seedCount: seeds.length,
      modelCandidateCount: modelCandidates.length,
      pricedRunCostUsd: plan.caps.pricedRunCostUsd,
      degraded
    }
  };
};

// ── commission ───────────────────────────────────────────────────────────────

/**
 * Start the runs a plan authorized. `max` is a caller-side ADDITIONAL clamp, never a way to exceed
 * the plan: `planner.commission {max: 5}` on a plan holding one request starts one run.
 *
 * `enabled: false` is honoured HERE and not in `planForProject`, on purpose. Planning a disabled
 * tenant is useful — it is how an operator sees what would happen before switching it on — and
 * costs nothing but a model turn. Starting a run for one never is.
 */
export const commissionForProject = async (
  projectId: string,
  options: { planId?: string; max?: number; holder?: string } = {},
  overrides: PlannerDeps = {}
): Promise<CommissionResult> => {
  const d = deps(overrides);
  const reservations = d.reservationStore ?? getCommissionReservationStore();

  // C7 — THE PASS LEASE, AND WHY IT IS TAKEN BEFORE THE PLAN.
  //
  // Per-request reservations (below) stop two callers minting the same request id twice. They do
  // nothing about two overlapping passes that each read `runsAlreadyToday: 0`, each pick a
  // DIFFERENT top topic, and each start a full day's allowance — plan.ts's caps are computed once,
  // from a read that is already stale by the time the first run starts. One pass per project at a
  // time is what makes `runsPerDay` mean runs per day rather than runs per invocation.
  //
  // Taken before `planForProject` on purpose: a caller that is going to lose should not also pay
  // for the model turn of a plan it will never spend.
  const lease = await reservations.acquirePass(projectId, options.holder ?? PLANNER_NODE_ID);
  if (!lease.ok) {
    return { projectId, planned: false, reason: "pass_in_flight", detail: lease.detail, commissioned: [] } as CommissionResult;
  }

  try {
    const result = await planForProject(projectId, overrides);
    if (!result.planned) return result;
    if (!result.enabled) {
      return { ...result, planned: false, reason: "commissioning_disabled", detail: `${projectId} has commissioning.enabled = false; planned ${result.plan.requests.length} request(s) and started none.`, commissioned: [] } as CommissionResult;
    }
    if (result.plan.halt) return { ...result, commissioned: [] };
    // C7 — A DEGRADED PLAN IS A PREVIEW, NOT A BUDGET.
    //
    // `planForProject` carries on when the run history cannot be read, records `runs_unavailable:`
    // and plans anyway. That is right for `planner.plan`, which is a preview and says so. It is
    // wrong here: with no run history the caps compute `runsAlreadyToday: 0`, `spentTodayUsd: 0`,
    // `openRuns: 0`, so the one call that cannot see what today already cost is the call that
    // authorizes a whole fresh day of it. Refuse to SPEND on a plan that could not count.
    const unreadableRuns = result.inputs.degraded.find((note) => note.startsWith("runs_unavailable:"));
    if (unreadableRuns) {
      return { ...result, planned: false, reason: "run_history_unreadable", detail: `${projectId}'s run history could not be read (${unreadableRuns}), so today's run count, spend and concurrency are all unknown; planned ${result.plan.requests.length} request(s) and started none.`, commissioned: [] } as CommissionResult;
    }
    // A stale planId is refused rather than ignored: an operator commissioning "the plan I just read"
    // must not silently get a different one built from inventory that changed in between.
    if (options.planId && options.planId !== result.plan.planId) {
      return { ...result, commissioned: [], inputs: { ...result.inputs, degraded: [...result.inputs.degraded, `plan_id_stale: asked for ${options.planId}, current plan is ${result.plan.planId}`] } };
    }

    const limit = options.max === undefined ? result.plan.requests.length : Math.max(0, Math.min(result.plan.requests.length, Math.floor(options.max)));
    const commissioned: CommissionOutcome[] = [];
    for (const request of result.plan.requests.slice(0, limit)) {
      commissioned.push(await startCommissionedRun(projectId, request, d, reservations));
    }
    return { ...result, commissioned };
  } finally {
    // Released whatever happened, including a throw out of planForProject: a lease that leaks would
    // silence this tenant's commissioning until PASS_LEASE_STALE_MS expires.
    await reservations.releasePass(projectId, lease.token);
  }
};

const startCommissionedRun = async (
  projectId: string,
  request: CommissionRequest,
  d: ReturnType<typeof deps>,
  reservations: CommissionReservationStore
): Promise<CommissionOutcome> => {
  const base = { requestId: request.requestId, topic: request.contentSource.topic, rationale: request.rationale };
  let reservation: CommissionReservation | undefined;
  try {
    // 1 — EVIDENCE: today's runs for this project, read for real.
    //
    // This read used to end in `.catch(() => [])`, which made a store that could not be read
    // indistinguishable from a store that answered "nothing has run today" — and on the one day the
    // read fails, that answer is what clears the way for the duplicate the check exists to prevent.
    // A read that did not happen is not evidence of absence, so a failure now REFUSES the start and
    // says so, rather than proceeding on an empty list it invented.
    //
    // Bounded to today because a minted id carries today's date, so a collision can only be with a
    // run started today. There is no requestId filter on the store, and listing a project's whole
    // history to answer this would cost more than the race it prevents.
    const startOfDay = new Date(d.now()); startOfDay.setUTCHours(0, 0, 0, 0);
    let existing: WorkflowExecutionRecord[];
    try {
      existing = await d.executionRepository.listRuns({ projectId, from: startOfDay.toISOString() });
    } catch (error) {
      return { ...base, started: false, error: `Refusing to commission ${request.requestId} on ${projectId}: today's run list could not be read (${error instanceof Error ? error.message : String(error)}), so it cannot be shown that no run already exists for this request id.` };
    }
    if (existing.some((run) => run.requestId === request.requestId)) {
      return { ...base, started: false, error: `A run for ${request.requestId} already exists on ${projectId}; refusing to start a second one on the same request id.` };
    }

    // 2 — THE ATOMIC CLAIM. `onlyIfNew` in the object store, so the loser of a genuine race is told
    // it lost BY THE STORE rather than by a re-read that races in turn. This is what the old
    // check-then-start could not do at any window size, and it holds across processes — the 06:00
    // Cloud Run job, an operator's `planner.commission` over MCP, and a Netlify function share no
    // memory, only this bucket.
    //
    // `allowReclaim` is true only because step 1 SUCCEEDED and showed no run for this id. A stale
    // reservation whose run is actually alive must stay held: reclaiming one on an assumption is
    // the double-spend, wearing the costume of a repair.
    const claim = await reservations.reserve(projectId, request.requestId, PLANNER_NODE_ID, { allowReclaim: true });
    if (!claim.ok) {
      return claim.reason === "held"
        ? { ...base, started: false, error: `${request.requestId} is already reserved on ${projectId} by ${claim.holder.reservedBy} (${claim.holder.state}${claim.holder.runId ? `, run ${claim.holder.runId}` : ""}, reserved ${claim.holder.reservedAt}); refusing to start a second run on the same request id.` }
        : { ...base, started: false, error: `Refusing to commission ${request.requestId} on ${projectId}: ${claim.detail}.` };
    }
    reservation = claim.reservation;

    const run = await startDryRun(
      {
        projectId,
        input: {
          contentSource: request.contentSource,
          instructions: request.instructions,
          trafficSource: request.trafficSource,
          awarenessStage: request.awarenessStage
        },
        executionMode: "openai",
        requestId: request.requestId,
        commissionedBy: COMMISSIONED_BY,
        commissioningRationale: request.rationale
      },
      d.executionRepository,
      d.workspaceRepository,
      d.projectRepository
    );
    // 3 — BIND THE CLAIM TO THE RUN. After this the reservation is never reclaimable by age: a long
    // run is exactly the case where "it has been quiet for a while" must not mean "start another".
    await reservations.markStarted(projectId, request.requestId, run.runId).catch(() => undefined);
    // THE KICK, exactly as platform's run_workspace_workflow does it: start_dry_run only queues, and
    // one node is enough to hand the run to the continuation tick. Driving the whole run here would
    // put a twenty-node pipeline inside a job's task window.
    await runNextNode(run.runId, { executionRepository: d.executionRepository, ...(d.workspaceRepository ? { workspaceRepository: d.workspaceRepository } : {}) }).catch(() => undefined);
    await d.learningRepository
      .recordObservation(
        `editorial_planner commissioned "${request.contentSource.topic}" (${request.contentSource.readerState}, ${request.trafficSource}/${request.awarenessStage}) for ${projectId}: ${request.rationale}`,
        { kind: "commission", projectId, requestId: request.requestId, runId: run.runId, dedupeKey: request.dedupeKey, topic: request.contentSource.topic },
        { runId: run.runId, nodeId: PLANNER_NODE_ID, projectId }
      )
      .catch(() => undefined);
    return { ...base, runId: run.runId, started: true };
  } catch (error) {
    // One tenant's refusal — a subject gate, a budget block, a dead workspace — must not stop the
    // rest of the plan or the rest of the fleet.
    //
    // Release the claim on the way out, so a start that was REFUSED does not wedge this request id
    // until the stale window expires. Recorded as `abandoned` rather than deleted: "tried, and
    // refused for this reason" is a fact the next pass wants, and an absent key cannot state it.
    const detail = error instanceof Error ? error.message : String(error);
    if (reservation) await reservations.abandon(projectId, request.requestId, `start refused: ${detail}`).catch(() => undefined);
    return { ...base, started: false, error: detail };
  }
};

// ── status ───────────────────────────────────────────────────────────────────

export type PlannerStatus = {
  projectId: string;
  enabled: boolean;
  configured: boolean;
  runsToday: number;
  runsPerDay: number;
  spentTodayUsd: number;
  dailyBudgetUsd: number;
  openRuns: number;
  maxConcurrentRuns: number;
  consecutiveFailures: number;
  halted: boolean;
  nextEligibleAt: string;
  detail?: string;
};

/** Today's counts, the halt state, and the next time this tenant could commission anything. Reads only. */
export const plannerStatus = async (projectId: string, overrides: PlannerDeps = {}): Promise<PlannerStatus> => {
  const d = deps(overrides);
  const now = d.now();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const empty: PlannerStatus = { projectId, enabled: false, configured: false, runsToday: 0, runsPerDay: 0, spentTodayUsd: 0, dailyBudgetUsd: 0, openRuns: 0, maxConcurrentRuns: 0, consecutiveFailures: 0, halted: false, nextEligibleAt: tomorrow.toISOString() };

  const resolved = await getEditorialStrategy({ projectId }, strategyDeps(d));
  const commissioning = resolved.strategy ? readCommissioning(resolved.strategy) : undefined;
  if (!commissioning) return { ...empty, detail: resolved.strategy ? "No commissioning block on this tenant's editorial_strategy." : (resolved.warning ?? "No editorial_strategy resolved.") };

  const from = new Date(now.getTime() - PLANNER_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recentRuns = await runFactsFor(projectId, { from }, d.executionRepository, d.usageRepository).catch(() => [] as RunFact[]);
  const plan = buildCommissionPlan({ projectId, commissioning, candidates: [], inventory: [], recentRuns, ...(p95RunCost(recentRuns) !== undefined ? { pricedRunCostUsd: p95RunCost(recentRuns)! } : {}), now });

  return {
    projectId,
    enabled: commissioning.enabled,
    configured: true,
    runsToday: plan.caps.runsAlreadyToday,
    runsPerDay: plan.caps.runsPerDay,
    spentTodayUsd: plan.caps.spentTodayUsd,
    dailyBudgetUsd: plan.caps.dailyBudgetUsd,
    openRuns: plan.caps.openRuns,
    maxConcurrentRuns: plan.caps.maxConcurrentRuns,
    consecutiveFailures: plan.halt?.consecutiveFailures ?? 0,
    halted: Boolean(plan.halt),
    // A halted planner has no next eligible time at all — it is waiting on a person, not on a clock.
    // Saying "tomorrow" there would be a promise nothing keeps.
    nextEligibleAt: plan.halt ? "blocked" : plan.caps.slots > 0 ? now.toISOString() : tomorrow.toISOString(),
    ...(plan.halt ? { detail: plan.halt.message } : {})
  };
};

export const plannerDedupeKey = dedupeKeyOf;
