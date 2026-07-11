// Aggregated presentation types for the Constellation. These are derived views over raw records
// (runs, usage, tool executions) — raw records stay on their existing tools and are never
// returned by constellation.* tools. Estimated and actual usage are never merged, every derived
// number names its basis, and unavailable metrics are explicit nulls with reasons.

import type { ExecutionStatus } from "../workspace/executionTypes.js";
import type { RelationshipKind } from "../workspace/relationshipTypes.js";

export type UsageBucket = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  costUsdEstimate: number;
  recordCount: number;
  // Records whose model is missing from the pricing catalog and silently priced at fallback
  // rates — surfaced so cost numbers are never mistaken for billing-grade values.
  unknownModelRecordCount: number;
};

export type UsageByStatus = { estimated: UsageBucket; actual: UsageBucket };

export type AgentMetrics = {
  nodeId: string;
  usage: UsageByStatus;
  executions: { total: number; byStatus: Partial<Record<ExecutionStatus, number>>; independent: number; workflow: number };
  successRate: number | null;
  latency: { count: number; avgMs: number; maxMs: number } | null;
  retries: { count: number; basis: "derived_from_cumulative_run_errors"; approximate: true } | null;
  humanIntervention: { approvalsRequested: number; blockedRuns: number };
  outputValidationFailures: { count: number; basis: "run_errors_output_validation_failed" };
  toolErrors: { count: number; byCode: Record<string, number>; scope: "current_process" };
};

export type RelationshipMetrics = {
  relationshipId?: string;
  kind: RelationshipKind;
  sourceId: string;
  targetId: string;
  dataStatus: "derived";
  interactionCount: number;
  payloadBytes: { total: number; basis: "json_stringify_stage_output" };
  successRate: number | null;
  latency: { avgDownstreamMs: number | null; basis: "downstream_node_duration_proxy" };
  schemaMismatchCount: { value: null; reason: string };
};

export type ConstellationSummary = {
  agents: { total: number; byStatus: Record<string, number>; byRisk: Record<string, number> };
  relationships: { stored: number; derivedExecutionEdges: number; disabled: number };
  runs: { total: number; byStatus: Partial<Record<ExecutionStatus, number>> };
  usage: UsageByStatus & { unattributedRecordCount: number };
  generatedAt: string;
  caveats: string[];
};

export type ConstellationAttentionSeverity = "action" | "warning" | "info";

export type ConstellationAttentionItem = {
  id: string;
  severity: ConstellationAttentionSeverity;
  title: string;
  detail: string;
  // Explicit evidence-citing reasons; composite/unexplained scores are prohibited by design.
  reasons: string[];
  evidence: { runIds?: string[]; nodeIds?: string[]; relationshipIds?: string[]; usageIds?: string[]; toolExecutionIds?: string[] };
};
