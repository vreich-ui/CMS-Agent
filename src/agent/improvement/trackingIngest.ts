// Tracking feedback bridge (T21.7) — the second outer-loop ingestion, alongside monetizerIngest.ts.
// The tenant sites emit engagement telemetry to a tracking sink; nothing ever pulled it back, so the
// only published-content signal reaching the learning substrate was Monetizer's revenue view. This
// module pulls the sink's per-PRODUCER rollups (a producer is the node/run that made the content) and
// records each row as a feedback.record OUTCOME — the same channel human approvals/edits use, so
// optimizer.analyzeNode's `feedback.outcomes` already counts them with no change there.
//
// Pull-based (a scheduled job or a human/agent MCP call is the trigger; it never fires from a run) and
// read-only against the sink: it issues one GET and only WRITES feedback outcomes locally. The sink is
// reached through env NAMES only (TRACKING_SINK_URL / TRACKING_SINK_TOKEN, the pair site genesis
// already provisions per tenant — see capture/siteGenesis.ts "tracking_sink"); no URL or token literal
// appears in this repo, and neither value is ever logged or returned. fetchImpl is injectable so tests
// never touch a live sink.
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import type { WorkspaceActor } from "../workspace/changeTypes.js";
import { makeImprovementId, type FeedbackRecord } from "./improvementTypes.js";

const now = () => new Date().toISOString();
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ROWS = 500;

export const TRACKING_SINK_URL_ENV = "TRACKING_SINK_URL";
export const TRACKING_SINK_TOKEN_ENV = "TRACKING_SINK_TOKEN";
/** Outcome `source` stamped on every record this bridge writes; the contract optimizer/dataset code reads. */
export const TRACKING_OUTCOME_SOURCE = "tracking:engagement.v1";

// The engagement.v1 metric set, in wire (snake_case) spelling. Anything else on a row is ignored —
// the record is a fixed, comparable metric vector, not a dump of whatever the sink happens to emit.
export const TRACKING_METRIC_KEYS = [
  "pageviews",
  "exposures",
  "sessions",
  "completion_rate",
  "cta_ctr",
  "purchase_rate",
  "revenue_cents",
  "p75_dwell_ms"
] as const;
export type TrackingMetricKey = typeof TRACKING_METRIC_KEYS[number];

export type TrackingSinkConnectionState = {
  urlConfigured: boolean;
  tokenConfigured: boolean;
  urlEnvVar: string;
  tokenEnvVar: string;
};

/** Env-name-only view of the sink connection, mirroring projectMcpAdapter.toConnectionState. Never
 * returns a value — only whether each named variable is populated. */
export const trackingSinkConnectionState = (env: NodeJS.ProcessEnv = process.env): TrackingSinkConnectionState => ({
  urlConfigured: Boolean(env[TRACKING_SINK_URL_ENV]?.trim()),
  tokenConfigured: Boolean(env[TRACKING_SINK_TOKEN_ENV]?.trim()),
  urlEnvVar: TRACKING_SINK_URL_ENV,
  tokenEnvVar: TRACKING_SINK_TOKEN_ENV
});

export type TrackingIngestParams = {
  projectId: string;
  from: string;
  to: string;
  /** Restrict the pull to one producer node, and the attribution fallback for rows that omit one. */
  nodeId?: string;
  actor?: string | WorkspaceActor;
};

export type TrackingIngestDeps = {
  evaluationRepository: EvaluationRepository;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type TrackingIngestResult = {
  /** One entry per row that became a feedback OUTCOME, keyed by the row's nodeId/runId. */
  ingested: Array<{ nodeId?: string; runId?: string; feedbackId: string; metricCount: number }>;
  /** Rows the sink returned (before per-row failures), so "0 ingested" can be told apart from "0 rows". */
  rows: number;
  /** `producer` is the offending row's key, or omitted for a request-level failure. */
  errors: Array<{ producer?: string; error: string }>;
};

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

// Sinks vary on casing and nesting; accept the row's own fields or a nested `producer` object, in
// either spelling. Pure — unit-tested.
const producerField = (row: Record<string, unknown>, snake: string, camel: string): string | undefined => {
  const nested = (typeof row.producer === "object" && row.producer ? row.producer : {}) as Record<string, unknown>;
  return asString(row[snake]) ?? asString(row[camel]) ?? asString(nested[snake]) ?? asString(nested[camel]);
};

// ── the sink's query contract ────────────────────────────────────────────────
// Pinned here, and asserted by tests/agent/trackingIngest.test.ts, because the two repos drifted once
// already: this bridge sent `project=` while the sink (kugel-data
// netlify/functions/_shared/rollups.ts → parseRollupParams) requires `project_id=` and answers 400
// `project_id is required` to anything else. The sink has NO producer filter — v_producer_window rows
// come back whole — so `nodeId` is honoured client-side, not as a query param.
export const ROLLUPS_QUERY_PARAM_NAMES = Object.freeze({
  by: "by",
  projectId: "project_id",
  from: "from",
  to: "to"
} as const);

/**
 * The sink accepts strict YYYY-MM-DD calendar days (rollups.ts → parseDay) and 400s on anything else,
 * an ISO date-time included. Callers pass whatever window they hold, so the day is taken off the front
 * here rather than trusted.
 */
export const toSinkDay = (value: string): string => String(value ?? "").trim().slice(0, 10);

/** Stable key for one rollup row: the producer identity the sink grouped by. */
export const producerKeyOf = (nodeId: string | undefined, runId: string | undefined): string => `${nodeId ?? "unknown"}:${runId ?? "unknown"}`;

/** Project one rollup row onto the fixed engagement.v1 metric vector. Missing or non-finite values are
 * dropped rather than zero-filled — a metric the sink did not report is not a measured zero. */
export function trackingMetricsFromRow(row: unknown): Record<string, number> {
  const source = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const nested = (typeof source.metrics === "object" && source.metrics ? source.metrics : {}) as Record<string, unknown>;
  const metrics: Record<string, number> = {};
  for (const key of TRACKING_METRIC_KEYS) {
    const camel = key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
    const raw = source[key] ?? source[camel] ?? nested[key] ?? nested[camel];
    const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
    if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
  }
  return metrics;
}

/** Rollup rows out of whatever envelope the sink used: a bare array, or {rows|rollups|data|results:[…]}. */
export function rowsFromSinkBody(body: unknown): Array<Record<string, unknown>> {
  const envelope = body as Record<string, unknown> | undefined;
  const candidate = Array.isArray(body)
    ? body
    : [envelope?.rows, envelope?.rollups, envelope?.data, envelope?.results].find((value) => Array.isArray(value));
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)).slice(0, MAX_ROWS);
}

// Errors are collapsed to their NAME plus a fixed sentence (the fail-by-name standard used by
// projectMcpAdapter.sanitizeError): a sink URL can embed credentials, so a raw transport message must
// never reach a result, a log, or a stored record.
const sanitizeError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : typeof error;
  return `tracking_sink_unreachable (${name}): failed to read rollups from the tracking sink. ${TRACKING_SINK_URL_ENV}/${TRACKING_SINK_TOKEN_ENV} may be unset on this deployment, the sink may be down, or the network path blocked.`;
};

/**
 * GET `${TRACKING_SINK_URL}/rollups?by=producer` for the project/window and record each returned row as
 * one feedback OUTCOME (source `tracking:engagement.v1`, note `window <from>..<to>`).
 *
 * NEVER throws. An unconfigured connection, a transport failure, a non-200, a malformed body, or a row
 * that cannot be recorded all come back as an entry in `errors` with an empty (or partial) `ingested` —
 * exactly the best-effort posture ingestMonetizerAnalytics has, so a scheduled caller cannot be taken
 * down by the far side.
 */
export async function ingestTrackingRollups(params: TrackingIngestParams, deps: TrackingIngestDeps): Promise<TrackingIngestResult> {
  const env = deps.env ?? process.env;
  const result: TrackingIngestResult = { ingested: [], rows: 0, errors: [] };
  const connection = trackingSinkConnectionState(env);
  if (!connection.urlConfigured || !connection.tokenConfigured) {
    const missing = [!connection.urlConfigured ? connection.urlEnvVar : undefined, !connection.tokenConfigured ? connection.tokenEnvVar : undefined].filter(Boolean);
    result.errors.push({ error: `tracking_sink_not_configured: ${missing.join(", ")} unset on this deployment.` });
    return result;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let rows: Array<Record<string, unknown>>;
  try {
    const url = new URL(`${env[TRACKING_SINK_URL_ENV]!.trim().replace(/\/+$/, "")}/rollups`);
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.by, "producer");
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.projectId, params.projectId);
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.from, toSinkDay(params.from));
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.to, toSinkDay(params.to));
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${env[TRACKING_SINK_TOKEN_ENV]!.trim()}`, Accept: "application/json" },
      signal: controller.signal
    });
    // Status only — a sink error BODY is not echoed anywhere, for the same reason the URL is not.
    if (!response.ok) {
      result.errors.push({ error: `tracking_sink_http_${response.status}: the tracking sink rejected the rollups request.` });
      return result;
    }
    rows = rowsFromSinkBody(await response.json());
  } catch (error) {
    result.errors.push({ error: sanitizeError(error) });
    return result;
  } finally {
    clearTimeout(timer);
  }

  // The sink cannot narrow to one producer, so a caller that named a node gets the narrowing here.
  // A row that names no node still passes: params.nodeId is its attribution fallback below.
  if (params.nodeId) {
    const wanted = params.nodeId;
    rows = rows.filter((row) => {
      const rowNodeId = producerField(row, "node_id", "nodeId");
      return rowNodeId === undefined || rowNodeId === wanted;
    });
  }

  result.rows = rows.length;
  for (const row of rows) {
    const nodeId = producerField(row, "node_id", "nodeId") ?? params.nodeId;
    const runId = producerField(row, "run_id", "runId");
    try {
      const metrics = trackingMetricsFromRow(row);
      const record: FeedbackRecord = {
        feedbackId: makeImprovementId("fb"),
        kind: "outcome",
        nodeId,
        runId,
        outcome: { source: TRACKING_OUTCOME_SOURCE, metrics },
        actor: params.actor,
        note: `window ${params.from}..${params.to}`,
        createdAt: now()
      };
      const saved = await deps.evaluationRepository.recordFeedback(record);
      result.ingested.push({ nodeId, runId, feedbackId: saved.feedbackId, metricCount: Object.keys(metrics).length });
    } catch (error) {
      result.errors.push({ producer: producerKeyOf(nodeId, runId), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
