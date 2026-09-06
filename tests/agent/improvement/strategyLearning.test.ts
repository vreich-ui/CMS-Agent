import { beforeEach, describe, expect, it } from "vitest";
import {
  contradictingStrategySightings,
  ingestStrategyRollups,
  promoteStrategySignals,
  renderStrategyObservation,
  renderStrategyPlaybookItem,
  stableStrategySignals,
  strategyFindings,
  strategyGroupsFromRows,
  strategyPlaybookItemPrefix,
  strategySightingsFromObservations,
  strategySiteBaseline,
  STRATEGY_OBSERVATION_SOURCE,
  STRATEGY_PLAYBOOK_TARGET_NODES,
  STRATEGY_PROMOTION_MIN_N
} from "../../../src/agent/improvement/strategyLearning.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
import type { LearningObservation } from "../../../src/agent/mcp/workspace/store.js";
import type { LearningRepository } from "../../../src/agent/repository/interfaces/LearningRepository.js";
import type { ImprovementRepository } from "../../../src/agent/repository/interfaces/ImprovementRepository.js";
import type { NodePlaybook } from "../../../src/agent/improvement/improvementTypes.js";

// T21.35 strategy-level learning: the sink's `by=strategy` grain becomes cross-article observations,
// and only what has HELD UP becomes a playbook item for the writer and planning nodes. These tests
// pin the pure aggregation/rendering, the n and stability gates, the counter, and the three ways the
// pull can produce nothing without changing anything. No live sink is touched and only env var NAMES
// appear here.

const CONFIGURED_ENV = { [TRACKING_SINK_URL_ENV]: "https://sink.example/track", [TRACKING_SINK_TOKEN_ENV]: "test-token" } as unknown as NodeJS.ProcessEnv;
const UNCONFIGURED_ENV = {} as unknown as NodeJS.ProcessEnv;

type FetchCall = { url: URL; init: RequestInit | undefined };

const jsonFetch = (body: unknown, status = 200, calls: FetchCall[] = []): typeof fetch =>
  (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

const throwingFetch = (error: Error): typeof fetch => (async () => { throw error; }) as unknown as typeof fetch;

// One sink row. The winner: `objection_first`/`objection_handling` holds attention far longer and is
// finished far more often than the two ordinary rows it sits beside.
const strategyRow = (overrides: Record<string, unknown> = {}) => ({
  strategy: "objection_first",
  intent: "objection_handling",
  day: "2026-08-30",
  pageviews: 3100,
  exposures: 900,
  sessions: 260,
  completion_rate: 0.58,
  cta_ctr: 0.09,
  buy_click_rate: 0.04,
  purchase_rate: 0.012,
  revenue_cents: 42000,
  p75_dwell_ms: 42000,
  n: 412,
  ...overrides
});

const ordinaryRow = (overrides: Record<string, unknown> = {}) => ({
  strategy: "listicle",
  intent: "awareness",
  day: "2026-08-30",
  pageviews: 2400,
  sessions: 210,
  completion_rate: 0.4,
  cta_ctr: 0.05,
  buy_click_rate: 0.02,
  purchase_rate: 0.006,
  p75_dwell_ms: 20000,
  n: 300,
  ...overrides
});

const thirdRow = (overrides: Record<string, unknown> = {}) => ({
  strategy: "how_to",
  intent: "education",
  day: "2026-08-30",
  completion_rate: 0.4,
  cta_ctr: 0.05,
  buy_click_rate: 0.02,
  purchase_rate: 0.006,
  p75_dwell_ms: 20000,
  n: 280,
  ...overrides
});

const page = (rows: unknown[]) => ({ rows });

// Per-test substrate. The shipped memory repositories keep module-level state keyed by backend name,
// which would let one window's promotion leak into the next test's "nothing promoted yet" assertion —
// the exact thing these tests are about. These fakes hold only what this module reads and writes.
const fakeLearning = () => {
  const observations: LearningObservation[] = [];
  let sequence = 0;
  const repository = {
    async recordObservation(observation: string, metadata?: Record<string, unknown>) {
      const record: LearningObservation = { id: `learning_${++sequence}`, observation, metadata, createdAt: new Date(Date.UTC(2026, 7, 30, 0, 0, sequence)).toISOString() };
      observations.push(record);
      return structuredClone(record);
    },
    async listObservations() { return observations.map((record) => structuredClone(record)); }
  } as unknown as LearningRepository;
  return repository;
};

const fakeImprovement = () => {
  const playbooks = new Map<string, NodePlaybook>();
  const repository = {
    async getPlaybook(nodeId: string) { const playbook = playbooks.get(nodeId); return playbook ? structuredClone(playbook) : undefined; },
    async savePlaybook(playbook: NodePlaybook) { playbooks.set(playbook.nodeId, structuredClone(playbook)); return structuredClone(playbook); }
  } as unknown as ImprovementRepository;
  return repository;
};

// One substrate per test, rebuilt in beforeEach.
let learningRepository: LearningRepository;
let improvementRepository: ImprovementRepository;

const deps = (fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = CONFIGURED_ENV) => ({ learningRepository, improvementRepository, fetchImpl, env });

const WINDOW_1 = { from: "2026-08-29", to: "2026-08-30" };
const WINDOW_2 = { from: "2026-08-30", to: "2026-08-31" };
const WINDOW_3 = { from: "2026-08-31", to: "2026-09-01" };

describe("strategyGroupsFromRows", () => {
  it("collapses strategy/intent/day rows into one row per strategy/intent, summing n and weighting rates by it", () => {
    const groups = strategyGroupsFromRows([
      strategyRow({ day: "2026-08-29", n: 100, completion_rate: 0.5, p75_dwell_ms: 40000, pageviews: 1000 }),
      strategyRow({ day: "2026-08-30", n: 300, completion_rate: 0.6, p75_dwell_ms: 44000, pageviews: 2000 }),
      ordinaryRow()
    ]);
    expect(groups).toHaveLength(2);
    const winner = groups.find((group) => group.intent === "objection_handling")!;
    expect(winner.n).toBe(400);
    expect(winner.days).toBe(2);
    expect(winner.metrics.pageviews).toBe(3000);
    // n-weighted, not a flat mean: (0.5*100 + 0.6*300) / 400 = 0.575, and a flat mean would be 0.55.
    expect(winner.metrics.completion_rate).toBe(0.575);
    expect(winner.metrics.p75_dwell_ms).toBe(43000);
  });

  it("carries buy_click_rate, which the engagement.v1 vector has no column for", () => {
    expect(strategyGroupsFromRows([strategyRow()])[0]!.metrics.buy_click_rate).toBe(0.04);
  });

  it("drops a row that names neither a strategy nor an intent rather than bucketing it as unknown", () => {
    expect(strategyGroupsFromRows([{ day: "2026-08-30", n: 900, completion_rate: 0.9 }])).toEqual([]);
  });

  it("leaves a metric the sink did not report absent rather than zero-filling it", () => {
    const group = strategyGroupsFromRows([{ intent: "education", n: 10, completion_rate: 0.3 }])[0]!;
    expect(group.metrics.completion_rate).toBe(0.3);
    expect(group.metrics.cta_ctr).toBeUndefined();
    expect(group.metrics.p75_dwell_ms).toBeUndefined();
  });
});

describe("strategySiteBaseline + strategyFindings", () => {
  const rows = [strategyRow(), ordinaryRow(), thirdRow()];

  it("takes the site-wide figure from the same window's rows, as a per-metric median", () => {
    expect(strategySiteBaseline(rows)).toEqual({ completion_rate: 0.4, cta_ctr: 0.05, buy_click_rate: 0.02, purchase_rate: 0.006, p75_dwell_ms: 20000 });
  });

  it("names only the materially different metrics, biggest gap first, and never compares counts", () => {
    const group = strategyGroupsFromRows(rows).find((candidate) => candidate.intent === "objection_handling")!;
    const findings = strategyFindings(group, strategySiteBaseline(rows));
    expect(findings.map((finding) => finding.metric)).toEqual(["p75_dwell_ms", "buy_click_rate", "purchase_rate", "cta_ctr", "completion_rate"]);
    expect(findings.every((finding) => finding.direction === "above")).toBe(true);
    expect(findings.find((finding) => finding.metric === "p75_dwell_ms")!.ratio).toBe(2.1);
    expect(findings.find((finding) => finding.metric === "completion_rate")!.deltaPoints).toBe(18);
    // pageviews/sessions are counts; a window total against a per-cell median says nothing.
    expect(findings.some((finding) => ["pageviews", "sessions"].includes(finding.metric as string))).toBe(false);
  });

  it("produces no finding when the difference is inside the margin, or when either side is unmeasured", () => {
    const flat = strategyGroupsFromRows([ordinaryRow(), thirdRow()]);
    for (const group of flat) expect(strategyFindings(group, strategySiteBaseline([ordinaryRow(), thirdRow()]))).toEqual([]);
    const halfMeasured = strategyGroupsFromRows([{ intent: "education", n: 500, completion_rate: 0.9 }])[0]!;
    expect(strategyFindings(halfMeasured, { cta_ctr: 0.05 })).toEqual([]);
  });
});

describe("the observation text", () => {
  it("reads as the cross-article finding, carrying its window and its n", () => {
    const rows = [strategyRow(), ordinaryRow(), thirdRow()];
    const group = strategyGroupsFromRows(rows).find((candidate) => candidate.intent === "objection_handling")!;
    const findings = strategyFindings(group, strategySiteBaseline(rows)).filter((finding) => ["p75_dwell_ms", "completion_rate"].includes(finding.metric));
    expect(renderStrategyObservation(group, findings, group.n, WINDOW_1)).toBe(
      "intent `objection_handling` (strategy `objection_first`): p75 dwell 2.1× site median, completion +18 pts (n=412, window 2026-08-29..2026-08-30)"
    );
  });

  it("names only the half of the subject the row actually carried", () => {
    expect(renderStrategyObservation({ intent: "education" }, [], 5, WINDOW_1)).toContain("intent `education`:");
    expect(renderStrategyObservation({ strategy: "listicle" }, [], 5, WINDOW_1)).toContain("strategy `listicle`:");
  });
});

describe("ingestStrategyRollups", () => {
  beforeEach(() => { learningRepository = fakeLearning(); improvementRepository = fakeImprovement(); });

  it("requests /rollups?by=strategy on the same pinned param contract as the other grains", async () => {
    const calls: FetchCall[] = [];
    await ingestStrategyRollups({ projectId: "trk_demo", from: "2026-08-29T00:00:00.000Z", to: "2026-08-30T12:00:00Z" }, deps(jsonFetch(page([]), 200, calls)));
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.pathname.endsWith("/rollups")).toBe(true);
    expect([...url.searchParams.keys()].sort()).toEqual(["by", "from", "project_id", "to"]);
    expect(url.searchParams.get("by")).toBe("strategy");
    expect(url.searchParams.get("project_id")).toBe("trk_demo");
    expect(url.searchParams.get("from")).toBe("2026-08-29");
    expect(url.searchParams.get("to")).toBe("2026-08-30");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${CONFIGURED_ENV[TRACKING_SINK_TOKEN_ENV]}`);
  });

  it("records one tracking:strategy.v1 observation per group with a material finding", async () => {
    const result = await ingestStrategyRollups(
      { projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to },
      deps(jsonFetch(page([strategyRow(), ordinaryRow(), thirdRow()])))
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toBe(3);
    expect(result.groups).toBe(3);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.observation).toBe(
      "intent `objection_handling` (strategy `objection_first`): p75 dwell 2.1× site median, buy-click rate +2 pts, purchase rate +0.6 pts, CTA CTR +4 pts, completion +18 pts (n=412, window 2026-08-29..2026-08-30)"
    );

    const stored = await learningRepository.listObservations();
    const observation = stored.find((entry) => entry.metadata?.source === STRATEGY_OBSERVATION_SOURCE)!;
    expect(observation.metadata).toMatchObject({ source: STRATEGY_OBSERVATION_SOURCE, projectId: "trk_demo", strategy: "objection_first", intent: "objection_handling", n: 412, window: WINDOW_1 });
    expect((observation.metadata!.findings as unknown[]).length).toBe(5);
  });

  it("promotes nothing from a single window — one good week is a week, not a lesson", async () => {
    await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch(page([strategyRow(), ordinaryRow(), thirdRow()]))));
    for (const nodeId of STRATEGY_PLAYBOOK_TARGET_NODES) {
      expect(await improvementRepository.getPlaybook(nodeId)).toBeUndefined();
    }
  });

  it("promotes a per-node playbook item on the SECOND consecutive window in the same direction", async () => {
    const rows = [strategyRow(), ordinaryRow(), thirdRow()];
    await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch(page(rows))));
    const second = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_2.from, to: WINDOW_2.to }, deps(jsonFetch(page(rows))));

    expect([...new Set(second.promotion.promoted.map((entry) => entry.nodeId))].sort()).toEqual([...STRATEGY_PLAYBOOK_TARGET_NODES].sort());
    const writer = (await improvementRepository.getPlaybook("draft_writer"))!;
    const dwell = writer.items.find((item) => item.text.includes("stay past the first screen"))!;
    expect(dwell.kind).toBe("strategy");
    expect(dwell.provenance.source).toBe("tracking");
    expect(dwell.text).toBe(
      "Reach for intent `objection_handling` (strategy `objection_first`) when the brief allows it — give the reader a reason to stay past the first screen: the question they arrived with, answered where they can watch it being answered; it holds attention 2.1× the site typical. (tracking:strategy.v1, 2 consecutive windows through 2026-08-31, n=824.)"
    );
    // Reads as guidance, not as a metric dump: the instruction comes first, the evidence in brackets.
    expect(dwell.text.startsWith("Reach for")).toBe(true);
    // Every planning node got it too, not just the writer.
    const planner = (await improvementRepository.getPlaybook("brief_architect"))!;
    expect(planner.items.some((item) => item.text.includes("stay past the first screen"))).toBe(true);
  });

  it("reinforces rather than duplicating when a promoted item holds for a third window", async () => {
    const rows = [strategyRow(), ordinaryRow(), thirdRow()];
    for (const window of [WINDOW_1, WINDOW_2, WINDOW_3]) {
      await ingestStrategyRollups({ projectId: "trk_demo", from: window.from, to: window.to }, deps(jsonFetch(page(rows))));
    }
    const writer = (await improvementRepository.getPlaybook("draft_writer"))!;
    const dwellItems = writer.items.filter((item) => item.text.includes("stay past the first screen"));
    expect(dwellItems).toHaveLength(1);
    expect(dwellItems[0]!.helpfulCount).toBeGreaterThan(1);
    expect(dwellItems[0]!.harmfulCount).toBe(0);
  });

  it("counters a promoted item when a later window contradicts it", async () => {
    const rows = [strategyRow(), ordinaryRow(), thirdRow()];
    await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch(page(rows))));
    await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_2.from, to: WINDOW_2.to }, deps(jsonFetch(page(rows))));

    // Third window: the same subject now sits well BELOW the site figure on every metric.
    const reversed = [
      strategyRow({ completion_rate: 0.2, cta_ctr: 0.02, buy_click_rate: 0.008, purchase_rate: 0.002, p75_dwell_ms: 9000 }),
      ordinaryRow(),
      thirdRow()
    ];
    const third = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_3.from, to: WINDOW_3.to }, deps(jsonFetch(page(reversed))));

    expect(third.promotion.countered.some((entry) => entry.nodeId === "draft_writer")).toBe(true);
    const writer = (await improvementRepository.getPlaybook("draft_writer"))!;
    const dwell = writer.items.find((item) => item.text.startsWith("Reach for") && item.text.includes("stay past the first screen"))!;
    expect(dwell.harmfulCount).toBe(1);
    // The counter is the playbook's OWN demotion mechanism — net helpfulness — not a deletion.
    expect(dwell.status).toBe("active");
    // The contradicting direction is not itself promoted off one window.
    expect(writer.items.some((item) => item.text.startsWith("Do not default to"))).toBe(false);
  });

  it("does not promote a finding whose group is below the n bar, however many windows it holds", async () => {
    const thin = [strategyRow({ n: STRATEGY_PROMOTION_MIN_N - 1 }), ordinaryRow(), thirdRow()];
    for (const window of [WINDOW_1, WINDOW_2, WINDOW_3]) {
      await ingestStrategyRollups({ projectId: "trk_demo", from: window.from, to: window.to }, deps(jsonFetch(page(thin))));
    }
    const observations = await learningRepository.listObservations();
    expect(observations.filter((entry) => entry.metadata?.source === STRATEGY_OBSERVATION_SOURCE)).toHaveLength(3);
    expect(await improvementRepository.getPlaybook("draft_writer")).toBeUndefined();
  });

  it("does not counter off a window that is below the n bar", async () => {
    const rows = [strategyRow(), ordinaryRow(), thirdRow()];
    await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch(page(rows))));
    await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_2.from, to: WINDOW_2.to }, deps(jsonFetch(page(rows))));
    const noisyReversal = [
      strategyRow({ n: 12, completion_rate: 0.2, cta_ctr: 0.02, buy_click_rate: 0.008, purchase_rate: 0.002, p75_dwell_ms: 9000 }),
      ordinaryRow(),
      thirdRow()
    ];
    const third = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_3.from, to: WINDOW_3.to }, deps(jsonFetch(page(noisyReversal))));
    expect(third.promotion.countered).toEqual([]);
    const writer = (await improvementRepository.getPlaybook("draft_writer"))!;
    expect(writer.items.find((item) => item.text.includes("stay past the first screen"))!.harmfulCount).toBe(0);
  });

  it("treats a 503 from the unmigrated by=strategy grain exactly like an unreachable sink: no observations, no error, nothing changed", async () => {
    const result = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch({ error: "grain not available" }, 503)));
    expect(result.skipped).toBe("grain_unavailable");
    expect(result.errors).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(await learningRepository.listObservations()).toEqual([]);
    expect(await improvementRepository.getPlaybook("draft_writer")).toBeUndefined();
  });

  it("no-ops with the sink absent, and never reaches the network", async () => {
    const calls: FetchCall[] = [];
    const result = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch(page([strategyRow()]), 200, calls), UNCONFIGURED_ENV));
    expect(result.skipped).toBe("sink_unconfigured");
    expect(calls).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(await learningRepository.listObservations()).toEqual([]);
  });

  it("never throws on a transport failure, and collapses the message to its name", async () => {
    const result = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(throwingFetch(new TypeError("socket hang up"))));
    expect(result.observations).toEqual([]);
    expect(result.errors[0]!.error).toContain("tracking_sink_unreachable");
    expect(result.errors[0]!.error).not.toContain("socket hang up");
  });

  it("never throws on zero rows or a malformed body, and fabricates nothing", async () => {
    for (const body of [page([]), { unexpected: true }, null, "not json"]) {
      const result = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch(body)));
      expect(result.observations).toEqual([]);
      expect(result.errors).toEqual([]);
    }
    expect(await learningRepository.listObservations()).toEqual([]);
  });

  it("ignores another project's observations when deciding stability", async () => {
    const rows = [strategyRow(), ordinaryRow(), thirdRow()];
    await ingestStrategyRollups({ projectId: "trk_other", from: WINDOW_1.from, to: WINDOW_1.to }, deps(jsonFetch(page(rows))));
    const second = await ingestStrategyRollups({ projectId: "trk_demo", from: WINDOW_2.from, to: WINDOW_2.to }, deps(jsonFetch(page(rows))));
    expect(second.promotion.promoted).toEqual([]);
  });
});

describe("stability over observed windows", () => {
  const sighting = (window: { from: string; to: string }, direction: "above" | "below", n: number) => ({
    strategy: "objection_first",
    intent: "objection_handling",
    metric: "p75_dwell_ms" as const,
    direction,
    n,
    window,
    finding: { metric: "p75_dwell_ms" as const, direction, value: 42000, siteFigure: 20000, ratio: direction === "above" ? 2.1 : 0.45 }
  });

  it("requires two windows ADJACENT in the observed sequence, in the same direction", () => {
    expect(stableStrategySignals([sighting(WINDOW_1, "above", 400)])).toEqual([]);
    expect(stableStrategySignals([sighting(WINDOW_1, "above", 400), sighting(WINDOW_2, "below", 400)])).toEqual([]);
    const stable = stableStrategySignals([sighting(WINDOW_1, "above", 400), sighting(WINDOW_2, "above", 424)]);
    expect(stable).toHaveLength(1);
    expect(stable[0]).toMatchObject({ direction: "above", windows: 2, n: 824, through: WINDOW_2.to });
  });

  it("counts adjacency in the sequence the project actually observed, so a missed day is not counter-evidence", () => {
    // Only WINDOW_1 and WINDOW_3 were ever observed: they are adjacent in THIS project's sequence.
    expect(stableStrategySignals([sighting(WINDOW_1, "above", 400), sighting(WINDOW_3, "above", 400)])).toHaveLength(1);
  });

  it("breaks the streak on a window below the n bar rather than counting it either way", () => {
    expect(stableStrategySignals([sighting(WINDOW_1, "above", 400), sighting(WINDOW_2, "above", 12), sighting(WINDOW_3, "above", 400)])).toEqual([]);
  });

  it("reports only the newest window's qualifying sightings as candidate contradictions", () => {
    const contradictions = contradictingStrategySightings([sighting(WINDOW_1, "above", 400), sighting(WINDOW_2, "below", 400)]);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.direction).toBe("below");
    expect(contradictingStrategySightings([sighting(WINDOW_1, "above", 400), sighting(WINDOW_2, "below", 12)])).toEqual([]);
  });
});

describe("strategySightingsFromObservations", () => {
  it("reads the structured metadata and skips anything that is not a well-formed entry", () => {
    const base = { id: "l1", observation: "text", createdAt: "2026-08-30T00:00:00.000Z" };
    const sightings = strategySightingsFromObservations([
      { ...base, metadata: { source: STRATEGY_OBSERVATION_SOURCE, projectId: "trk_demo", intent: "objection_handling", window: WINDOW_1, n: 412, findings: [{ metric: "p75_dwell_ms", direction: "above", value: 42000, siteFigure: 20000, ratio: 2.1 }] } },
      { ...base, id: "l2", metadata: { source: "something.else", intent: "x", window: WINDOW_1, n: 5, findings: [] } },
      { ...base, id: "l3", observation: "a hand-written note with no metadata at all" },
      { ...base, id: "l4", metadata: { source: STRATEGY_OBSERVATION_SOURCE, projectId: "trk_demo", intent: "y", window: WINDOW_1, n: 5, findings: [{ metric: "not_a_metric", direction: "above" }] } }
    ], "trk_demo");
    expect(sightings).toHaveLength(1);
    expect(sightings[0]).toMatchObject({ intent: "objection_handling", metric: "p75_dwell_ms", direction: "above", n: 412 });
  });
});

describe("promoteStrategySignals", () => {
  beforeEach(() => { learningRepository = fakeLearning(); improvementRepository = fakeImprovement(); });

  it("is a no-op with nothing stable and nothing contradicted", async () => {
    const outcome = await promoteStrategySignals([], { improvementRepository: improvementRepository });
    expect(outcome).toEqual({ promoted: [], reinforced: [], countered: [], errors: [] });
  });

  it("records, never throws, when a repository refuses one node's playbook", async () => {
    const real = improvementRepository;
    const failing = {
      getPlaybook: async (nodeId: string) => { if (nodeId === "draft_writer") throw new Error("blob unavailable"); return real.getPlaybook(nodeId); },
      savePlaybook: (playbook: NodePlaybook) => real.savePlaybook(playbook)
    } as unknown as ImprovementRepository;
    const sightings = [WINDOW_1, WINDOW_2].map((window) => ({
      strategy: "objection_first", intent: "objection_handling", metric: "p75_dwell_ms" as const, direction: "above" as const, n: 400, window,
      finding: { metric: "p75_dwell_ms" as const, direction: "above" as const, value: 42000, siteFigure: 20000, ratio: 2.1 }
    }));
    const outcome = await promoteStrategySignals(sightings, { improvementRepository: failing });
    expect(outcome.errors).toEqual([{ scope: "draft_writer", error: "blob unavailable" }]);
    expect(outcome.promoted.map((entry) => entry.nodeId)).not.toContain("draft_writer");
    expect([...new Set(outcome.promoted.map((entry) => entry.nodeId))]).toHaveLength(STRATEGY_PLAYBOOK_TARGET_NODES.length - 1);
  });
});

describe("the playbook item text", () => {
  it("is guidance first and evidence last, and its stable half is what a later window matches on", () => {
    const signal = {
      strategy: "objection_first", intent: "objection_handling", metric: "completion_rate" as const, direction: "above" as const,
      windows: 2, n: 824, through: "2026-08-31",
      latest: { metric: "completion_rate" as const, direction: "above" as const, value: 0.58, siteFigure: 0.4, ratio: 1.45, deltaPoints: 18 }
    };
    const text = renderStrategyPlaybookItem(signal);
    expect(text).toBe(
      "Reach for intent `objection_handling` (strategy `objection_first`) when the brief allows it — make the opening promise the one the piece actually keeps, and keep it in order — a reader who finishes is a reader who was never made to wait for it; it is read to the end 18 pts more often than the site typical. (tracking:strategy.v1, 2 consecutive windows through 2026-08-31, n=824.)"
    );
    expect(text.startsWith(strategyPlaybookItemPrefix(signal, "completion_rate", "above"))).toBe(true);
    // The stable half carries no measurement, so it survives windows in which the numbers move.
    expect(strategyPlaybookItemPrefix(signal, "completion_rate", "above")).not.toMatch(/\d/);
  });

  it("phrases a below-direction lesson as a pitfall against a different prefix", () => {
    const key = { strategy: "listicle", intent: "awareness" };
    expect(strategyPlaybookItemPrefix(key, "cta_ctr", "below").startsWith("Do not default to")).toBe(true);
    expect(strategyPlaybookItemPrefix(key, "cta_ctr", "below")).not.toBe(strategyPlaybookItemPrefix(key, "cta_ctr", "above"));
  });
});
