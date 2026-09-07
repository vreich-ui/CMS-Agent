// Tracking feedback bridge (T21.7) — the second outer-loop ingestion, alongside monetizerIngest.ts.
// The tenant sites emit engagement telemetry to a tracking sink; nothing ever pulled it back, so the
// only published-content signal reaching the learning substrate was Monetizer's revenue view. This
// module pulls the sink's per-PRODUCER rollups (a producer is the node/run that made the content) and
// records each row as a feedback.record OUTCOME — the same channel human approvals/edits use, so
// optimizer.analyzeNode's `feedback.outcomes` counts them. T21.22 went further and made those records
// READABLE: analyzeNode now aggregates them into an `engagement` block and compares it against the
// site median, through the same client (fetchRollupRows) rather than a second one — see engagement.ts.
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
/** The tenant's partition inside the sink (site genesis sets it to the bare site slug). Named here
 * so every reader — the ingest job, the optimizer's median lookup — spells it the same way. */
export const TRACKING_PROJECT_ID_ENV = "TRACKING_PROJECT_ID";
/** S-07: the CMS-AGENT project id for the SAME tenant (`dr-lurie` where TRACKING_PROJECT_ID is
 * `drlurie`). A second variable rather than a derivation, because the two ids are independent
 * namespaces and no string transform is guaranteed to map one to the other. Unset means ingested
 * rows are stamped with no project, exactly as before this existed. */
export const CMS_AGENT_PROJECT_ID_ENV = "CMS_AGENT_PROJECT_ID";
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
  /**
   * The TRACKING partition to read — the sink's own `TRACKING_PROJECT_ID` (`drlurie`). This id lives
   * in the sink's namespace, NOT CMS-Agent's, and the two are spelled differently for the same
   * tenant. It is a query parameter, never a stamp: see `cmsAgentProjectId`.
   */
  projectId: string;
  from: string;
  to: string;
  /** Restrict the pull to one producer node, and the attribution fallback for rows that omit one. */
  nodeId?: string;
  /**
   * S-07 — the CMS-AGENT project id (`dr-lurie`) to stamp on every recorded FeedbackRecord, so a
   * tenant's project-scoped `feedback.list` can find its own outcome rows.
   *
   * A SEPARATE field from `projectId` on purpose. The two ids name the same tenant in two different
   * namespaces (`drlurie` in the sink, `dr-lurie` here), and a scoped bearer's `policy.projects`
   * holds only the CMS-Agent spelling — so stamping `projectId` would write a value that matches no
   * filter and silently hides every ingested row from the tenant that produced it. Reusing one field
   * for both would make that mistake invisible; two named fields make it a typed one.
   *
   * Omitted means "stamp nothing", which is exactly the pre-S-07 behaviour: the rows still record,
   * and a project-filtered read resolves them through their `runId` instead.
   */
  cmsAgentProjectId?: string;
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

/** Project one rollup row onto a FIXED metric vector, in the sink's snake_case spelling, accepting the
 * row's own fields in either casing or a nested `metrics` envelope. Missing or non-finite values are
 * dropped rather than zero-filled — a metric the sink did not report is not a measured zero.
 *
 * The key list is a parameter so a second GRAIN can project its own vector (T21.35's `by=strategy`
 * rows carry `buy_click_rate`, which engagement.v1 does not) without a second, subtly different
 * reader: casing, nesting and the never-zero-fill rule stay defined in exactly one place. */
export function metricsFromRow(row: unknown, keys: readonly string[]): Record<string, number> {
  const source = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const nested = (typeof source.metrics === "object" && source.metrics ? source.metrics : {}) as Record<string, unknown>;
  const metrics: Record<string, number> = {};
  for (const key of keys) {
    const camel = key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
    const raw = source[key] ?? source[camel] ?? nested[key] ?? nested[camel];
    const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
    if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
  }
  return metrics;
}

/** Project one rollup row onto the fixed engagement.v1 metric vector. */
export const trackingMetricsFromRow = (row: unknown): Record<string, number> => metricsFromRow(row, TRACKING_METRIC_KEYS);

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
 * How the sink groups a rollups page. `producer` is the ingestion bridge's view (one row per node/run
 * that MADE something); `object` is the site's own view (one row per published object), which is what
 * a site-wide median is computed from; `strategy` (T21.35, kugel-data migration 008) is the
 * CROSS-ARTICLE view — one row per strategy/intent/day — which is what a lesson that outlives a
 * single piece can be learned from. All three are the same endpoint, the same auth, the same pinned
 * contract — only `by` differs, which is why there is exactly ONE client for them.
 *
 * `strategy` answers 503 on any deployment whose sink has not run migration 008 yet. That is a grain
 * that does not exist here YET, not a failure: every caller treats it exactly like an unreachable
 * sink (see `RollupFetchResult.status`, which is what lets a caller tell the two apart).
 */
export type RollupGrouping = "producer" | "object" | "strategy";

export type RollupFetchParams = { by: RollupGrouping; projectId: string; from: string; to: string };
export type RollupFetchDeps = { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number };
export type RollupFetchResult =
  | { ok: true; rows: Array<Record<string, unknown>> }
  // `status` is the sink's HTTP status when there WAS one (absent for an unconfigured connection or a
  // transport failure). It carries no sink text — only the number — and exists so a caller can tell
  // "this grain is not deployed here yet" (503) from "the sink is broken", without string-matching a
  // message that is deliberately free of detail.
  | { ok: false; error: string; status?: number };

/**
 * The single HTTP client for the sink's `/rollups` endpoint: connection check, the pinned query
 * contract (ROLLUPS_QUERY_PARAM_NAMES + toSinkDay), the bearer, the timeout, and the envelope
 * unwrapping. Every caller in this repo goes through here, so the contract cannot drift per caller.
 *
 * NEVER throws. An unconfigured connection, a transport failure, a non-200 and an unparseable body
 * all come back as `{ ok: false, error }` with the error already collapsed to a name (a sink URL can
 * embed credentials, so no raw transport message or sink error body is ever surfaced).
 */
export async function fetchRollupRows(params: RollupFetchParams, deps: RollupFetchDeps = {}): Promise<RollupFetchResult> {
  const env = deps.env ?? process.env;
  const connection = trackingSinkConnectionState(env);
  if (!connection.urlConfigured || !connection.tokenConfigured) {
    const missing = [!connection.urlConfigured ? connection.urlEnvVar : undefined, !connection.tokenConfigured ? connection.tokenEnvVar : undefined].filter(Boolean);
    return { ok: false, error: `tracking_sink_not_configured: ${missing.join(", ")} unset on this deployment.` };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const url = new URL(`${env[TRACKING_SINK_URL_ENV]!.trim().replace(/\/+$/, "")}/rollups`);
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.by, params.by);
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.projectId, params.projectId);
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.from, toSinkDay(params.from));
    url.searchParams.set(ROLLUPS_QUERY_PARAM_NAMES.to, toSinkDay(params.to));
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${env[TRACKING_SINK_TOKEN_ENV]!.trim()}`, Accept: "application/json" },
      signal: controller.signal
    });
    // Status only — a sink error BODY is not echoed anywhere, for the same reason the URL is not.
    if (!response.ok) return { ok: false, error: `tracking_sink_http_${response.status}: the tracking sink rejected the rollups request.`, status: response.status };
    return { ok: true, rows: rowsFromSinkBody(await response.json()) };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

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
  const result: TrackingIngestResult = { ingested: [], rows: 0, errors: [] };
  const page = await fetchRollupRows({ by: "producer", projectId: params.projectId, from: params.from, to: params.to }, deps);
  if (!page.ok) {
    result.errors.push({ error: page.error });
    return result;
  }
  let rows = page.rows;

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
        // Deliberately NOT params.projectId — that is the sink's partition id. See the field docs.
        ...(params.cmsAgentProjectId ? { projectId: params.cmsAgentProjectId } : {}),
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
