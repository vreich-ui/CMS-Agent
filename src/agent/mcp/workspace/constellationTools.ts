import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import type { UsageRepository } from "../../repository/interfaces/UsageRepository.js";
import type { SkillRepository } from "../../repository/interfaces/SkillRepository.js";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import { resolveSkillsForNode } from "../../skills/skillResolver.js";
import { toProjectSummary } from "../../projects/projectRegistry.js";
import { listTools } from "../../tools/toolResolver.js";
import { listToolExecutions } from "../../tools/toolExecutor.js";
import { aggregateAgentMetrics, aggregateRelationshipMetrics, buildAttentionItems, buildConstellationSummary, deriveExecutionEdges, type ConstellationInputs, type RunWindow } from "../../observability/constellationMetrics.js";
import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";

const metricsInput = z.object({
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
}).strict();
const metricsJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } });

const summaryInput = z.object({ projectId: z.string().min(1).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();
const summaryJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } });

const attentionInput = z.object({ projectId: z.string().min(1).optional() }).strict();
const attentionJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 } });

// Exactly one addressing mode: a stored relationship id, or a source/target pair (which can also
// resolve a derived execution edge).
const relationshipInput = z.object({
  relationshipId: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  targetId: z.string().min(1).optional()
}).strict().refine(
  (data) => (data.relationshipId !== undefined) !== (data.sourceId !== undefined && data.targetId !== undefined),
  { message: "Provide either relationshipId or both sourceId and targetId." }
);
const relationshipJsonSchema = objectSchema({ relationshipId: { type: "string", minLength: 1 }, sourceId: { type: "string", minLength: 1 }, targetId: { type: "string", minLength: 1 } });

const emptyInput = z.object({}).strict();

export type ConstellationToolDeps = {
  workspaceRepository: WorkspaceRepository;
  executionRepository: ExecutionRepository;
  usageRepository: UsageRepository;
  // R-10: get_attention has to reach the skill and project layers to report the defect classes it
  // was previously blind to. Optional so existing callers/tests construct these tools unchanged —
  // the checks that need them are simply skipped when absent.
  skillRepository?: SkillRepository;
  projectRepository?: ProjectRepository;
};

type Filters = { projectId?: string; runId?: string; from?: string; to?: string };

/**
 * W3 — how many run RECORDS a constellation read is allowed to open.
 *
 * gatherInputs used to call `executionRepository.listRuns({})`, which on the blob backend
 * means `store.list("runs/")` plus a GET of every run blob in the fleet — 115 of them, one
 * 1.19MB, on a 1 vCPU / 1Gi Cloud Run instance. That did not merely make
 * constellation_get_attention slow: it killed the instance, taking every other in-flight
 * request on it down with the connection (measured live 2026-09-14 — the call dropped
 * somewhere between 13s and 56s, every time). The full-fleet cache that was supposed to
 * absorb this is invalidated by every saveRun, and the continuation tick saves every two
 * minutes, so it was never warm when it mattered.
 *
 * 50 is chosen against what these reducers actually answer. Attention is "what needs a
 * human NOW" — blocked, failed, stalled, awaiting approval — which lives at the newest end
 * of the list by construction; a run that has been finished for two hundred runs is not
 * waiting on anybody. Per-agent metrics and relationship interactions are operational
 * signal about recent behaviour, not a lifetime ledger (`usageRepository` holds that, and
 * is still read unwindowed here — its records are small and already filtered server-side).
 * The one figure that genuinely is a lifetime count, `summary.runs.total`, is answered from
 * `page.matchedCount`, which the index produces without opening a single record.
 *
 * The window is not silent: every response reports it, and the four tool descriptions below
 * say so.
 */
const RUN_WINDOW_LIMIT = 50;

/**
 * REVIEW FIX — the statuses get_attention reads on their OWN axis, not on recency.
 *
 * The recency window above is justified for metrics and relationships, and for FAILED runs it is
 * justified for attention too: a run fails and stops, so it is newest-ish when it matters. It is
 * simply false for the other three. A run that is blocked on an operator, paused, or running has
 * by definition stopped advancing while newer runs keep being created — so its startedAt recedes
 * without bound, and it is the FIRST row to fall out of a newest-50 window. 200 runs whose newest
 * 50 all completed, with 24 older ones blocked awaiting approval, would have produced an empty
 * attention list and a strip reading "nothing is waiting on you": a confident false statement, on
 * the one surface whose entire job is to not make one.
 *
 * So get_attention takes a second windowed read scoped to these statuses and merges it. It is
 * still bounded (two windows, <= 100 records), still index-first, and now cannot miss a waiting
 * run merely because the fleet moved on without it.
 */
const ATTENTION_STATUSES = ["running", "paused", "blocked", "failed"] as const;

/**
 * REVIEW FIX (round 2) — get_attention's RECENCY window is smaller than the other tools', so
 * two windows cannot add up to a read comparable to the one W3 removed.
 *
 * With both windows at 50 the worst case was 100 full run records on a 1 vCPU / 1Gi instance —
 * 87% of the 115 that this change's own commit message documents as having killed the instance
 * and dropped every in-flight request with it. Overlap usually keeps the real number far lower,
 * but "usually" is not a bound.
 *
 * 20 is enough for what the recency window uniquely contributes HERE: everything an attention
 * item is actually about (blocked, failed, stalled, awaiting approval) comes from the
 * status-scoped window, and the recency read only widens the output-validation tally over runs
 * that have since completed. Worst case is now 70, typically nearer 50, and `runWindow` reports
 * both reads so the coverage is never implied.
 */
const ATTENTION_RECENCY_LIMIT = 20;

export function createConstellationTools({ workspaceRepository, executionRepository, usageRepository, skillRepository, projectRepository }: ConstellationToolDeps): WorkspaceTool[] {
  // Raw records are gathered here and only aggregates leave the tools; the raw runs/usage/tool
  // records remain available through their existing dedicated tools.
  // A runId-scoped read addresses ONE run, so it fetches that run directly rather than
  // hoping it falls inside the newest-50 window. Under the old full-fleet read this
  // happened to work for any run ever recorded; a window would silently have started
  // answering "no such run" for anything older, which is a worse failure than slowness.
  const gatherRunWindow = async (
    filters: Filters,
    limit: number = RUN_WINDOW_LIMIT
  ): Promise<{ runs: WorkflowExecutionRecord[]; runWindow?: RunWindow }> => {
    if (filters.runId) {
      const run = await executionRepository.getRun(filters.runId);
      const matches =
        run !== undefined &&
        (!filters.projectId || run.projectId === filters.projectId) &&
        (!filters.from || run.startedAt >= filters.from) &&
        (!filters.to || run.startedAt <= filters.to);
      return { runs: matches ? [run] : [] };
    }
    // from/to go to the repository rather than being applied after the fact: the window
    // must be the newest 50 WITHIN the range the caller asked about, not the newest 50
    // overall then narrowed (which would return nothing for a range that has scrolled off).
    const page = await executionRepository.listRunsPage({
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      limit
    });
    return {
      runs: page.runs,
      runWindow: { limit, examined: page.runs.length, matchedCount: page.matchedCount, hasMore: page.hasMore }
    };
  };

  const gatherInputs = async (filters: Filters = {}, runLimit: number = RUN_WINDOW_LIMIT): Promise<ConstellationInputs> => {
    const [nodes, relationships, runWindowResult, usageRecords] = await Promise.all([
      workspaceRepository.getNodes(),
      workspaceRepository.listRelationships(),
      gatherRunWindow(filters, runLimit),
      usageRepository.list({ projectId: filters.projectId, runId: filters.runId, from: filters.from, to: filters.to })
    ]);
    return {
      nodes,
      relationships,
      runs: runWindowResult.runs,
      ...(runWindowResult.runWindow ? { runWindow: runWindowResult.runWindow } : {}),
      usageRecords,
      toolExecutions: listToolExecutions()
    };
  };

  /**
   * get_attention's run set: the recency window, PLUS a window scoped to the statuses that stop
   * advancing (see ATTENTION_STATUSES). Merged by runId — a run in both reads is one run.
   */
  const gatherAttentionInputs = async (filters: Filters = {}): Promise<ConstellationInputs> => {
    const base = await gatherInputs(filters, ATTENTION_RECENCY_LIMIT);
    // A runId-scoped read already addresses exactly one run; there is nothing to widen.
    if (filters.runId || !base.runWindow) return base;

    const scoped = await executionRepository.listRunsPage({
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      status: [...ATTENTION_STATUSES],
      limit: RUN_WINDOW_LIMIT
    });

    const byId = new Map(base.runs.map((run) => [run.runId, run]));
    for (const run of scoped.runs) byId.set(run.runId, run);
    const runs = [...byId.values()];

    return {
      ...base,
      runs,
      runWindow: {
        // `examined` keeps its documented meaning — the RECENCY window's own record count,
        // <= limit. The merged figure is reported separately as `merged`, because a consumer
        // computing coverage as examined/limit on a number larger than limit gets nonsense.
        ...base.runWindow,
        merged: runs.length,
        attention: {
          statuses: [...ATTENTION_STATUSES],
          examined: scoped.runs.length,
          matchedCount: scoped.matchedCount,
          hasMore: scoped.hasMore
        }
      }
    };
  };

  // R-10: the extra reads only get_attention needs. Kept out of gatherInputs so the metrics and
  // summary tools do not pay for a per-node skill resolution they never look at.
  const gatherConfigurationInputs = async (base: ConstellationInputs): Promise<ConstellationInputs> => {
    const toolRiskLevels = Object.fromEntries(listTools().map((definition) => [definition.toolId, definition.riskLevel]));

    const skillPolicies = skillRepository
      ? await Promise.all(base.nodes.map(async (node) => {
          const policy = await resolveSkillsForNode(node, skillRepository);
          return { nodeId: node.id, conflicts: policy.conflicts, requestedTools: policy.requestedTools, deniedTools: policy.deniedTools, deniedToolReasons: policy.deniedToolReasons, effectiveTools: policy.effectiveTools };
        }))
      : undefined;

    const projects = projectRepository
      ? (await projectRepository.list()).map((config) => {
          const summary = toProjectSummary(config);
          return { projectId: summary.projectId, status: summary.status, connection: summary.connection };
        })
      : undefined;

    return { ...base, toolRiskLevels, ...(skillPolicies ? { skillPolicies } : {}), ...(projects ? { projects } : {}) };
  };

  return [
    tool({
      name: "constellation.get_structure",
      description: "Constellation structural data: agent summaries, stored typed relationships, and execution edges derived from node.dependsOn. Read-only.",
      zodSchema: emptyInput,
      inputSchema: objectSchema(),
      execute: async (input) => {
        emptyInput.parse(input);
        const [nodes, relationships] = await Promise.all([workspaceRepository.getNodes(), workspaceRepository.listRelationships()]);
        return ok({
          agents: nodes.map((node) => ({ id: node.id, name: node.name, kind: node.kind, status: node.status, riskLevel: node.riskLevel, dependsOn: node.dependsOn, position: node.position })),
          relationships,
          derivedExecutionEdges: deriveExecutionEdges(nodes)
        });
      }
    }),
    tool({
      name: "constellation.get_metrics",
      description: "Aggregated per-agent operational metrics (usage split by estimated/actual, executions, latency, derived retries, human intervention, output validation failures, current-process tool errors). Read-only; never billing-grade. RUN WINDOW: run-derived figures read only the newest 50 runs matching the filters (`runWindow` on the response reports limit/examined/matchedCount/hasMore, and `hasMore: true` means older runs were not opened). Narrow with projectId/from/to, or read older runs through workflow.list_runs / workflow.get_run. A `runId` argument addresses that one run directly and is never windowed.",
      zodSchema: metricsInput,
      inputSchema: metricsJsonSchema,
      execute: async (input) => {
        const filters = metricsInput.parse(input);
        const inputs = await gatherInputs(filters);
        const summary = buildConstellationSummary(inputs, new Date().toISOString());
        return ok({ agents: aggregateAgentMetrics(inputs), generatedAt: summary.generatedAt, caveats: summary.caveats, ...(inputs.runWindow ? { runWindow: inputs.runWindow } : {}) });
      }
    }),
    tool({
      name: "constellation.get_relationship",
      description: "One relationship (stored, or a derived execution edge addressed by source/target) with its derived interaction metrics. Read-only. RUN WINDOW: run-derived figures read only the newest 50 runs matching the filters (`runWindow` on the response reports limit/examined/matchedCount/hasMore, and `hasMore: true` means older runs were not opened). Narrow with projectId/from/to, or read older runs through workflow.list_runs / workflow.get_run.",
      zodSchema: relationshipInput,
      inputSchema: relationshipJsonSchema,
      execute: async (input) => {
        const data = relationshipInput.parse(input);
        const inputs = await gatherInputs();
        const metrics = aggregateRelationshipMetrics(inputs);
        const window = inputs.runWindow ? { runWindow: inputs.runWindow } : {};
        if (data.relationshipId) {
          const relationship = inputs.relationships.find((candidate) => candidate.id === data.relationshipId) ?? null;
          return ok({ relationship, metrics: metrics.find((candidate) => candidate.relationshipId === data.relationshipId) ?? null, ...window });
        }
        const stored = inputs.relationships.find((candidate) => candidate.sourceId === data.sourceId && candidate.targetId === data.targetId);
        if (stored) return ok({ relationship: stored, metrics: metrics.find((candidate) => candidate.relationshipId === stored.id) ?? null, ...window });
        const derived = deriveExecutionEdges(inputs.nodes).find((edge) => edge.sourceId === data.sourceId && edge.targetId === data.targetId) ?? null;
        return ok({ relationship: derived, metrics: derived ? metrics.find((candidate) => candidate.relationshipId === undefined && candidate.sourceId === data.sourceId && candidate.targetId === data.targetId) ?? null : null, ...window });
      }
    }),
    tool({
      name: "constellation.get_summary",
      description: "System summary for the constellation: agent/relationship/run counts and usage totals split by estimated/actual, with explicit caveats. Read-only. `runs.total` is every matching run, counted off the run index; `runs.byStatus` covers only the examined window (`runs.examined`, `runs.windowed`). RUN WINDOW: run-derived figures read only the newest 50 runs matching the filters (`runWindow` on the response reports limit/examined/matchedCount/hasMore, and `hasMore: true` means older runs were not opened). Narrow with projectId/from/to, or read older runs through workflow.list_runs / workflow.get_run.",
      zodSchema: summaryInput,
      inputSchema: summaryJsonSchema,
      execute: async (input) => {
        const filters = summaryInput.parse(input);
        const inputs = await gatherInputs(filters);
        return ok({ summary: buildConstellationSummary(inputs, new Date().toISOString()), ...(inputs.runWindow ? { runWindow: inputs.runWindow } : {}) });
      }
    }),
    tool({
      name: "constellation.get_attention",
      description: "Attention items with explicit evidence-citing reasons: failed runs, pending approvals, output-validation failures, pricing caveats, relationship issues, and (R-10) configuration defects — blocker-severity skill conflicts, skills requesting tools the node denies, dependsOn/requiredInputs disagreements, tools a node grants itself above its own risk level, and active client connections whose environment variables are unconfigured. No composite scores. Read-only. RUN WINDOW: run-derived figures read only the newest 20 runs matching the filters (`runWindow` on the response reports limit/examined/matchedCount/hasMore, and `hasMore: true` means older runs were not opened). Narrow with projectId/from/to, or read older runs through workflow.list_runs / workflow.get_run. That recency window is deliberately SMALLER than the other constellation tools' 50, because this tool also reads a SECOND window scoped to status running/paused/blocked/failed and merges them, because a run that is waiting on a human has by definition stopped advancing while newer runs keep being created — so it is the first row a newest-first window would lose, which is precisely the run that must never be missed. `runWindow.attention` reports that second read separately, and `runWindow.merged` the size of the union; `runWindow.limit`/`examined` describe the recency read only. ONE consequence worth knowing: the output-validation-failure item scans run errors across ALL statuses, including completed runs, so it is the one item class that sees 20 runs here where constellation.get_metrics sees 50 for the same filters.",
      zodSchema: attentionInput,
      inputSchema: attentionJsonSchema,
      execute: async (input) => {
        const filters = attentionInput.parse(input);
        const inputs = await gatherConfigurationInputs(await gatherAttentionInputs(filters));
        return ok({ items: buildAttentionItems(inputs), ...(inputs.runWindow ? { runWindow: inputs.runWindow } : {}) });
      }
    })
  ];
}
