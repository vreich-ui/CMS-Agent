// Publishing Conductor cost controls. The conductor is the orchestration layer that drives the
// publishing workflow; these facilities let it keep a run cheap:
//   1. RunScopedCache memoizes reusable, run-invariant reads (project contract, article_body schema,
//      project tool policy, object contracts, node registry) so repeated tool calls within a run do
//      not re-fetch them.
//   2. summarizeRunCost turns the per-node usage records the runner already writes into a ledger,
//      surfacing the most expensive stages and which completed stages are reusable.
//   3. planRun recommends the narrowest way to make progress — poll a terminal run, resume a blocked
//      one, re-enter at the late-stage entrypoint reusing a finished article_body, or run in full —
//      so a full rerun is only chosen when nothing cheaper applies.

import { articleBodyJsonSchema } from "../mcp/workspace/store.js";
import { getProjectHooks } from "../projects/projectHooks.js";
import { toProjectSummary } from "../projects/projectRegistry.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { ModelUsageSummary } from "../observability/modelUsageTypes.js";
import { listWorkspaceNodes } from "./nodes.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "./executionTypes.js";

// Per-run memoization keyed by (runId, resourceKey). A loader runs at most once per key per run; the
// value is reused for the life of the run. Run ids are unique, so entries never collide across runs.
export class RunScopedCache {
  private readonly cache = new Map<string, Map<string, unknown>>();

  async getOrLoad<T>(runId: string, key: string, loader: () => Promise<T> | T): Promise<T> {
    const existing = this.cache.get(runId);
    if (existing && existing.has(key)) return existing.get(key) as T;
    const value = await loader();
    // Re-read after the await: a concurrent first-load for the same run may have created the inner
    // map (or the same key) meanwhile. Reuse it instead of clobbering, and prefer an already-stored
    // value so concurrent loads converge (the cached reads are run-invariant).
    let perRun = this.cache.get(runId);
    if (!perRun) { perRun = new Map(); this.cache.set(runId, perRun); }
    if (perRun.has(key)) return perRun.get(key) as T;
    perRun.set(key, value);
    return value;
  }

  has(runId: string, key: string): boolean { return this.cache.get(runId)?.has(key) ?? false; }
  invalidateRun(runId: string): void { this.cache.delete(runId); }
  clear(): void { this.cache.clear(); }
  stats(): { runs: number; entries: number } { return { runs: this.cache.size, entries: [...this.cache.values()].reduce((total, perRun) => total + perRun.size, 0) }; }
}

// Process-wide conductor cache. Keyed by runId so a completed run's context stays reusable for
// status/artifact polling without re-reading contracts.
export const conductorCache = new RunScopedCache();

export const RUN_CONTEXT_KEY = "run_context";

export type RunContext = {
  projectId: string;
  projectContract: { contentContract: string; canonicalArticleBody: string; publishingPolicy: unknown };
  articleBodySchema: unknown;
  projectToolPolicy: { defaultToolPolicy: string; allowedTools: string[]; toolPolicies: Record<string, string> };
  objectContracts: unknown;
  registry: Array<{ id: string; produces: string[]; riskLevel: string; dependsOn: string[] }>;
};

// Assemble the reusable per-run context bundle, memoized per (runId, projectId). Subsequent calls
// within the run return the cached bundle without touching the project repository or hook registry.
export async function getRunContext(params: { runId: string; projectId: string; projectRepository: ProjectRepository; cache?: RunScopedCache }): Promise<RunContext> {
  const cache = params.cache ?? conductorCache;
  return cache.getOrLoad(params.runId, `${RUN_CONTEXT_KEY}:${params.projectId}`, async () => {
    const config = await params.projectRepository.get(params.projectId);
    if (!config) throw new Error(`Unknown projectId: ${params.projectId}`);
    const summary = toProjectSummary(config);
    return {
      projectId: params.projectId,
      projectContract: { ...summary.contentContract, publishingPolicy: summary.publishingPolicy },
      articleBodySchema: articleBodyJsonSchema,
      projectToolPolicy: { defaultToolPolicy: summary.defaultToolPolicy, allowedTools: summary.allowedTools, toolPolicies: summary.toolPolicies },
      objectContracts: getProjectHooks(params.projectId)?.knowledge ?? null,
      registry: listWorkspaceNodes().map((node) => ({ id: node.id, produces: [...node.produces], riskLevel: node.riskLevel, dependsOn: [...node.dependsOn] }))
    } satisfies RunContext;
  });
}

export type StageCost = {
  nodeId: string;
  status: ExecutionStatus;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsdEstimate: number;
  // A completed stage's output can be reused (seeded into a narrow re-run) instead of recomputed.
  reusable: boolean;
};

export type RunCostLedger = {
  runId: string;
  status: ExecutionStatus;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsdEstimate: number;
  stages: StageCost[];
  mostExpensiveNodeId?: string;
  reusableNodeIds: string[];
  remainingNodeIds: string[];
};

// Build a per-node cost ledger by joining the run's node states with the usage summary the runner
// already records (summarizeModelUsage(byNode)). Completed nodes are marked reusable; queued nodes
// are what remains to spend on.
export function summarizeRunCost(run: WorkflowExecutionRecord, usage: ModelUsageSummary): RunCostLedger {
  const stages: StageCost[] = run.nodes.map((node) => {
    const bucket = usage.byNode[node.nodeId];
    return {
      nodeId: node.nodeId,
      status: node.status,
      inputTokens: bucket?.inputTokens ?? 0,
      outputTokens: bucket?.outputTokens ?? 0,
      totalTokens: bucket?.totalTokens ?? 0,
      costUsdEstimate: bucket?.costUsdEstimate ?? 0,
      reusable: node.status === "completed"
    };
  });
  const mostExpensive = stages.reduce<StageCost | undefined>((top, stage) => (!top || stage.costUsdEstimate > top.costUsdEstimate ? stage : top), undefined);
  return {
    runId: run.runId,
    status: run.status,
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalTokens: usage.totalTokens,
    totalCostUsdEstimate: usage.totalCostUsdEstimate,
    stages,
    mostExpensiveNodeId: mostExpensive && mostExpensive.costUsdEstimate > 0 ? mostExpensive.nodeId : undefined,
    reusableNodeIds: stages.filter((stage) => stage.reusable).map((stage) => stage.nodeId),
    remainingNodeIds: stages.filter((stage) => stage.status === "queued").map((stage) => stage.nodeId)
  };
}

export type RunPlanStrategy = "poll" | "resume" | "late_stage_rerun" | "full_run";
export type RunPlan = {
  runId: string;
  strategy: RunPlanStrategy;
  reason: string;
  reusableStages: string[];
  remainingStages: string[];
  recommendedEntrypoint?: "article_body";
  // True when the recommended strategy does less work than re-running the whole workflow.
  narrowerThanFullRun: boolean;
};

const TERMINAL_NON_BLOCKED = new Set<ExecutionStatus>(["completed", "failed", "cancelled"]);

// Recommend the cheapest way to make progress on a run. Prefers polling/resuming/late-stage reuse
// over a full rerun; a full run is recommended only when no reusable late-stage artifact exists yet.
export function planRun(run: WorkflowExecutionRecord): RunPlan {
  const reusableStages = run.nodes.filter((node) => node.status === "completed").map((node) => node.nodeId);
  const remainingStages = run.nodes.filter((node) => node.status === "queued").map((node) => node.nodeId);
  const articleBodyReady = run.nodes.find((node) => node.nodeId === "article_body")?.status === "completed";
  const base = { runId: run.runId, reusableStages, remainingStages } as const;

  if (TERMINAL_NON_BLOCKED.has(run.status)) {
    return { ...base, strategy: "poll", reason: "Run is terminal; poll status and artifacts instead of rerunning.", narrowerThanFullRun: true };
  }
  if (run.status === "blocked") {
    return { ...base, strategy: "resume", reason: "Run is blocked awaiting approval; supply approval and continue rather than restarting.", narrowerThanFullRun: true };
  }
  if (articleBodyReady) {
    return { ...base, strategy: "late_stage_rerun", recommendedEntrypoint: "article_body", reason: "article_body is complete; a re-run can enter at the publish stages reusing the existing body instead of re-running ideation/research/draft.", narrowerThanFullRun: true };
  }
  return { ...base, strategy: "full_run", reason: "No reusable late-stage artifact yet; continue the run from its current node.", narrowerThanFullRun: false };
}
