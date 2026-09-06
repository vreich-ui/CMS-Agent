import { beforeEach, describe, expect, it } from "vitest";
import {
  NO_SLACK_PATH_REASON,
  STRATEGY_OBJECT_ID_ENV,
  STRATEGY_OBJECT_PROJECT_ID_ENV,
  STRATEGY_OBJECT_TYPE_ENV,
  STRATEGY_REVIEW_AUTOPATCH_ENV,
  autopatchState,
  funnelStageOf,
  groupObjectRows,
  precedingWindow,
  reviewEditorialStrategy,
  rowEventCount,
  strategyObjectRefState,
  strategyReviewAutopatchEnabled,
  topAndBottomObjects,
  topicOf,
  type StrategyObjectRef
} from "../../../src/agent/improvement/strategyReview.js";
import { STRATEGY_OBSERVATION_SOURCE, STRATEGY_PROMOTION_MIN_N } from "../../../src/agent/improvement/strategyLearning.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
import type { LearningObservation } from "../../../src/agent/mcp/workspace/store.js";
import type { LearningRepository } from "../../../src/agent/repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// T21.37 editorial strategy review: the first outer loop whose output is addressed to a HUMAN. These
// tests pin the four things that make it safe to run weekly against a live tenant — the proposal
// carries its evidence inline, the stability bar is T21.35's unchanged, NOTHING but marginalia_create
// ever crosses the wire (flag on or off), and every empty or refused outcome is a named no-op rather
// than a throw. No live sink and no live tenant is touched; only env var NAMES appear here.

const PARTITION = "trk_demo";
const CURRENT = { from: "2026-08-24", to: "2026-08-31" };
const PRIOR = { from: "2026-08-17", to: "2026-08-24" };

const CONFIGURED_ENV = {
  [TRACKING_SINK_URL_ENV]: "https://sink.example/track",
  [TRACKING_SINK_TOKEN_ENV]: "test-token",
  [STRATEGY_OBJECT_PROJECT_ID_ENV]: "platform",
  [STRATEGY_OBJECT_TYPE_ENV]: "editorial_voice",
  [STRATEGY_OBJECT_ID_ENV]: "strategy_demo"
} as unknown as NodeJS.ProcessEnv;

// ── object-grain fixtures ────────────────────────────────────────────────────
// Two funnel stages, two topics, four published objects. `decision`/`retinoid_safety` converts far
// above the site middle and holds readers; `awareness`/`sunscreen_basics` sits far below it.
const objectRows = () => [
  { slug: "retinoid-purge", funnel_stage: "decision", topic: "retinoid_safety", n: 260, cta_ctr: 0.12, purchase_rate: 0.03, completion_rate: 0.6, p75_dwell_ms: 40000 },
  { slug: "retinoid-strength", funnel_stage: "decision", topic: "retinoid_safety", n: 150, cta_ctr: 0.1, purchase_rate: 0.02, completion_rate: 0.55, p75_dwell_ms: 36000 },
  { slug: "spf-myths", funnel_stage: "awareness", topic: "sunscreen_basics", n: 200, cta_ctr: 0.04, purchase_rate: 0.005, completion_rate: 0.4, p75_dwell_ms: 20000 },
  { slug: "uv-index", funnel_stage: "awareness", topic: "sunscreen_basics", n: 180, cta_ctr: 0.03, purchase_rate: 0.004, completion_rate: 0.38, p75_dwell_ms: 19000 }
];

type FetchPlan = { current?: unknown; prior?: unknown; status?: number };

// One fetch double for both windows, routed on the sink's own pinned `from` query param.
const rollupFetch = (plan: FetchPlan, urls: string[] = []): typeof fetch =>
  (async (input: unknown) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const isPrior = url.searchParams.get("from") === PRIOR.from;
    const status = plan.status ?? 200;
    const body = isPrior ? plan.prior ?? { rows: [] } : plan.current ?? { rows: [] };
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

// ── observation fixtures ─────────────────────────────────────────────────────
const observation = (id: string, window: { from: string; to: string }, n: number, overrides: Record<string, unknown> = {}): LearningObservation =>
  ({
    id,
    observation: `rendered sentence for ${id}`,
    createdAt: `${window.to}T00:00:00.000Z`,
    metadata: {
      source: STRATEGY_OBSERVATION_SOURCE,
      projectId: PARTITION,
      strategy: "objection_first",
      intent: "objection_handling",
      window,
      n,
      findings: [{ metric: "p75_dwell_ms", direction: "above", value: 42000, siteFigure: 20000, ratio: 2.1 }],
      ...overrides
    }
  }) as unknown as LearningObservation;

const STABLE_OBSERVATIONS = [observation("obs_prior", PRIOR, 412), observation("obs_current", CURRENT, 426)];

const fakeLearning = (observations: LearningObservation[]): LearningRepository =>
  ({ listObservations: async () => observations }) as unknown as LearningRepository;

const throwingLearning = (): LearningRepository =>
  ({ listObservations: async () => { throw new Error("store unavailable"); } }) as unknown as LearningRepository;

const fakeProjects = (): ProjectRepository => ({ get: async () => undefined }) as unknown as ProjectRepository;

type ToolCall = { ref: StrategyObjectRef; tool: string; args: Record<string, unknown> };

const recordingCall = (calls: ToolCall[], response: { ok: boolean; result?: unknown; error?: string } = { ok: true, result: { structuredContent: { thread: { thread_id: "thr_1" } } } }) =>
  async (ref: StrategyObjectRef, tool: string, args: Record<string, unknown>) => {
    calls.push({ ref, tool, args });
    return response;
  };

const review = (options: { env?: NodeJS.ProcessEnv; observations?: LearningObservation[]; plan?: FetchPlan; calls?: ToolCall[]; learning?: LearningRepository; notify?: () => void; urls?: string[] } = {}) =>
  reviewEditorialStrategy(
    { projectId: PARTITION, from: CURRENT.from, to: CURRENT.to },
    {
      env: options.env ?? CONFIGURED_ENV,
      fetchImpl: rollupFetch(options.plan ?? { current: { rows: objectRows() }, prior: { rows: objectRows() } }, options.urls ?? []),
      learningRepository: options.learning ?? fakeLearning(options.observations ?? STABLE_OBSERVATIONS),
      projectRepository: fakeProjects(),
      callProjectTool: recordingCall(options.calls ?? []),
      ...(options.notify ? { notify: options.notify } : {})
    }
  );

// ── pure readers ─────────────────────────────────────────────────────────────

describe("object-grain readers", () => {
  it("reads the stage, topic and event count in any spelling, and never invents one", () => {
    expect(funnelStageOf({ funnelStage: "decision" })).toBe("decision");
    expect(funnelStageOf({ object: { stage: "awareness" } })).toBe("awareness");
    expect(funnelStageOf({ slug: "x" })).toBeUndefined();
    expect(topicOf({ primary_topic: "retinoid_safety" })).toBe("retinoid_safety");
    expect(topicOf({})).toBeUndefined();
    expect(rowEventCount({ n: "412" })).toBe(412);
    expect(rowEventCount({ event_count: 12 })).toBe(12);
  });

  it("refuses sessions as a substitute for the attributed-event count the bar is stated in", () => {
    expect(rowEventCount({ sessions: 5000 })).toBe(0);
  });

  it("groups rows with n-weighted rates and never zero-fills a metric nobody reported", () => {
    const groups = groupObjectRows(objectRows(), funnelStageOf);
    const decision = groups.get("decision")!;
    expect(decision.n).toBe(410);
    expect(decision.days).toBe(2);
    expect(decision.metrics.cta_ctr).toBeCloseTo((0.12 * 260 + 0.1 * 150) / 410, 6);
    expect(decision.metrics.revenue_cents).toBeUndefined();
    expect(groups.has("unknown")).toBe(false);
  });

  it("names the top and bottom object inside a stage, with each one's own n", () => {
    const ranked = topAndBottomObjects(objectRows(), funnelStageOf, "decision", "purchase_rate");
    expect(ranked.top).toMatchObject({ label: "retinoid-purge", value: 0.03, n: 260 });
    expect(ranked.bottom).toMatchObject({ label: "retinoid-strength", value: 0.02, n: 150 });
    expect(ranked.ranked).toBe(2);
  });

  it("derives the preceding window of equal length, and none from an unusable one", () => {
    expect(precedingWindow(CURRENT)).toEqual(PRIOR);
    expect(precedingWindow({ from: "2026-08-31", to: "2026-08-31" })).toBeUndefined();
  });
});

// ── the policy flag ──────────────────────────────────────────────────────────

describe("the autonomous-patch policy flag", () => {
  it("is off when unset, and says so by name", () => {
    expect(strategyReviewAutopatchEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    const state = autopatchState({} as NodeJS.ProcessEnv);
    expect(state).toMatchObject({ flag: STRATEGY_REVIEW_AUTOPATCH_ENV, enabled: false, applied: false });
    expect(state.reason).toContain("proposal");
  });

  it("reads as on when an operator sets it — and still applies nothing, because no patch path exists", () => {
    const env = { [STRATEGY_REVIEW_AUTOPATCH_ENV]: "true" } as unknown as NodeJS.ProcessEnv;
    expect(strategyReviewAutopatchEnabled(env)).toBe(true);
    expect(autopatchState(env)).toMatchObject({ enabled: true, applied: false });
  });
});

describe("the strategy object address", () => {
  it("names every unset variable rather than guessing an object", () => {
    const state = strategyObjectRefState({} as NodeJS.ProcessEnv);
    expect(state.configured).toBe(false);
    expect(state.missing).toEqual([STRATEGY_OBJECT_PROJECT_ID_ENV, STRATEGY_OBJECT_TYPE_ENV, STRATEGY_OBJECT_ID_ENV]);
    expect(state.ref).toBeUndefined();
  });
});

// ── above the bar: a proposal with inline evidence ───────────────────────────

describe("reviewEditorialStrategy above the bar", () => {
  let calls: ToolCall[];
  beforeEach(() => { calls = []; });

  it("proposes a delta across all three dimensions and writes it as ONE marginalia thread", async () => {
    const result = await review({ calls });
    expect(result.status).toBe("proposed");
    expect(result.reason).toBeUndefined();
    expect(result.delta.angleMix).toHaveLength(1);
    // biggest gap first, on the same |log ratio| ordering the rest of the loop sorts by
    expect(result.delta.topicWeights.map((line) => [line.subject, line.direction])).toEqual([
      ["sunscreen_basics", "decrease"],
      ["retinoid_safety", "increase"]
    ]);
    expect(result.delta.funnelAggression.map((line) => [line.subject, line.direction])).toEqual([
      ["awareness", "decrease"],
      ["decision", "increase"]
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("marginalia_create");
    expect(calls[0]!.args).toMatchObject({ object_type: "editorial_voice", object_id: "strategy_demo" });
    expect(result.marginalia).toMatchObject({ attempted: true, ok: true, threadId: "thr_1" });
  });

  it("carries the evidence INLINE: which observations, which windows, which n", async () => {
    const result = await review({ calls });
    const body = String(calls[0]!.args.body);
    expect(body).toBe(result.proposalText);

    // the angle-mix line cites the exact observation entries and the streak they came from
    expect(body).toContain("Observations: obs_prior, obs_current");
    expect(body).toContain(STRATEGY_OBSERVATION_SOURCE);
    expect(body).toContain("2 consecutive observed windows, n=838");

    // the object-grain lines cite BOTH windows, the ratio, and each window's own n
    expect(body).toContain("2026-08-24..2026-08-31");
    expect(body).toContain("2026-08-17..2026-08-24");
    expect(body).toContain("n=410");

    // ...and the top and bottom content inside the stage, by name
    expect(body).toContain("Top content in this funnel stage this window: retinoid-purge");
    expect(body).toContain("Bottom: retinoid-strength");

    // ...and what the bar was, and that nothing was changed
    expect(body).toContain(`n>=${STRATEGY_PROMOTION_MIN_N}`);
    expect(body).toContain("nothing has been changed");
    expect(body).toContain("TOPIC WEIGHTS");
    expect(body).toContain("ANGLE MIX");
    expect(body).toContain("FUNNEL-STAGE AGGRESSION");
  });

  it("lists what was seen and did not clear the bar, with the number that failed it", async () => {
    const result = await review({
      calls,
      observations: [...STABLE_OBSERVATIONS, observation("obs_thin", CURRENT, 40, { intent: "quick_take", strategy: "listicle" })]
    });
    expect(result.status).toBe("proposed");
    expect(result.belowBar.some((note) => note.dimension === "angle_mix" && note.reason.includes("n=40"))).toBe(true);
    expect(String(calls[0]!.args.body)).toContain("Not proposed (seen, below the bar)");
  });

  it("never reaches a patch verb — with the policy flag off OR on, marginalia_create is the only call", async () => {
    await review({ calls });
    const withFlag: ToolCall[] = [];
    const result = await review({ calls: withFlag, env: { ...CONFIGURED_ENV, [STRATEGY_REVIEW_AUTOPATCH_ENV]: "true" } as unknown as NodeJS.ProcessEnv });
    expect([...calls, ...withFlag].map((call) => call.tool)).toEqual(["marginalia_create", "marginalia_create"]);
    expect(result.autopatch).toMatchObject({ flag: STRATEGY_REVIEW_AUTOPATCH_ENV, enabled: true, applied: false });
    expect(result.status).toBe("proposed");
  });

  it("succeeds with no Slack path at all, and says that is why nothing was announced", async () => {
    const result = await review({ calls });
    expect(result.status).toBe("proposed");
    expect(result.notification).toEqual({ attempted: false, delivered: false, reason: NO_SLACK_PATH_REASON });
  });

  it("uses a notifier when a deployment supplies one, and survives one that throws", async () => {
    const seen: string[] = [];
    const announced = await review({ calls, notify: ((message: { text: string }) => { seen.push(message.text); }) as unknown as () => void });
    expect(announced.notification).toMatchObject({ attempted: true, delivered: true });
    expect(seen[0]).toContain("Editorial strategy review");

    const failed = await review({ calls: [], notify: (() => { throw new Error("slack down"); }) as unknown as () => void });
    expect(failed.status).toBe("proposed");
    expect(failed.notification).toMatchObject({ attempted: true, delivered: false });
  });
});

// ── below the bar, and every other way to produce nothing ────────────────────

describe("reviewEditorialStrategy below the bar", () => {
  it("produces NO proposal and names the reason when nothing held two windows at n>=100", async () => {
    const calls: ToolCall[] = [];
    const result = await review({
      calls,
      observations: [observation("obs_thin", CURRENT, 40)],
      plan: { current: { rows: objectRows() }, prior: { rows: [] } }
    });
    expect(result.status).toBe("no_proposal");
    expect(result.reason).toBe("below_stability_bar");
    expect(result.detail).toContain("2 consecutive windows");
    expect(result.detail).toContain("n>=100");
    expect(result.belowBar.length).toBeGreaterThan(0);
    expect(result.proposalText).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("does not promote a single strong window on its own", async () => {
    const calls: ToolCall[] = [];
    const result = await review({ calls, observations: [observation("obs_current", CURRENT, 426)], plan: { current: { rows: objectRows() }, prior: { rows: [] } } });
    expect(result.status).toBe("no_proposal");
    expect(result.delta.angleMix).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("no-ops with a named reason when the tracking sink is unconfigured", async () => {
    const result = await review({ env: { [STRATEGY_OBJECT_PROJECT_ID_ENV]: "platform", [STRATEGY_OBJECT_TYPE_ENV]: "editorial_voice", [STRATEGY_OBJECT_ID_ENV]: "s" } as unknown as NodeJS.ProcessEnv });
    expect(result).toMatchObject({ status: "no_proposal", reason: "sink_unconfigured" });
    expect(result.detail).toContain(TRACKING_SINK_URL_ENV);
  });

  it("no-ops with a named reason when no governed strategy object is configured", async () => {
    const result = await review({ env: { [TRACKING_SINK_URL_ENV]: "https://sink.example", [TRACKING_SINK_TOKEN_ENV]: "t" } as unknown as NodeJS.ProcessEnv });
    expect(result).toMatchObject({ status: "no_proposal", reason: "no_strategy_object" });
    expect(result.detail).toContain(STRATEGY_OBJECT_ID_ENV);
  });

  it("no-ops with a named reason when the sink's grain is not deployed here yet (503)", async () => {
    const result = await review({ plan: { status: 503 } });
    expect(result).toMatchObject({ status: "no_proposal", reason: "grain_unavailable" });
  });

  it("no-ops with a named reason when there is nothing recorded and nothing in the window", async () => {
    const result = await review({ observations: [], plan: { current: { rows: [] }, prior: { rows: [] } } });
    expect(result).toMatchObject({ status: "no_proposal", reason: "no_rows" });
    expect(result.detail).toContain(PARTITION);
  });

  it("does not throw when the observation store refuses to answer", async () => {
    const result = await review({ learning: throwingLearning(), plan: { current: { rows: [] }, prior: { rows: [] } } });
    expect(result.status).toBe("no_proposal");
    expect(result.errors.some((entry) => entry.scope === "observations")).toBe(true);
  });
});

// ── a refused write is a clean no-op ─────────────────────────────────────────

describe("reviewEditorialStrategy when the proposal cannot be written", () => {
  it("reports marginalia_write_failed, keeps the delta, and touches nothing else", async () => {
    const calls: ToolCall[] = [];
    const result = await reviewEditorialStrategy(
      { projectId: PARTITION, from: CURRENT.from, to: CURRENT.to },
      {
        env: CONFIGURED_ENV,
        fetchImpl: rollupFetch({ current: { rows: objectRows() }, prior: { rows: objectRows() } }),
        learningRepository: fakeLearning(STABLE_OBSERVATIONS),
        projectRepository: fakeProjects(),
        callProjectTool: recordingCall(calls, { ok: false, error: "client_unreachable (TypeError)" })
      }
    );
    expect(result.status).toBe("no_proposal");
    expect(result.reason).toBe("marginalia_write_failed");
    expect(result.detail).toContain("client_unreachable");
    expect(result.marginalia).toMatchObject({ attempted: true, ok: false });
    expect(result.proposalText).toBeTruthy();
    expect(result.delta.angleMix).toHaveLength(1);
    expect(calls.map((call) => call.tool)).toEqual(["marginalia_create"]);
  });

  it("treats a tenant REFUSAL (transport ok, isError result) as a failed write, quoting the client", async () => {
    const calls: ToolCall[] = [];
    const result = await reviewEditorialStrategy(
      { projectId: PARTITION, from: CURRENT.from, to: CURRENT.to },
      {
        env: CONFIGURED_ENV,
        fetchImpl: rollupFetch({ current: { rows: objectRows() }, prior: { rows: objectRows() } }),
        learningRepository: fakeLearning(STABLE_OBSERVATIONS),
        projectRepository: fakeProjects(),
        callProjectTool: recordingCall(calls, { ok: true, result: { isError: true, structuredContent: { statusCode: 404, error: "object not found" } } })
      }
    );
    expect(result.reason).toBe("marginalia_write_failed");
    expect(result.marginalia?.error).toContain("client_refused");
    expect(result.marginalia?.error).toContain("object not found");
  });

  it("does not throw when the tool transport itself throws", async () => {
    const result = await reviewEditorialStrategy(
      { projectId: PARTITION, from: CURRENT.from, to: CURRENT.to },
      {
        env: CONFIGURED_ENV,
        fetchImpl: rollupFetch({ current: { rows: objectRows() }, prior: { rows: objectRows() } }),
        learningRepository: fakeLearning(STABLE_OBSERVATIONS),
        projectRepository: fakeProjects(),
        callProjectTool: async () => { throw new Error("boom"); }
      }
    );
    expect(result.reason).toBe("marginalia_write_failed");
    expect(result.marginalia?.error).toContain("boom");
  });
});
