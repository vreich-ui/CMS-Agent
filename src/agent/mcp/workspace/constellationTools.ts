import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import type { UsageRepository } from "../../repository/interfaces/UsageRepository.js";
import { listToolExecutions } from "../../tools/toolExecutor.js";
import { aggregateAgentMetrics, aggregateRelationshipMetrics, buildAttentionItems, buildConstellationSummary, deriveExecutionEdges, type ConstellationInputs } from "../../observability/constellationMetrics.js";

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
};

type Filters = { projectId?: string; runId?: string; from?: string; to?: string };

export function createConstellationTools({ workspaceRepository, executionRepository, usageRepository }: ConstellationToolDeps): WorkspaceTool[] {
  // Raw records are gathered here and only aggregates leave the tools; the raw runs/usage/tool
  // records remain available through their existing dedicated tools.
  const gatherInputs = async (filters: Filters = {}): Promise<ConstellationInputs> => {
    const [nodes, relationships, allRuns, usageRecords] = await Promise.all([
      workspaceRepository.getNodes(),
      workspaceRepository.listRelationships(),
      executionRepository.listRuns(filters.projectId ? { projectId: filters.projectId } : {}),
      usageRepository.list({ projectId: filters.projectId, runId: filters.runId, from: filters.from, to: filters.to })
    ]);
    const runs = allRuns.filter((run) =>
      (!filters.runId || run.runId === filters.runId) &&
      (!filters.from || run.startedAt >= filters.from) &&
      (!filters.to || run.startedAt <= filters.to)
    );
    return { nodes, relationships, runs, usageRecords, toolExecutions: listToolExecutions() };
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
      description: "Aggregated per-agent operational metrics (usage split by estimated/actual, executions, latency, derived retries, human intervention, output validation failures, current-process tool errors). Read-only; never billing-grade.",
      zodSchema: metricsInput,
      inputSchema: metricsJsonSchema,
      execute: async (input) => {
        const filters = metricsInput.parse(input);
        const inputs = await gatherInputs(filters);
        const summary = buildConstellationSummary(inputs, new Date().toISOString());
        return ok({ agents: aggregateAgentMetrics(inputs), generatedAt: summary.generatedAt, caveats: summary.caveats });
      }
    }),
    tool({
      name: "constellation.get_relationship",
      description: "One relationship (stored, or a derived execution edge addressed by source/target) with its derived interaction metrics. Read-only.",
      zodSchema: relationshipInput,
      inputSchema: relationshipJsonSchema,
      execute: async (input) => {
        const data = relationshipInput.parse(input);
        const inputs = await gatherInputs();
        const metrics = aggregateRelationshipMetrics(inputs);
        if (data.relationshipId) {
          const relationship = inputs.relationships.find((candidate) => candidate.id === data.relationshipId) ?? null;
          return ok({ relationship, metrics: metrics.find((candidate) => candidate.relationshipId === data.relationshipId) ?? null });
        }
        const stored = inputs.relationships.find((candidate) => candidate.sourceId === data.sourceId && candidate.targetId === data.targetId);
        if (stored) return ok({ relationship: stored, metrics: metrics.find((candidate) => candidate.relationshipId === stored.id) ?? null });
        const derived = deriveExecutionEdges(inputs.nodes).find((edge) => edge.sourceId === data.sourceId && edge.targetId === data.targetId) ?? null;
        return ok({ relationship: derived, metrics: derived ? metrics.find((candidate) => candidate.relationshipId === undefined && candidate.sourceId === data.sourceId && candidate.targetId === data.targetId) ?? null : null });
      }
    }),
    tool({
      name: "constellation.get_summary",
      description: "System summary for the constellation: agent/relationship/run counts and usage totals split by estimated/actual, with explicit caveats. Read-only.",
      zodSchema: summaryInput,
      inputSchema: summaryJsonSchema,
      execute: async (input) => {
        const filters = summaryInput.parse(input);
        return ok({ summary: buildConstellationSummary(await gatherInputs(filters), new Date().toISOString()) });
      }
    }),
    tool({
      name: "constellation.get_attention",
      description: "Attention items with explicit evidence-citing reasons (failed runs, pending approvals, validation failures, pricing caveats, relationship issues). No composite scores. Read-only.",
      zodSchema: attentionInput,
      inputSchema: attentionJsonSchema,
      execute: async (input) => {
        const filters = attentionInput.parse(input);
        return ok({ items: buildAttentionItems(await gatherInputs(filters)) });
      }
    })
  ];
}
