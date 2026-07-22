// Published-analytics ingestion (docs/platform/DIRECTION.md Phase 7): close the OUTER loop by pulling
// the Monetizer project's read-only `performance` / `demand_signals` telemetry back into the learning
// substrate as feedback.record OUTCOME records — the same channel human approvals/edits use, so the
// optimizer's analyzeNode already factors it in. Pull-based (a scheduled job or a human/agent MCP call
// is the trigger; it never fires from a run), best-effort per signal, and read-only: it only calls
// tools already on Monetizer's safe allow-list and only WRITES feedback outcomes locally. The Monetizer
// connection is reached through the standard ProjectMcpAdapter (endpoint/token from env NAMES, never
// persisted); callTool is injectable so tests never touch a live endpoint.
import { monetizerProjectConfig } from "../projects/monetizer/definition.js";
import { ProjectMcpAdapter, type CallToolResult } from "../projects/projectMcpAdapter.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import type { WorkspaceActor } from "../workspace/changeTypes.js";
import { makeImprovementId, type FeedbackRecord } from "./improvementTypes.js";

const now = () => new Date().toISOString();
const MAX_METRICS = 100;
const MAX_DEPTH = 6;

export type MonetizerSignal = "performance" | "demand_signals";
export const MONETIZER_SIGNALS: MonetizerSignal[] = ["performance", "demand_signals"];
export type CallToolFn = (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;

// Flatten an analytics payload to numeric leaf metrics keyed by dot/bracket path, bounded in depth and
// count so a large or adversarial payload can't blow up the feedback record. Pure — unit-tested.
export function flattenNumericMetrics(value: unknown, prefix = "", out: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (Object.keys(out).length >= MAX_METRICS || depth > MAX_DEPTH) return out;
  if (typeof value === "number" && Number.isFinite(value)) { out[prefix || "value"] = value; return out; }
  if (typeof value === "boolean") { out[prefix || "value"] = value ? 1 : 0; return out; }
  if (Array.isArray(value)) { for (let index = 0; index < value.length; index++) flattenNumericMetrics(value[index], `${prefix}[${index}]`, out, depth + 1); return out; }
  if (value && typeof value === "object") { for (const [key, nested] of Object.entries(value as Record<string, unknown>)) flattenNumericMetrics(nested, prefix ? `${prefix}.${key}` : key, out, depth + 1); return out; }
  return out;
}

// Resolve the metric payload from an MCP CallToolResult: prefer structuredContent, else JSON-parse the
// first text content block, else fall back to the raw result object.
export function metricsFromCallResult(result: unknown): Record<string, number> {
  const raw = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } | undefined;
  let payload: unknown = raw;
  if (raw?.structuredContent !== undefined) payload = raw.structuredContent;
  else {
    const text = raw?.content?.find?.((block) => block?.type === "text")?.text;
    if (typeof text === "string") { try { payload = JSON.parse(text); } catch { payload = raw; } }
  }
  return flattenNumericMetrics(payload);
}

export type MonetizerIngestResult = {
  ingested: Array<{ signal: MonetizerSignal; feedbackId: string; metricCount: number }>;
  errors: Array<{ signal: MonetizerSignal; error: string }>;
};

export type MonetizerIngestDeps = { evaluationRepository: EvaluationRepository; callTool?: CallToolFn; env?: NodeJS.ProcessEnv };

// Pull the requested Monetizer signals and record each as a feedback OUTCOME. Never throws: a signal
// that errors (connection not configured, remote failure) is captured per-signal and the rest proceed.
export async function ingestMonetizerAnalytics(params: { nodeId?: string; runId?: string; signals?: MonetizerSignal[]; args?: Record<string, unknown>; actor?: string | WorkspaceActor; note?: string }, deps: MonetizerIngestDeps): Promise<MonetizerIngestResult> {
  const callTool = deps.callTool ?? ((tool: string, args: Record<string, unknown>) => new ProjectMcpAdapter(monetizerProjectConfig, { env: deps.env }).callTool(tool, args));
  const signals = params.signals?.length ? params.signals : MONETIZER_SIGNALS;
  const result: MonetizerIngestResult = { ingested: [], errors: [] };
  for (const signal of signals) {
    try {
      const response = await callTool(signal, params.args ?? {});
      if (!response.ok) { result.errors.push({ signal, error: response.error ?? "monetizer_call_failed" }); continue; }
      const metrics = metricsFromCallResult(response.result);
      const record: FeedbackRecord = { feedbackId: makeImprovementId("fb"), kind: "outcome", nodeId: params.nodeId, runId: params.runId, outcome: { source: `monetizer:${signal}`, metrics }, actor: params.actor, note: params.note, createdAt: now() };
      const saved = await deps.evaluationRepository.recordFeedback(record);
      result.ingested.push({ signal, feedbackId: saved.feedbackId, metricCount: Object.keys(metrics).length });
    } catch (error) {
      result.errors.push({ signal, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
