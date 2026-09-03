import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ingestTrackingRollups,
  producerKeyOf,
  rowsFromSinkBody,
  trackingMetricsFromRow,
  trackingSinkConnectionState,
  TRACKING_METRIC_KEYS,
  TRACKING_OUTCOME_SOURCE,
  TRACKING_SINK_TOKEN_ENV,
  TRACKING_SINK_URL_ENV
} from "../../src/agent/improvement/trackingIngest.js";
import { analyzeNode } from "../../src/agent/improvement/optimizer.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

// T21.7 tracking feedback bridge: the sink's per-producer engagement rollups are pulled and recorded as
// feedback OUTCOME records, the second outer loop alongside monetizerIngest. These tests pin the pure
// row projection and the ingestion (row attribution, failure isolation) against an injected fetch — no
// live tracking sink is touched, and only env var NAMES ever appear here.

const CONFIGURED_ENV = { [TRACKING_SINK_URL_ENV]: "https://sink.example/track", [TRACKING_SINK_TOKEN_ENV]: "test-token" } as unknown as NodeJS.ProcessEnv;
const UNCONFIGURED_ENV = {} as unknown as NodeJS.ProcessEnv;

type FetchCall = { url: URL; init: RequestInit | undefined };

const jsonFetch = (body: unknown, status = 200, calls: FetchCall[] = []): typeof fetch =>
  (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

const throwingFetch = (error: Error): typeof fetch => (async () => { throw error; }) as unknown as typeof fetch;

const row = (nodeId: string, runId: string, overrides: Record<string, unknown> = {}) => ({
  node_id: nodeId,
  run_id: runId,
  pageviews: 4100,
  exposures: 1200,
  sessions: 340,
  completion_rate: 0.42,
  cta_ctr: 0.08,
  purchase_rate: 0.011,
  revenue_cents: 45900,
  p75_dwell_ms: 38000,
  ...overrides
});

const deps = (fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = CONFIGURED_ENV) => ({
  evaluationRepository: repositoryManager.getEvaluationRepository(),
  fetchImpl,
  env
});

describe("trackingMetricsFromRow", () => {
  it("projects a row onto the fixed engagement.v1 metric vector", () => {
    expect(trackingMetricsFromRow(row("draft_writer", "run_1"))).toEqual({
      pageviews: 4100, exposures: 1200, sessions: 340, completion_rate: 0.42, cta_ctr: 0.08, purchase_rate: 0.011, revenue_cents: 45900, p75_dwell_ms: 38000
    });
    expect(Object.keys(trackingMetricsFromRow(row("n", "r")))).toEqual([...TRACKING_METRIC_KEYS]);
  });
  it("accepts camelCase and a nested metrics envelope", () => {
    expect(trackingMetricsFromRow({ metrics: { completionRate: 0.5, revenue_cents: 10 } })).toEqual({ completion_rate: 0.5, revenue_cents: 10 });
  });
  it("drops missing, non-numeric and non-finite values instead of zero-filling", () => {
    expect(trackingMetricsFromRow({ exposures: 5, sessions: "n/a", cta_ctr: null, purchase_rate: NaN, revenue_cents: Infinity })).toEqual({ exposures: 5 });
    expect(trackingMetricsFromRow(undefined)).toEqual({});
  });
  it("ignores columns outside the metric set", () => {
    expect(trackingMetricsFromRow({ exposures: 2, secret_column: 99 })).toEqual({ exposures: 2 });
  });
});

describe("rowsFromSinkBody", () => {
  it("reads a bare array or a rows/rollups/data/results envelope", () => {
    expect(rowsFromSinkBody([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsFromSinkBody({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(rowsFromSinkBody({ rollups: [{ a: 2 }] })).toEqual([{ a: 2 }]);
    expect(rowsFromSinkBody({ results: [{ a: 3 }] })).toEqual([{ a: 3 }]);
  });
  it("returns nothing for a malformed body rather than throwing", () => {
    for (const body of [undefined, null, "text", 7, {}, { rows: "nope" }]) expect(rowsFromSinkBody(body)).toEqual([]);
    expect(rowsFromSinkBody([1, "two", null, { ok: true }])).toEqual([{ ok: true }]);
  });
});

describe("trackingSinkConnectionState", () => {
  it("reports configuration by env var NAME, never a value", () => {
    expect(trackingSinkConnectionState(CONFIGURED_ENV)).toEqual({ urlConfigured: true, tokenConfigured: true, urlEnvVar: TRACKING_SINK_URL_ENV, tokenEnvVar: TRACKING_SINK_TOKEN_ENV });
    expect(trackingSinkConnectionState(UNCONFIGURED_ENV).urlConfigured).toBe(false);
  });
});

describe("ingestTrackingRollups", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("records exactly one feedback OUTCOME per returned row, keyed by nodeId/runId", async () => {
    const rows = [row("draft_writer", "run_a"), row("draft_writer", "run_b", { exposures: 10 }), row("image_picker", "run_c")];
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" },
      deps(jsonFetch({ rows }))
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toBe(3);
    expect(result.ingested).toHaveLength(3);
    expect(result.ingested.map((entry) => producerKeyOf(entry.nodeId, entry.runId))).toEqual(["draft_writer:run_a", "draft_writer:run_b", "image_picker:run_c"]);

    const feedback = (await repositoryManager.getEvaluationRepository().listFeedback({ kind: "outcome" })).filter((record) => ["run_a", "run_b", "run_c"].includes(record.runId ?? ""));
    expect(feedback).toHaveLength(3);
    const first = feedback.find((record) => record.runId === "run_a");
    expect(first?.nodeId).toBe("draft_writer");
    expect(first?.outcome?.source).toBe(TRACKING_OUTCOME_SOURCE);
    expect(first?.outcome?.metrics).toEqual({ pageviews: 4100, exposures: 1200, sessions: 340, completion_rate: 0.42, cta_ctr: 0.08, purchase_rate: 0.011, revenue_cents: 45900, p75_dwell_ms: 38000 });
    expect(first?.note).toBe("window 2026-08-29..2026-08-30");
  });

  it("requests /rollups?by=producer with the project/window params and the sink bearer", async () => {
    const calls: FetchCall[] = [];
    await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30", nodeId: "draft_writer" },
      deps(jsonFetch({ rows: [] }, 200, calls))
    );
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.pathname.endsWith("/rollups")).toBe(true);
    expect(url.searchParams.get("by")).toBe("producer");
    expect(url.searchParams.get("project_id")).toBe("trk_demo");
    expect(url.searchParams.get("from")).toBe("2026-08-29");
    expect(url.searchParams.get("to")).toBe("2026-08-30");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${CONFIGURED_ENV[TRACKING_SINK_TOKEN_ENV]}`);
  });

  // CONTRACT TEST — kugel-data netlify/functions/_shared/rollups.ts → parseRollupParams. These three
  // rules are the whole reason the bridge returned 400 for a week: `project=` instead of `project_id=`,
  // a `node` param the sink does not implement, and ISO date-times where it demands calendar days.
  // Changing any expectation here means the sink changed too — check the other repo first.
  it("sends exactly the query params the sink parses, and no others", async () => {
    const calls: FetchCall[] = [];
    await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30", nodeId: "draft_writer" },
      deps(jsonFetch({ rows: [] }, 200, calls))
    );
    const names = [...calls[0]!.url.searchParams.keys()].sort();
    expect(names).toEqual(["by", "from", "project_id", "to"]);
    // The sink rejects an unknown `project` and has no producer filter — neither may be sent.
    expect(calls[0]!.url.searchParams.has("project")).toBe(false);
    expect(calls[0]!.url.searchParams.has("node")).toBe(false);
  });

  it("truncates an ISO date-time window to the strict YYYY-MM-DD the sink requires", async () => {
    const calls: FetchCall[] = [];
    await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29T00:00:00.000Z", to: "2026-08-30T23:59:59.999Z" },
      deps(jsonFetch({ rows: [] }, 200, calls))
    );
    expect(calls[0]!.url.searchParams.get("from")).toBe("2026-08-29");
    expect(calls[0]!.url.searchParams.get("to")).toBe("2026-08-30");
  });

  it("narrows to the requested node client-side, keeping rows that name none", async () => {
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30", nodeId: "draft_writer" },
      deps(
        jsonFetch({
          rows: [
            { node_id: "draft_writer", run_id: "run_a", pageviews: 12 },
            { node_id: "image_picker", run_id: "run_b", pageviews: 30 },
            { run_id: "run_c", pageviews: 5 }
          ]
        })
      )
    );
    expect(result.rows).toBe(2);
    expect(result.ingested.map((entry) => entry.runId)).toEqual(["run_a", "run_c"]);
  });

  it("carries pageviews on the engagement.v1 metric vector", () => {
    expect(trackingMetricsFromRow({ pageviews: 240, exposures: 0 })).toEqual({ pageviews: 240, exposures: 0 });
  });

  it("attributes a row with no node of its own to the requested nodeId", async () => {
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30", nodeId: "draft_writer" },
      deps(jsonFetch({ rows: [{ run_id: "run_x", exposures: 4 }] }))
    );
    expect(result.ingested[0]).toMatchObject({ nodeId: "draft_writer", runId: "run_x", metricCount: 1 });
  });

  it("reads a nested producer object in either casing", async () => {
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" },
      deps(jsonFetch([{ producer: { nodeId: "draft_writer", run_id: "run_y" }, exposures: 1 }]))
    );
    expect(result.ingested[0]).toMatchObject({ nodeId: "draft_writer", runId: "run_y" });
  });

  it("feeds optimizer.analyzeNode's feedback.outcomes count", async () => {
    await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" },
      deps(jsonFetch({ rows: [row("draft_writer", "run_a")] }))
    );
    const analysis = await analyzeNode({ nodeId: "draft_writer" }, {
      workspaceRepository: repositoryManager.getWorkspaceRepository(),
      executionRepository: repositoryManager.getExecutionRepository(),
      improvementRepository: repositoryManager.getImprovementRepository(),
      evaluationRepository: repositoryManager.getEvaluationRepository()
    });
    expect(analysis.feedback.outcomes).toBeGreaterThanOrEqual(1);
    expect(analysis.evidence.feedbackIds.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty and never throws on a transport error", async () => {
    const before = (await repositoryManager.getEvaluationRepository().listFeedback({ kind: "outcome" })).length;
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" },
      deps(throwingFetch(new TypeError("socket hang up")))
    );
    expect(result.ingested).toEqual([]);
    expect(result.rows).toBe(0);
    expect(result.errors[0]!.error).toContain("tracking_sink_unreachable");
    // The sink URL can embed credentials, so the raw transport message is collapsed to its NAME.
    expect(result.errors[0]!.error).not.toContain("socket hang up");
    expect(await repositoryManager.getEvaluationRepository().listFeedback({ kind: "outcome" })).toHaveLength(before);
  });

  it("returns empty and never throws on a non-200", async () => {
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" },
      deps(jsonFetch({ error: "nope" }, 503))
    );
    expect(result.ingested).toEqual([]);
    expect(result.errors).toEqual([{ error: "tracking_sink_http_503: the tracking sink rejected the rollups request." }]);
  });

  it("returns empty and never throws on a malformed body", async () => {
    for (const body of [{ unexpected: true }, "not json at all", null]) {
      const result = await ingestTrackingRollups({ projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" }, deps(jsonFetch(body)));
      expect(result.ingested).toEqual([]);
      expect(result.rows).toBe(0);
      expect(result.errors).toEqual([]);
    }
    const unparseable = (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } } as unknown as Response)) as unknown as typeof fetch;
    const result = await ingestTrackingRollups({ projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" }, deps(unparseable));
    expect(result.ingested).toEqual([]);
    expect(result.errors[0]!.error).toContain("tracking_sink_unreachable");
  });

  it("names the unset env vars (never a value) when the sink is not configured, without calling fetch", async () => {
    const calls: FetchCall[] = [];
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" },
      deps(jsonFetch({ rows: [row("draft_writer", "run_a")] }, 200, calls), UNCONFIGURED_ENV)
    );
    expect(calls).toEqual([]);
    expect(result.ingested).toEqual([]);
    expect(result.errors[0]!.error).toContain(TRACKING_SINK_URL_ENV);
    expect(result.errors[0]!.error).toContain(TRACKING_SINK_TOKEN_ENV);
  });

  it("isolates a row the repository rejects and still records the others", async () => {
    const evaluationRepository = repositoryManager.getEvaluationRepository();
    let seen = 0;
    const failing = new Proxy(evaluationRepository, {
      get(target, property, receiver) {
        if (property === "recordFeedback") {
          return async (record: Parameters<typeof evaluationRepository.recordFeedback>[0]) => {
            if (++seen === 1) throw new Error("store write rejected");
            return evaluationRepository.recordFeedback(record);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const result = await ingestTrackingRollups(
      { projectId: "trk_demo", from: "2026-08-29", to: "2026-08-30" },
      { evaluationRepository: failing, fetchImpl: jsonFetch({ rows: [row("a", "run_1"), row("b", "run_2")] }), env: CONFIGURED_ENV }
    );
    expect(result.rows).toBe(2);
    expect(result.ingested).toHaveLength(1);
    expect(result.errors).toEqual([{ producer: "a:run_1", error: "store write rejected" }]);
  });
});
