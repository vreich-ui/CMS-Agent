// Pure, deterministic aggregation over raw operational records for the Constellation. This
// module has no repository imports — callers gather inputs and the functions derive presentation
// data. Nothing here invents numbers: usage keeps its estimated/actual split, derived values name
// their basis, and metrics the raw data cannot support are explicit nulls with reasons.

import type { WorkspaceNode, WorkspaceRiskLevel } from "../workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import type { DerivedExecutionEdge, WorkspaceRelationship } from "../workspace/relationshipTypes.js";
import type { ModelUsageRecord } from "./modelUsageTypes.js";
import { modelPricingCatalog } from "./modelUsage.js";
import type { ToolExecutionRecord } from "../tools/toolTypes.js";
import type { AgentMetrics, ConstellationAttentionItem, ConstellationSummary, RelationshipMetrics, UsageBucket, UsageByStatus } from "./constellationTypes.js";

export type ConstellationInputs = {
  nodes: WorkspaceNode[];
  relationships: WorkspaceRelationship[];
  runs: WorkflowExecutionRecord[];
  usageRecords: ModelUsageRecord[];
  toolExecutions: ToolExecutionRecord[];
  // R-10 inputs. Optional so every existing caller and test keeps working: when a field is absent
  // the corresponding check is skipped rather than reporting a false clean. get_attention supplies
  // all three.
  skillPolicies?: NodeSkillPolicySnapshot[];
  projects?: ProjectConnectionSnapshot[];
  toolRiskLevels?: Record<string, WorkspaceRiskLevel>;
};

// Just enough of skill.resolve_for_node to judge conflicts and denied requests, kept structural so
// this module stays free of skill-layer imports.
export type NodeSkillPolicySnapshot = {
  nodeId: string;
  conflicts: { severity: "warning" | "blocker"; source: string; message: string }[];
  requestedTools: string[];
  deniedTools: string[];
  effectiveTools: string[];
};

// Just enough of project.list to judge whether a connection can actually be used.
export type ProjectConnectionSnapshot = {
  projectId: string;
  status: "active" | "disabled";
  connection: { endpointConfigured: boolean; tokenConfigured: boolean; mcpEndpointEnvVar: string; tokenEnvVar?: string };
};

const INDEPENDENT_WORKFLOW_ID = "independent_node";
const PER_EDGE_MISMATCH_REASON = "per-edge schema mismatches are not recorded today; see the agent outputValidationFailures metric";

const emptyBucket = (): UsageBucket => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, costUsdEstimate: 0, recordCount: 0, unknownModelRecordCount: 0 });
const emptyUsage = (): UsageByStatus => ({ estimated: emptyBucket(), actual: emptyBucket() });

const addToBucket = (bucket: UsageBucket, record: ModelUsageRecord) => {
  bucket.inputTokens += record.inputTokens;
  bucket.outputTokens += record.outputTokens;
  bucket.totalTokens += record.totalTokens;
  bucket.reasoningTokens += record.reasoningTokens ?? 0;
  bucket.costUsdEstimate += record.costUsdEstimate;
  bucket.recordCount += 1;
  if (!(record.model in modelPricingCatalog)) bucket.unknownModelRecordCount += 1;
};

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const finishBucket = (bucket: UsageBucket) => ({ ...bucket, costUsdEstimate: round(bucket.costUsdEstimate) });
const finishUsage = (usage: UsageByStatus): UsageByStatus => ({ estimated: finishBucket(usage.estimated), actual: finishBucket(usage.actual) });

export const deriveExecutionEdges = (nodes: WorkspaceNode[]): DerivedExecutionEdge[] =>
  nodes.flatMap((node) => (node.dependsOn ?? []).map((dependency) => ({ kind: "execution" as const, sourceId: dependency, targetId: node.id, derivedFrom: "dependsOn" as const })));

// Cumulative failure entries in run.errors look like "<nodeId>:<code>" and are never cleared by
// workflow retries, so occurrences beyond the first approximate the retry count for a node.
const derivedRetryCount = (nodeId: string, runs: WorkflowExecutionRecord[]) => {
  let count = 0;
  for (const run of runs) {
    const failures = run.errors.filter((entry) => entry.startsWith(`${nodeId}:`)).length;
    if (failures > 1) count += failures - 1;
  }
  return count;
};

export function aggregateAgentMetrics(inputs: ConstellationInputs): AgentMetrics[] {
  return [...inputs.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => {
      const usage = emptyUsage();
      for (const record of inputs.usageRecords) if (record.nodeId === node.id) addToBucket(usage[record.status], record);

      const byStatus: AgentMetrics["executions"]["byStatus"] = {};
      let independent = 0;
      let workflow = 0;
      const durations: number[] = [];
      let approvalsRequested = 0;
      let blockedRuns = 0;
      let outputValidationFailures = 0;
      let sawErrorEntries = false;
      for (const run of inputs.runs) {
        const state = run.nodes.find((candidate) => candidate.nodeId === node.id);
        if (!state) continue;
        byStatus[state.status] = (byStatus[state.status] ?? 0) + 1;
        if (run.workflowId === INDEPENDENT_WORKFLOW_ID) independent += 1; else workflow += 1;
        if (state.durationMs !== undefined) durations.push(state.durationMs);
        approvalsRequested += run.approvalsRequired.filter((approval) => approval.nodeId === node.id).length;
        if (run.status === "blocked" && run.approvalsRequired.some((approval) => approval.nodeId === node.id)) blockedRuns += 1;
        outputValidationFailures += run.errors.filter((entry) => entry === `${node.id}:output_validation_failed`).length;
        if (state.status === "failed" && (state.errors ?? []).some((entry) => entry === "output_validation_failed" || /must be|is required|must equal|must be one of/.test(entry))) {
          // Independent runs persist raw validator strings instead of the coded run.errors entry.
          if (run.workflowId === INDEPENDENT_WORKFLOW_ID) outputValidationFailures += 1;
        }
        if (run.errors.some((entry) => entry.startsWith(`${node.id}:`))) sawErrorEntries = true;
      }
      const total = Object.values(byStatus).reduce((sum, value) => sum + (value ?? 0), 0);
      const completed = byStatus.completed ?? 0;
      const failed = byStatus.failed ?? 0;
      const retryCount = derivedRetryCount(node.id, inputs.runs);

      const toolRecords = inputs.toolExecutions.filter((record) => record.nodeId === node.id && (record.status === "error" || record.status === "timeout" || record.status === "denied"));
      const byCode: Record<string, number> = {};
      for (const record of toolRecords) { const code = record.errorCode ?? record.status; byCode[code] = (byCode[code] ?? 0) + 1; }

      return {
        nodeId: node.id,
        usage: finishUsage(usage),
        executions: { total, byStatus, independent, workflow },
        successRate: completed + failed > 0 ? completed / (completed + failed) : null,
        latency: durations.length ? { count: durations.length, avgMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length), maxMs: Math.max(...durations) } : null,
        retries: sawErrorEntries || retryCount > 0 ? { count: retryCount, basis: "derived_from_cumulative_run_errors", approximate: true } : null,
        humanIntervention: { approvalsRequested, blockedRuns },
        outputValidationFailures: { count: outputValidationFailures, basis: "run_errors_output_validation_failed" },
        toolErrors: { count: toolRecords.length, byCode, scope: "current_process" }
      } satisfies AgentMetrics;
    });
}

const relationshipInteraction = (sourceId: string, targetId: string, runs: WorkflowExecutionRecord[]) => {
  let interactionCount = 0;
  let payloadBytes = 0;
  let targetCompleted = 0;
  const downstreamDurations: number[] = [];
  for (const run of runs) {
    const source = run.nodes.find((candidate) => candidate.nodeId === sourceId);
    const target = run.nodes.find((candidate) => candidate.nodeId === targetId);
    if (!source || !target) continue;
    if (source.status !== "completed" || !target.startedAt) continue;
    interactionCount += 1;
    payloadBytes += JSON.stringify(run.stageOutputs?.[sourceId] ?? "").length;
    if (target.status === "completed") targetCompleted += 1;
    if (target.durationMs !== undefined) downstreamDurations.push(target.durationMs);
  }
  return { interactionCount, payloadBytes, targetCompleted, downstreamDurations };
};

export function aggregateRelationshipMetrics(inputs: ConstellationInputs): RelationshipMetrics[] {
  const derived = deriveExecutionEdges(inputs.nodes).map((edge) => ({ kind: edge.kind, sourceId: edge.sourceId, targetId: edge.targetId, relationshipId: undefined as string | undefined }));
  const stored = [...inputs.relationships]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((relationship) => ({ kind: relationship.kind, sourceId: relationship.sourceId, targetId: relationship.targetId, relationshipId: relationship.id as string | undefined }));
  return [...derived, ...stored].map((edge) => {
    const interaction = relationshipInteraction(edge.sourceId, edge.targetId, inputs.runs);
    return {
      relationshipId: edge.relationshipId,
      kind: edge.kind,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      dataStatus: "derived",
      interactionCount: interaction.interactionCount,
      payloadBytes: { total: interaction.payloadBytes, basis: "json_stringify_stage_output" },
      successRate: interaction.interactionCount > 0 ? interaction.targetCompleted / interaction.interactionCount : null,
      latency: {
        avgDownstreamMs: interaction.downstreamDurations.length ? Math.round(interaction.downstreamDurations.reduce((sum, value) => sum + value, 0) / interaction.downstreamDurations.length) : null,
        basis: "downstream_node_duration_proxy"
      },
      schemaMismatchCount: { value: null, reason: PER_EDGE_MISMATCH_REASON }
    } satisfies RelationshipMetrics;
  });
}

export function buildConstellationSummary(inputs: ConstellationInputs, generatedAt: string): ConstellationSummary {
  const byStatus: Record<string, number> = {};
  const byRisk: Record<string, number> = {};
  for (const node of inputs.nodes) {
    byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
    byRisk[node.riskLevel] = (byRisk[node.riskLevel] ?? 0) + 1;
  }
  const runsByStatus: ConstellationSummary["runs"]["byStatus"] = {};
  for (const run of inputs.runs) runsByStatus[run.status] = (runsByStatus[run.status] ?? 0) + 1;
  const usage = emptyUsage();
  let unattributedRecordCount = 0;
  let unknownModels = new Set<string>();
  for (const record of inputs.usageRecords) {
    addToBucket(usage[record.status], record);
    if (!record.nodeId) unattributedRecordCount += 1;
    if (!(record.model in modelPricingCatalog)) unknownModels.add(record.model);
  }
  const caveats = [
    "Costs are placeholder estimates from a local pricing catalog; not billing-grade.",
    "Tool error counts reflect only the current process; tool executions are not persisted."
  ];
  if (unknownModels.size) caveats.push(`Unknown models priced at fallback rates: ${[...unknownModels].sort().join(", ")}.`);
  return {
    agents: { total: inputs.nodes.length, byStatus, byRisk },
    relationships: {
      stored: inputs.relationships.length,
      derivedExecutionEdges: deriveExecutionEdges(inputs.nodes).length,
      disabled: inputs.relationships.filter((relationship) => !relationship.enabled).length
    },
    runs: { total: inputs.runs.length, byStatus: runsByStatus },
    usage: { ...finishUsage(usage), unattributedRecordCount },
    generatedAt,
    caveats
  };
}

const severityRank: Record<ConstellationAttentionItem["severity"], number> = { action: 0, warning: 1, info: 2 };

export function buildAttentionItems(inputs: ConstellationInputs): ConstellationAttentionItem[] {
  const items: ConstellationAttentionItem[] = [];

  for (const run of [...inputs.runs].sort((a, b) => a.runId.localeCompare(b.runId))) {
    if (run.status === "failed") {
      const nodeIds = [...new Set(run.errors.map((entry) => entry.split(":")[0]).filter((id) => inputs.nodes.some((node) => node.id === id)))];
      items.push({
        id: `attn_run_failed_${run.runId}`,
        severity: "action",
        title: `Run ${run.runId} failed`,
        detail: `Run for project ${run.projectId} failed${nodeIds.length ? ` at ${nodeIds.join(", ")}` : ""}.`,
        reasons: [...new Set(run.errors)].slice(0, 5),
        evidence: { runIds: [run.runId], nodeIds: nodeIds.length ? nodeIds : undefined }
      });
    }
    if (run.status === "blocked" && run.approvalsRequired.length > 0) {
      items.push({
        id: `attn_approval_pending_${run.runId}`,
        severity: "action",
        title: `Run ${run.runId} is waiting for approval`,
        detail: "The run is blocked before publish-risk execution. No publication has been performed.",
        reasons: run.approvalsRequired.map((approval) => `${approval.nodeId}: ${approval.reason}`),
        evidence: { runIds: [run.runId], nodeIds: [...new Set(run.approvalsRequired.map((approval) => approval.nodeId))] }
      });
    }
  }

  const validationByNode = new Map<string, string[]>();
  for (const run of inputs.runs) {
    for (const entry of run.errors) {
      if (!entry.endsWith(":output_validation_failed")) continue;
      const nodeId = entry.slice(0, -":output_validation_failed".length);
      validationByNode.set(nodeId, [...(validationByNode.get(nodeId) ?? []), run.runId]);
    }
  }
  for (const [nodeId, runIds] of [...validationByNode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    items.push({
      id: `attn_output_validation_${nodeId}`,
      severity: "warning",
      title: `${nodeId} produced output that failed schema validation`,
      detail: `Output validation failed in ${runIds.length} run${runIds.length === 1 ? "" : "s"}.`,
      reasons: [`${runIds.length}x output_validation_failed recorded in run errors`],
      evidence: { nodeIds: [nodeId], runIds: [...new Set(runIds)] }
    });
  }

  const unknownModelRecords = inputs.usageRecords.filter((record) => !(record.model in modelPricingCatalog));
  if (unknownModelRecords.length) {
    const models = [...new Set(unknownModelRecords.map((record) => record.model))].sort();
    items.push({
      id: "attn_fallback_pricing",
      severity: "warning",
      title: "Usage recorded for models without catalog pricing",
      detail: "Cost estimates for these records use fallback pricing and understate uncertainty.",
      reasons: models.map((model) => `model ${model} is not in the pricing catalog`),
      evidence: { usageIds: unknownModelRecords.map((record) => record.usageId).sort() }
    });
  }

  const nodeIds = new Set(inputs.nodes.map((node) => node.id));
  for (const relationship of [...inputs.relationships].sort((a, b) => a.id.localeCompare(b.id))) {
    const missing = [relationship.sourceId, relationship.targetId].filter((endpoint) => !nodeIds.has(endpoint));
    if (missing.length) {
      items.push({
        id: `attn_relationship_missing_endpoint_${relationship.id}`,
        severity: "warning",
        title: `Relationship ${relationship.id} references a missing agent`,
        detail: `The ${relationship.kind} relationship points at ${missing.join(", ")}, which no longer exists.`,
        reasons: missing.map((endpoint) => `endpoint ${endpoint} is not a workspace node`),
        evidence: { relationshipIds: [relationship.id], nodeIds: [relationship.sourceId, relationship.targetId].filter((endpoint) => nodeIds.has(endpoint)) }
      });
    } else if (!relationship.enabled) {
      items.push({
        id: `attn_relationship_disabled_${relationship.id}`,
        severity: "info",
        title: `Relationship ${relationship.id} is disabled`,
        detail: `The ${relationship.kind} relationship ${relationship.sourceId} → ${relationship.targetId} is currently disabled.`,
        reasons: ["relationship enabled flag is false"],
        evidence: { relationshipIds: [relationship.id], nodeIds: [relationship.sourceId, relationship.targetId] }
      });
    }
  }

  const toolErrorsByNode = new Map<string, ToolExecutionRecord[]>();
  for (const record of inputs.toolExecutions) {
    if (record.status !== "error" && record.status !== "timeout" && record.status !== "denied") continue;
    toolErrorsByNode.set(record.nodeId, [...(toolErrorsByNode.get(record.nodeId) ?? []), record]);
  }
  for (const [nodeId, records] of [...toolErrorsByNode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    items.push({
      id: `attn_tool_errors_${nodeId}`,
      severity: "info",
      title: `${nodeId} had ${records.length} failing tool call${records.length === 1 ? "" : "s"}`,
      detail: "Counts cover the current process only; tool executions are not persisted.",
      reasons: [...new Set(records.map((record) => record.errorCode ?? record.status))].sort().map((code) => `tool call ended with ${code}`),
      evidence: { nodeIds: [nodeId], toolExecutionIds: records.map((record) => record.toolExecutionId).sort() }
    });
  }

  items.push(...configurationAttentionItems(inputs));

  return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.id.localeCompare(b.id));
}

// R-10 — configuration and connection defects.
//
// get_attention used to return [] against a workspace with 18 real defects in it, which meant every
// finding in this session had to be dug out by hand and none of it was visible in the product. These
// checks report the classes the audit actually found, each citing the evidence that proves it rather
// than a score.
const riskRank: Record<WorkspaceRiskLevel, number> = { read: 1, write: 2, publish: 3, admin: 4 };

const sameSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
};

export function configurationAttentionItems(inputs: ConstellationInputs): ConstellationAttentionItem[] {
  const items: ConstellationAttentionItem[] = [];
  const nodes = [...inputs.nodes].sort((a, b) => a.id.localeCompare(b.id));

  for (const node of nodes) {
    // dependsOn vs requiredInputs. Entry nodes (no dependencies) legitimately declare an external
    // envelope as their required input, so comparing them would report a permanent false positive.
    const dependsOn = node.dependsOn ?? [];
    const requiredInputs = node.requiredInputs ?? [];
    if (dependsOn.length > 0 && !sameSet(dependsOn, requiredInputs)) {
      items.push({
        id: `attn_dependency_mismatch_${node.id}`,
        severity: "warning",
        title: `${node.id} disagrees with itself about its inputs`,
        detail: "dependsOn drives execution order; requiredInputs is what the node claims it needs. When they differ, one of them is wrong.",
        reasons: [`dependsOn = [${[...dependsOn].sort().join(", ")}]`, `requiredInputs = [${[...requiredInputs].sort().join(", ")}]`],
        evidence: { nodeIds: [node.id] }
      });
    }

    // A tool the node grants itself that its own riskLevel can never authorize. Harmless to
    // execution, but it advertises a capability that cannot exist and puts a permanent false denial
    // into every effective-tools report — which is exactly the noise a real defect hid behind.
    if (inputs.toolRiskLevels) {
      const nodeRank = riskRank[node.riskLevel ?? "read"];
      const ungrantable = (node.allowedTools ?? [])
        .filter((toolId) => {
          const toolRisk = inputs.toolRiskLevels?.[toolId];
          return toolRisk !== undefined && riskRank[toolRisk] > nodeRank;
        })
        .sort();
      if (ungrantable.length) {
        items.push({
          id: `attn_ungrantable_tools_${node.id}`,
          severity: "warning",
          title: `${node.id} grants itself ${ungrantable.length} tool${ungrantable.length === 1 ? "" : "s"} its risk level forbids`,
          detail: `The node is riskLevel "${node.riskLevel ?? "read"}", so the policy resolver can never grant these. Either raise the node's risk level or drop the grant.`,
          reasons: ungrantable.map((toolId) => `${toolId} is riskLevel ${inputs.toolRiskLevels?.[toolId]}, above the node's ${node.riskLevel ?? "read"}`),
          evidence: { nodeIds: [node.id] }
        });
      }
    }
  }

  // Skill conflicts. A blocker is action-severity: it is not advisory, it means the resolved policy
  // is incoherent.
  for (const policy of [...(inputs.skillPolicies ?? [])].sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
    const blockers = policy.conflicts.filter((conflict) => conflict.severity === "blocker");
    if (blockers.length) {
      items.push({
        id: `attn_skill_blocker_${policy.nodeId}`,
        severity: "action",
        title: `${policy.nodeId} has a blocker-severity skill conflict`,
        detail: "A blocker conflict means the node's resolved skill policy is incoherent, not merely suboptimal.",
        reasons: blockers.map((conflict) => `${conflict.source}: ${conflict.message}`),
        evidence: { nodeIds: [policy.nodeId] }
      });
    }

    // A skill that asks for a tool the node denies: the skill's instructions assume a capability the
    // node cannot exercise, so the node will fail at exactly the step the skill was added for.
    const node = inputs.nodes.find((candidate) => candidate.id === policy.nodeId);
    const deniedButRequested = policy.requestedTools
      .filter((toolId) => policy.deniedTools.includes(toolId) || !(node?.allowedTools ?? []).includes(toolId))
      .sort();
    if (deniedButRequested.length) {
      items.push({
        id: `attn_skill_requests_denied_tool_${policy.nodeId}`,
        severity: "warning",
        title: `${policy.nodeId} has a skill requesting ${deniedButRequested.length} tool${deniedButRequested.length === 1 ? "" : "s"} the node denies`,
        detail: "The skill's instructions assume a capability the node cannot exercise.",
        reasons: deniedButRequested.map((toolId) => `skill requests ${toolId}; the node does not grant it`),
        evidence: { nodeIds: [policy.nodeId] }
      });
    }
  }

  // Unconfigured client connections. An active project whose endpoint or token is missing fails
  // closed at call time — correct behaviour, but silent until something tries to publish.
  for (const project of [...(inputs.projects ?? [])].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
    if (project.status !== "active") continue;
    const missing = [
      ...(project.connection.endpointConfigured ? [] : [project.connection.mcpEndpointEnvVar]),
      ...(project.connection.tokenEnvVar && !project.connection.tokenConfigured ? [project.connection.tokenEnvVar] : [])
    ];
    if (!missing.length) continue;
    items.push({
      id: `attn_project_unconfigured_${project.projectId}`,
      severity: "action",
      title: `Client ${project.projectId} is active but not configured`,
      detail: "Calls to this client fail closed until the deployment provides these environment variables. Nothing downstream of it can run.",
      reasons: missing.map((envVar) => `${envVar} is not configured on this deployment`),
      evidence: {}
    });
  }

  return items;
}
