import { describe, expect, it } from "vitest";
import {
  ENGAGEMENT_CAUSE,
  ENGAGEMENT_MIN_SESSIONS,
  aggregateEngagement,
  diagnoseEngagement,
  engagementShortfalls,
  medianRollupMetrics,
  renderEngagementEvidence,
  rubricLooksHealthy,
  type EngagementBlock
} from "../../../src/agent/improvement/engagement.js";
import { analyzeNode, proposeImprovement } from "../../../src/agent/improvement/optimizer.js";
import {
  TRACKING_OUTCOME_SOURCE,
  TRACKING_PROJECT_ID_ENV,
  TRACKING_SINK_TOKEN_ENV,
  TRACKING_SINK_URL_ENV
} from "../../../src/agent/improvement/trackingIngest.js";
import { makeImprovementId, type EvalResult, type FeedbackRecord } from "../../../src/agent/improvement/improvementTypes.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// T21.22 — engagement evidence in optimizer diagnosis. The outer loop already landed real reader
// behaviour in the store as `tracking:engagement.v1` outcome records (T21.7); until this, analyzeNode
// only COUNTED them and proposeImprovement diagnosed purely from worstCriteria[0], so completion rate,
// CTA CTR, purchase rate and dwell influenced nothing.
//
// These tests pin, in order: the pure aggregation and median math; the session FLOOR; the by=object
// median lookup's query contract (the same pinned contract the ingest bridge uses, since it is the
// same client); the two no-degradation paths (sink unreachable, env absent) leaving today's behaviour
// byte-identical; and the diagnosis rubric evals structurally cannot produce — good rubric, bad
// engagement — firing under its OWN named cause. No live sink is touched and only env NAMES appear.

const CONFIGURED_ENV = {
  [TRACKING_SINK_URL_ENV]: "https://sink.example/track",
  [TRACKING_SINK_TOKEN_ENV]: "test-token",
  [TRACKING_PROJECT_ID_ENV]: "trk_demo"
} as unknown as NodeJS.ProcessEnv;
const UNCONFIGURED_ENV = {} as unknown as NodeJS.ProcessEnv;

type FetchCall = { url: URL; init: RequestInit | undefined };

const jsonFetch = (body: unknown, calls: FetchCall[] = [], status = 200): typeof fetch =>
  (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

const throwingFetch = (error: Error): typeof fetch => (async () => { throw error; }) as unknown as typeof fetch;

const NEVER_CALLED: typeof fetch = (async () => { throw new Error("the sink must not be called here"); }) as unknown as typeof fetch;

const deps = (fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = CONFIGURED_ENV) => ({
  workspaceRepository: repositoryManager.getWorkspaceRepository(),
  executionRepository: repositoryManager.getExecutionRepository(),
  improvementRepository: repositoryManager.getImprovementRepository(),
  evaluationRepository: repositoryManager.getEvaluationRepository(),
  fetchImpl,
  env
});

// The in-process memory repositories keep their state for the whole file, so every case gets its own
// node id rather than a reset. Cases that reach proposeImprovement need a node that really exists in
// the workspace graph; the analysis-only cases do not.
let sequence = 0;
const probeNode = () => `probe_node_${++sequence}`;

const outcomeRecord = (nodeId: string, metrics: Record<string, number>, createdAt = "2026-08-15T00:00:00.000Z"): FeedbackRecord => ({
  feedbackId: makeImprovementId("fb"),
  kind: "outcome",
  nodeId,
  runId: makeImprovementId("run"),
  outcome: { source: TRACKING_OUTCOME_SOURCE, metrics },
  note: "window 2026-08-01..2026-08-31",
  createdAt
});

/** The node's own measured engagement: 340 sessions, completing at 12%, CTA CTR 0.4%. */
const recordEngagement = async (nodeId: string, sessionSplit: number[] = [200, 140]) => {
  for (const sessions of sessionSplit) {
    await repositoryManager.getEvaluationRepository().recordFeedback(outcomeRecord(nodeId, {
      pageviews: sessions * 12,
      sessions,
      completion_rate: 0.12,
      cta_ctr: 0.004,
      purchase_rate: 0.011,
      p75_dwell_ms: 38_000
    }));
  }
};

/** The site's own view over the same window: one row per published object. Medians land on
 * completion_rate 0.31, cta_ctr 0.019, purchase_rate 0.011, p75_dwell_ms 38000. */
const OBJECT_ROWS = [
  { object_id: "art_1", pageviews: 900, sessions: 300, completion_rate: 0.25, cta_ctr: 0.012, purchase_rate: 0.010, p75_dwell_ms: 30_000 },
  { object_id: "art_2", pageviews: 1200, sessions: 420, completion_rate: 0.31, cta_ctr: 0.019, purchase_rate: 0.011, p75_dwell_ms: 38_000 },
  { object_id: "art_3", pageviews: 2100, sessions: 760, completion_rate: 0.40, cta_ctr: 0.030, purchase_rate: 0.012, p75_dwell_ms: 44_000 }
];

const evalResult = (nodeId: string, normalizedScore: number, pass: boolean): EvalResult => ({
  evalId: makeImprovementId("eval"),
  rubricId: `rubric_${nodeId}`,
  nodeId,
  subjectHash: makeImprovementId("hash"),
  scores: [{ criterionId: "clarity", score: pass ? 5 : 2, max: 5, evidence: "fixture" }],
  normalizedScore,
  pass,
  judge: { mode: "mock", model: "fixture" },
  createdAt: "2026-08-15T00:00:00.000Z"
});

const recordRubric = async (nodeId: string, normalizedScore: number, pass: boolean, count = 4) => {
  for (let index = 0; index < count; index += 1) await repositoryManager.getEvaluationRepository().recordResult(evalResult(nodeId, normalizedScore, pass));
};

describe("aggregateEngagement", () => {
  it("sums counts and takes SESSION-WEIGHTED means of the rates", () => {
    const aggregate = aggregateEngagement([
      outcomeRecord("draft_writer", { pageviews: 100, sessions: 900, completion_rate: 0.10, cta_ctr: 0.002 }),
      outcomeRecord("draft_writer", { pageviews: 20, sessions: 100, completion_rate: 0.50, cta_ctr: 0.022 })
    ]);
    expect(aggregate.pageviews).toBe(120);
    expect(aggregate.sessions).toBe(1000);
    // An unweighted mean would read 0.30 here and let a 100-session row outvote a 900-session one.
    expect(aggregate.completion_rate).toBeCloseTo(0.14, 6);
    expect(aggregate.cta_ctr).toBeCloseTo(0.004, 6);
  });

  it("leaves an unreported metric UNDEFINED rather than zero-filling it", () => {
    const aggregate = aggregateEngagement([outcomeRecord("draft_writer", { sessions: 60, completion_rate: 0.2 })]);
    expect(aggregate.purchase_rate).toBeUndefined();
    expect(aggregate.p75_dwell_ms).toBeUndefined();
    expect("purchase_rate" in aggregate).toBe(false);
  });

  it("gives a record that reports no sessions weight 1 instead of dropping it", () => {
    const aggregate = aggregateEngagement([
      outcomeRecord("draft_writer", { completion_rate: 0.4 }),
      outcomeRecord("draft_writer", { completion_rate: 0.2 })
    ]);
    expect(aggregate.completion_rate).toBeCloseTo(0.3, 6);
    expect(aggregate.sessions).toBeUndefined();
  });

  it("aggregates nothing from no records", () => {
    expect(aggregateEngagement([])).toEqual({});
  });
});

describe("medianRollupMetrics", () => {
  it("takes the per-metric median across the sink's per-object rows", () => {
    const median = medianRollupMetrics(OBJECT_ROWS);
    expect(median.completion_rate).toBeCloseTo(0.31, 6);
    expect(median.cta_ctr).toBeCloseTo(0.019, 6);
    expect(median.p75_dwell_ms).toBe(38_000);
  });

  it("averages the two middle values on an even row count, and skips a metric nothing reported", () => {
    const median = medianRollupMetrics([{ completion_rate: 0.2 }, { completion_rate: 0.4 }]);
    expect(median.completion_rate).toBeCloseTo(0.3, 6);
    expect(median.cta_ctr).toBeUndefined();
    expect(medianRollupMetrics([])).toEqual({});
  });
});

describe("engagementShortfalls", () => {
  it("names only metrics materially below the median, worst ratio first", () => {
    const shortfalls = engagementShortfalls(
      { completion_rate: 0.12, cta_ctr: 0.004, purchase_rate: 0.011, p75_dwell_ms: 38_000 },
      { completion_rate: 0.31, cta_ctr: 0.019, purchase_rate: 0.011, p75_dwell_ms: 38_000 }
    );
    expect(shortfalls.map((shortfall) => shortfall.metric)).toEqual(["cta_ctr", "completion_rate"]);
    expect(shortfalls[0]!.ratio).toBeCloseTo(0.211, 3);
  });

  it("compares nothing when either side is unmeasured, and never counts a marginal gap", () => {
    expect(engagementShortfalls({ completion_rate: 0.12 }, {})).toEqual([]);
    expect(engagementShortfalls({}, { completion_rate: 0.31 })).toEqual([]);
    // 0.9x is below the median but not materially — half of everything is below a median.
    expect(engagementShortfalls({ completion_rate: 0.279 }, { completion_rate: 0.31 })).toEqual([]);
  });
});

describe("analyzeNode engagement block", () => {
  it("aggregates the node's outcome records and compares them against the site median", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId);
    const calls: FetchCall[] = [];
    const analysis = await analyzeNode({ nodeId }, deps(jsonFetch({ rows: OBJECT_ROWS }, calls)));

    const engagement = analysis.engagement!;
    expect(engagement.status).toBe("analyzed");
    expect(engagement.source).toBe(TRACKING_OUTCOME_SOURCE);
    expect(engagement.n).toBe(2);
    expect(engagement.sessions).toBe(340);
    expect(engagement.pageviews).toBe(4080);
    expect(engagement.completion_rate).toBeCloseTo(0.12, 6);
    expect(engagement.window).toEqual({ from: "2026-08-15T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" });
    expect(engagement.siteMedian).toEqual({ n: 3, metrics: expect.objectContaining({ completion_rate: 0.31, cta_ctr: 0.019 }) });
    expect(engagement.belowMedian!.map((shortfall) => shortfall.metric)).toEqual(["cta_ctr", "completion_rate"]);
    // The rest of the analysis is untouched: outcomes are still COUNTED as they always were.
    expect(analysis.feedback.outcomes).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("reads the site median with by=object and exactly the query params the sink parses", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId);
    const calls: FetchCall[] = [];
    await analyzeNode(
      { nodeId, from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z" },
      deps(jsonFetch({ rows: OBJECT_ROWS }, calls))
    );
    const { url, init } = calls[0]!;
    expect(url.pathname.endsWith("/rollups")).toBe(true);
    expect(url.searchParams.get("by")).toBe("object");
    expect(url.searchParams.get("project_id")).toBe("trk_demo");
    // The sink demands strict YYYY-MM-DD calendar days and 400s on an ISO date-time.
    expect(url.searchParams.get("from")).toBe("2026-08-01");
    expect(url.searchParams.get("to")).toBe("2026-08-31");
    expect([...url.searchParams.keys()].sort()).toEqual(["by", "from", "project_id", "to"]);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${CONFIGURED_ENV[TRACKING_SINK_TOKEN_ENV]}`);
  });

  it("honours an explicit projectId over the env partition", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId);
    const calls: FetchCall[] = [];
    await analyzeNode({ nodeId, projectId: "trk_other" }, deps(jsonFetch({ rows: OBJECT_ROWS }, calls)));
    expect(calls[0]!.url.searchParams.get("project_id")).toBe("trk_other");
  });

  it("reports insufficient_data BELOW the session floor, without calling the sink at all", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId, [ENGAGEMENT_MIN_SESSIONS - 1]);
    const analysis = await analyzeNode({ nodeId }, deps(NEVER_CALLED));
    const engagement = analysis.engagement!;
    expect(engagement.status).toBe("insufficient_data");
    expect(engagement.n).toBe(1);
    expect(engagement.sessions).toBe(49);
    // Nothing is diagnosed from it: no median was fetched, so there is nothing to be below.
    expect(engagement.siteMedian).toBeUndefined();
    expect(engagement.belowMedian).toBeUndefined();
  });

  it("analyzes at exactly the floor", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId, [ENGAGEMENT_MIN_SESSIONS]);
    const analysis = await analyzeNode({ nodeId }, deps(jsonFetch({ rows: OBJECT_ROWS })));
    expect(analysis.engagement!.sessions).toBe(50);
    expect(analysis.engagement!.status).toBe("analyzed");
  });

  it("leaves the analysis EXACTLY as it was when the sink is unreachable", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId);
    const reachable = await analyzeNode({ nodeId }, deps(throwingFetch(new TypeError("socket hang up"))));
    const preT2122 = await analyzeNode({ nodeId }, deps(NEVER_CALLED, UNCONFIGURED_ENV));
    expect(reachable.engagement).toBeUndefined();
    expect("engagement" in reachable).toBe(false);
    expect(reachable).toEqual(preT2122);
    expect(reachable.feedback.outcomes).toBe(2);
  });

  it("leaves the analysis EXACTLY as it was when the sink env is absent, without calling fetch", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId);
    const analysis = await analyzeNode({ nodeId }, deps(NEVER_CALLED, UNCONFIGURED_ENV));
    expect(analysis.engagement).toBeUndefined();
    expect(analysis.feedback.outcomes).toBe(2);
  });

  it("carries no engagement block when the sink answers with no rows, or the node has no records", async () => {
    const nodeId = probeNode();
    const empty = await analyzeNode({ nodeId }, deps(NEVER_CALLED));
    expect(empty.engagement).toBeUndefined();
    await recordEngagement(nodeId);
    const noRows = await analyzeNode({ nodeId }, deps(jsonFetch({ rows: [] })));
    expect(noRows.engagement).toBeUndefined();
  });

  it("ignores outcome records outside the window and from other sources", async () => {
    const nodeId = probeNode();
    await recordEngagement(nodeId);
    await repositoryManager.getEvaluationRepository().recordFeedback(outcomeRecord(nodeId, { sessions: 5000, completion_rate: 0.9 }, "2026-01-01T00:00:00.000Z"));
    await repositoryManager.getEvaluationRepository().recordFeedback({
      ...outcomeRecord(nodeId, { sessions: 5000, completion_rate: 0.9 }),
      outcome: { source: "monetizer:performance", metrics: { sessions: 5000, completion_rate: 0.9 } }
    });
    const analysis = await analyzeNode({ nodeId, from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z" }, deps(jsonFetch({ rows: OBJECT_ROWS })));
    expect(analysis.engagement!.n).toBe(2);
    expect(analysis.engagement!.sessions).toBe(340);
  });
});

describe("engagement diagnosis", () => {
  const analyzedBlock: EngagementBlock = {
    status: "analyzed",
    source: TRACKING_OUTCOME_SOURCE,
    window: { from: "2026-08-01", to: "2026-08-31" },
    n: 2,
    sessions: 340,
    pageviews: 4080,
    completion_rate: 0.12,
    cta_ctr: 0.004,
    siteMedian: { n: 3, metrics: { completion_rate: 0.31, cta_ctr: 0.019 } },
    belowMedian: [
      { metric: "cta_ctr", value: 0.004, median: 0.019, ratio: 0.211 },
      { metric: "completion_rate", value: 0.12, median: 0.31, ratio: 0.387 }
    ]
  };
  const healthy = { sampleSize: 12, meanScore: 0.86, passRate: 1 };

  it("renders a concrete comparison against the median, not a bare score", () => {
    const evidence = renderEngagementEvidence(analyzedBlock);
    expect(evidence).toContain("CTA CTR 0.4% vs site median 1.9%");
    expect(evidence).toContain("completion rate 12% vs site median 31%");
    expect(evidence).toContain("340 sessions");
    expect(evidence).toContain(TRACKING_OUTCOME_SOURCE);
  });

  it("renders NOTHING below the floor, so an under-evidenced prompt is unchanged", () => {
    expect(renderEngagementEvidence({ ...analyzedBlock, status: "insufficient_data", siteMedian: undefined, belowMedian: undefined })).toBe("");
    expect(renderEngagementEvidence(undefined)).toBe("");
  });

  it("fires as its own named cause when the rubric is healthy and engagement is not", () => {
    const diagnosis = diagnoseEngagement(healthy, analyzedBlock)!;
    expect(diagnosis.cause).toBe(ENGAGEMENT_CAUSE);
    expect(diagnosis.shortfalls.map((shortfall) => shortfall.metric)).toEqual(["cta_ctr", "completion_rate"]);
    expect(diagnosis.rationale).toContain("rubric health is good");
    expect(diagnosis.rationale).toContain("A rubric evaluation cannot observe this");
  });

  it("does not fire below the floor, with no shortfall, or when the rubric is the actual problem", () => {
    expect(diagnoseEngagement(healthy, { ...analyzedBlock, status: "insufficient_data" })).toBeUndefined();
    expect(diagnoseEngagement(healthy, { ...analyzedBlock, belowMedian: [] })).toBeUndefined();
    expect(diagnoseEngagement(healthy, undefined)).toBeUndefined();
    expect(diagnoseEngagement({ sampleSize: 12, meanScore: 0.41, passRate: 0.25 }, analyzedBlock)).toBeUndefined();
    // No rubric evidence at all is not a healthy rubric: there is no claim for engagement to contradict.
    expect(rubricLooksHealthy({ sampleSize: 0, meanScore: undefined, passRate: undefined })).toBe(false);
  });
});

describe("proposeImprovement with engagement evidence", () => {
  it("names engagement_below_site_median as its own cause when the node passes its rubric and still loses readers", async () => {
    await recordEngagement("draft_writer");
    await recordRubric("draft_writer", 0.92, true);
    const proposal = await proposeImprovement({ nodeId: "draft_writer", mode: "mock" }, deps(jsonFetch({ rows: OBJECT_ROWS })));

    expect(proposal.cause).toBe(ENGAGEMENT_CAUSE);
    expect(proposal.diagnosis).toContain(ENGAGEMENT_CAUSE);
    expect(proposal.rationale).toContain("CTA CTR 0.4% vs site median 1.9%");
    // The named cause is NOT blended into the worst-criterion story.
    expect(proposal.diagnosis).not.toContain("no explicit completion bar");
    expect(proposal.change.kind === "prompt" && proposal.change.prompt).toContain("Engagement bar:");
    expect(proposal.change.kind === "prompt" && proposal.change.prompt).not.toContain("Quality bar:");
  });

  it("keeps the rubric criterion as the cause when the rubric is the actual problem", async () => {
    await recordEngagement("research");
    await recordRubric("research", 0.35, false);
    const proposal = await proposeImprovement({ nodeId: "research", mode: "mock" }, deps(jsonFetch({ rows: OBJECT_ROWS })));
    expect(proposal.cause).toBe("rubric_criterion");
    expect(proposal.change.kind === "prompt" && proposal.change.prompt).toContain("Quality bar:");
  });

  it("proposes nothing on engagement grounds below the floor", async () => {
    await recordEngagement("brief_architect", [ENGAGEMENT_MIN_SESSIONS - 1]);
    await recordRubric("brief_architect", 0.92, true);
    const proposal = await proposeImprovement({ nodeId: "brief_architect", mode: "mock" }, deps(NEVER_CALLED));
    expect(proposal.cause).not.toBe(ENGAGEMENT_CAUSE);
    expect(proposal.diagnosis).not.toContain(ENGAGEMENT_CAUSE);
    expect(proposal.change.kind === "prompt" && proposal.change.prompt).not.toContain("Engagement bar:");
  });

  it("proposes exactly what it proposed before T21.22 when the sink is unreachable", async () => {
    await recordEngagement("angle_strategy");
    await recordRubric("angle_strategy", 0.92, true);
    const withSink = await proposeImprovement({ nodeId: "angle_strategy", mode: "mock" }, deps(throwingFetch(new TypeError("socket hang up"))));
    const withoutEnv = await proposeImprovement({ nodeId: "angle_strategy", mode: "mock" }, deps(NEVER_CALLED, UNCONFIGURED_ENV));
    expect(withSink.cause).toBe(withoutEnv.cause);
    expect(withSink.cause).not.toBe(ENGAGEMENT_CAUSE);
    expect(withSink.change).toEqual(withoutEnv.change);
    expect(withSink.diagnosis).toBe(withoutEnv.diagnosis);
  });
});
