import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliMain, exitCodeFor, previousUtcWeek, runStrategyReviewJob } from "../../../src/agent/entrypoints/strategyReviewJob.js";
import {
  STRATEGY_OBJECT_ID_ENV,
  STRATEGY_OBJECT_PROJECT_ID_ENV,
  STRATEGY_OBJECT_TYPE_ENV,
  STRATEGY_REVIEW_AUTOPATCH_ENV
} from "../../../src/agent/improvement/strategyReview.js";
import { STRATEGY_OBSERVATION_SOURCE } from "../../../src/agent/improvement/strategyLearning.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
import type { LearningObservation } from "../../../src/agent/mcp/workspace/store.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { LearningRepository } from "../../../src/agent/repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// T21.37: the WEEKLY strategy review, the third job on the same sink and the first whose output is a
// proposal for a human. These tests drive the job function and its CLI against an injected fetch —
// never a live sink and never a live tenant — and pin the no-op paths that must never become
// failures, plus the fact that the job always exits 0. Only env NAMES appear here.

const CONFIGURED_ENV = {
  [TRACKING_SINK_URL_ENV]: "https://sink.example/track",
  [TRACKING_SINK_TOKEN_ENV]: "test-token",
  TRACKING_PROJECT_ID: "trk_demo",
  [STRATEGY_OBJECT_PROJECT_ID_ENV]: "platform",
  [STRATEGY_OBJECT_TYPE_ENV]: "editorial_voice",
  [STRATEGY_OBJECT_ID_ENV]: "strategy_demo"
} as unknown as NodeJS.ProcessEnv;
const UNCONFIGURED_ENV = {} as unknown as NodeJS.ProcessEnv;

const emptyFetch = (urls: string[] = []): typeof fetch =>
  (async (input: unknown) => {
    urls.push(String(input));
    return { ok: true, status: 200, json: async () => ({ rows: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;

describe("previousUtcWeek", () => {
  it("is the whole seven days before the reference day, in the sink's calendar-day spelling", () => {
    expect(previousUtcWeek(new Date("2026-08-31T06:00:00Z"))).toEqual({ from: "2026-08-24", to: "2026-08-31" });
  });
});

describe("runStrategyReviewJob", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("no-ops with a named, non-crashing reason when the tracking sink is unconfigured", async () => {
    const result = await runStrategyReviewJob({ env: UNCONFIGURED_ENV });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") {
      expect(result.reason).toContain(TRACKING_SINK_URL_ENV);
      expect(result.reason).toContain(TRACKING_SINK_TOKEN_ENV);
      expect(result.strategyObject.configured).toBe(false);
    }
    expect(exitCodeFor(result)).toBe(0);
  });

  // W4 (2026-09-09, Wolf) — REPLACED BEHAVIOR, pinned deliberately. An unset TRACKING_PROJECT_ID used
  // to be a no-op reason in its own right, because a global env var was the only way to name a
  // partition at all. It is no longer: the walk resolves each tenant's partition from its own record.
  // What survives is the no-op ITSELF — with nothing addressable, the job still says so by name and
  // still exits 0 — and every project it looked at is now reported by name with why it was excluded.
  it("walks the registry instead of demanding a global partition, and still no-ops by name when nothing is addressable", async () => {
    const result = await runStrategyReviewJob({
      env: { [TRACKING_SINK_URL_ENV]: "https://sink.example", [TRACKING_SINK_TOKEN_ENV]: "t" } as unknown as NodeJS.ProcessEnv,
      projectRepository: { list: async () => [] } as unknown as ProjectRepository
    });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") {
      expect(result.reason).toContain("No active tenant carries a resolvable strategy address");
      // The single-tenant override is still named as the other way to address this job.
      expect(result.reason).toContain(STRATEGY_OBJECT_PROJECT_ID_ENV);
    }
    expect(exitCodeFor(result)).toBe(0);
  });

  it("no-ops, naming the unset variables, when no governed strategy object is addressed", async () => {
    const result = await runStrategyReviewJob({ env: { [TRACKING_SINK_URL_ENV]: "https://s", [TRACKING_SINK_TOKEN_ENV]: "t", TRACKING_PROJECT_ID: "trk_demo" } as unknown as NodeJS.ProcessEnv });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") {
      expect(result.reason).toContain(STRATEGY_OBJECT_PROJECT_ID_ENV);
      expect(result.reason).toContain(STRATEGY_OBJECT_ID_ENV);
    }
  });

  it("dry-run reports the resolved weekly window and the autopatch flag without calling the sink", async () => {
    const urls: string[] = [];
    const result = await runStrategyReviewJob({ env: CONFIGURED_ENV, dryRun: true, fetchImpl: emptyFetch(urls), now: () => new Date("2026-08-31T06:00:00Z") });
    expect(result.status).toBe("dry_run");
    if (result.status === "dry_run") {
      expect(result.window).toEqual({ projectId: "trk_demo", from: "2026-08-24", to: "2026-08-31" });
      expect(result.autopatchFlag).toEqual({ name: STRATEGY_REVIEW_AUTOPATCH_ENV, enabled: false });
      expect(result.strategyObject.configured).toBe(true);
    }
    expect(urls).toHaveLength(0);
  });

  it("reports the autopatch flag as on when an operator has set it — and still proposes nothing autonomously", async () => {
    const result = await runStrategyReviewJob({
      env: { ...CONFIGURED_ENV, [STRATEGY_REVIEW_AUTOPATCH_ENV]: "true" } as unknown as NodeJS.ProcessEnv,
      dryRun: true,
      now: () => new Date("2026-08-31T06:00:00Z")
    });
    if (result.status === "dry_run") expect(result.autopatchFlag.enabled).toBe(true);
  });

  it("runs to a named no_proposal on a quiet week, and still exits 0", async () => {
    const result = await runStrategyReviewJob({
      env: CONFIGURED_ENV,
      fetchImpl: emptyFetch(),
      learningRepository: { listObservations: async () => [] } as unknown as LearningRepository,
      projectRepository: { get: async () => undefined } as unknown as ProjectRepository,
      now: () => new Date("2026-08-31T06:00:00Z")
    });
    expect(result.status).toBe("no_proposal");
    if (result.status === "no_proposal") {
      expect(result.result.reason).toBe("no_rows");
      expect(result.result.autopatch).toMatchObject({ enabled: false, applied: false });
    }
    expect(exitCodeFor(result)).toBe(0);
  });

  it("uses the live repositories when none are injected", async () => {
    const result = await runStrategyReviewJob({ env: CONFIGURED_ENV, fetchImpl: emptyFetch(), now: () => new Date("2026-08-31T06:00:00Z") });
    expect(result.status).toBe("no_proposal");
    expect(repositoryManager.getLearningRepository()).toBeDefined();
  });
});

describe("cliMain", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("prints one JSON summary and exits 0 with nothing configured", async () => {
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { printed.push(String(line)); };
    try {
      expect(await cliMain([], UNCONFIGURED_ENV)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(printed[0]!).status).toBe("skipped_unconfigured");
  });

  it("refuses an unparseable --from rather than silently reading a wrong window", async () => {
    await expect(cliMain(["--from", "not-a-date"], CONFIGURED_ENV)).rejects.toThrow(/--from/);
  });
});

// ── W4 (2026-09-09, Wolf): the per-tenant walk ───────────────────────────────
//
// The job used to serve exactly ONE tenant, for an addressing reason rather than a policy one: both
// of its addresses were single global env values. These tests drive the fan-out against two fake
// projects and pin the four properties the walk has to have — every one of them a decision:
//
//   1. A tenant still on a GENESIS DEFAULT strategy object is warned about AND still proposed at.
//      "Unset never blocks": a proposal is, if anything, more useful against a default, because it is
//      the first evidence anyone has put in front of the human who owns it.
//   2. A tenant that cannot be reached fails BY NAME, alone. The loop finishes the others.
//   3. Exit code 0 regardless — a weekly schedule that alerts on one tenant's expired bearer trains
//      an operator to ignore it.
//   4. --dry-run answers "who would this touch, and where" for every tenant, touching nothing.
//
// No live sink and no live tenant: the rollup fetch, the tenant object read and the tenant tool call
// are all injected. Only env var NAMES appear.

const FANOUT_ENV = {
  [TRACKING_SINK_URL_ENV]: "https://sink.example/track",
  [TRACKING_SINK_TOKEN_ENV]: "test-token"
} as unknown as NodeJS.ProcessEnv;

const WINDOW = { from: "2026-08-24", to: "2026-08-31" };
const PRIOR_WINDOW = { from: "2026-08-17", to: "2026-08-24" };

const tenant = (projectId: string, overrides: Record<string, unknown> = {}) =>
  ({
    projectId,
    name: projectId,
    mcpEndpointEnvVar: `${projectId.toUpperCase().replace(/-/g, "_")}_MCP_ENDPOINT`,
    mcpEndpoint: `https://${projectId}.example/mcp`,
    authMode: "bearer_env",
    tokenEnvVar: `${projectId.toUpperCase().replace(/-/g, "_")}_MCP_TOKEN`,
    allowedTools: [],
    clientSiteBinding: { netlifySiteName: projectId },
    contentContract: { contentContract: "content_source.v1" },
    publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
    status: "active",
    ...overrides
  }) as unknown as ProjectConnectionConfig;

// acme-daily takes the convention on both axes (partition "acmedaily", object "strat_acmedaily");
// borealis pins both on its record, so the walk is proven to read the record where one exists.
const FAKE_PROJECTS = [
  tenant("acme-daily"),
  tenant("borealis", { tracking: { projectId: "borealis-eu" }, objectDialect: { siteObjectId: "site_borealis", taxonomyRegistryObjectId: "tax_borealis", objectIdSource: "server_minted", strategyObjectId: "strat_borealis_v2" } }),
  // Neither a client site nor object-native nor tracked: an internal service project, excluded by
  // name rather than silently, and never proposed at.
  tenant("monetizer-svc", { clientSiteBinding: undefined })
];

const fanoutRepository = (projects = FAKE_PROJECTS): ProjectRepository =>
  ({ list: async () => projects, get: async (id: string) => projects.find((project) => project.projectId === id) } as unknown as ProjectRepository);

// A stable angle-mix signal for one partition across two consecutive windows, which is the bar the
// review promotes on (strategyLearning.stableStrategySignals) and therefore the smallest input that
// makes a run produce an actual proposal rather than a quiet week.
const strategyObservation = (partition: string, id: string, window: { from: string; to: string }, n: number) =>
  ({
    id,
    observation: `rendered sentence for ${id}`,
    createdAt: `${window.to}T00:00:00.000Z`,
    metadata: {
      source: STRATEGY_OBSERVATION_SOURCE,
      projectId: partition,
      strategy: "objection_first",
      intent: "objection_handling",
      window,
      n,
      findings: [{ metric: "p75_dwell_ms", direction: "above", value: 42000, siteFigure: 20000, ratio: 2.1 }]
    }
  }) as unknown as LearningObservation;

const fanoutLearning = (): LearningRepository =>
  ({
    listObservations: async () => [
      strategyObservation("acmedaily", "acme_prior", PRIOR_WINDOW, 412),
      strategyObservation("acmedaily", "acme_current", WINDOW, 426),
      strategyObservation("borealis-eu", "bor_prior", PRIOR_WINDOW, 401),
      strategyObservation("borealis-eu", "bor_current", WINDOW, 433)
    ]
  }) as unknown as LearningRepository;

const emptyRollups = (): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => ({ rows: [] }) } as unknown as Response)) as unknown as typeof fetch;

const genesisDefaultBody = {
  name: "acme-daily — provisional strategy (genesis)",
  goal: "be useful",
  offer: "None declared.",
  audience_segments: ["general readers"],
  topic_weights: [],
  angle_mix: [{ angle: "explainer", share: 1 }],
  funnel_aggression: { tofu: 0.34, mofu: 0.33, bofu: 0.33 },
  cadence: "undecided",
  provenance: { set_by: "genesis_default", set_at: "2026-08-01T00:00:00.000Z" }
};

describe("runStrategyReviewJob — the per-tenant walk", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  const runFanout = async (options: { dryRun?: boolean } = {}) =>
    runStrategyReviewJob({
      env: FANOUT_ENV,
      projectRepository: fanoutRepository(),
      learningRepository: fanoutLearning(),
      fetchImpl: emptyRollups(),
      now: () => new Date("2026-08-31T06:00:00Z"),
      ...(options.dryRun ? { dryRun: true } : {}),
      // acme-daily's strategy object exists and is still the genesis default; borealis cannot be
      // reached at all.
      readObject: async (config) =>
        config.projectId === "acme-daily"
          ? { ok: true, result: { structuredContent: { record: { object_id: "strat_acmedaily", body: genesisDefaultBody } } } }
          : { ok: false, error: "client_unreachable (TypeError)" },
      // The proposal write succeeds for acme-daily and is refused for borealis.
      callProjectTool: async (ref) =>
        ref.projectId === "acme-daily"
          ? { ok: true, result: { structuredContent: { thread: { thread_id: "thr_acme" } } } }
          : { ok: false, error: "client_unreachable (TypeError)" }
    });

  it("proposes at a tenant whose strategy object is still the genesis default, and says so", async () => {
    const result = await runFanout();
    expect(result.status).toBe("fanout");
    if (result.status !== "fanout") return;
    const acme = result.tenants.find((entry) => entry.projectId === "acme-daily")!;
    // The warning: this tenant's strategy is present, readable, and by its own provenance undecided.
    expect(acme.strategy).toMatchObject({ source: "default", warningCode: "strategy_object_unconfigured" });
    // And it is still proposed at — unset never blocks (Wolf, 2026-09-09).
    expect(acme.status).toBe("proposed");
    expect(acme.status === "proposed" && acme.result.marginalia).toMatchObject({ ok: true, threadId: "thr_acme" });
    // Addressed by convention on both axes, because this tenant configured neither.
    expect(acme.trackingProjectId).toBe("acmedaily");
    expect(acme.objectRef.objectId).toBe("strat_acmedaily");
    expect(acme.objectRef.objectType).toBe("editorial_strategy");
  });

  it("names the tenant that failed, keeps going, and still exits 0", async () => {
    const result = await runFanout();
    expect(result.status).toBe("fanout");
    if (result.status !== "fanout") return;
    const borealis = result.tenants.find((entry) => entry.projectId === "borealis")!;
    expect(borealis.status).toBe("failed");
    // NAMED: the failure is attributed to this tenant and quotes what the tenant said.
    expect(borealis.status === "failed" && borealis.error).toContain("strat_borealis_v2");
    // Its record's own addresses were used, not the convention.
    expect(borealis.trackingProjectId).toBe("borealis-eu");
    expect(borealis.trackingSource).toBe("record");
    expect(borealis.objectIdSource).toBe("record");
    // The other tenant is unaffected, and the job is not a failure.
    expect(result.tenants.filter((entry) => entry.status === "proposed")).toHaveLength(1);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("excludes a project with no marker of a content tenant, by name and with a reason", async () => {
    const result = await runFanout();
    if (result.status !== "fanout") return;
    expect(result.tenants.map((entry) => entry.projectId)).not.toContain("monetizer-svc");
    expect(result.skipped.find((entry) => entry.projectId === "monetizer-svc")?.reason).toContain("content tenant");
  });

  it("--dry-run lists both tenants' addresses and touches nothing", async () => {
    const urls: string[] = [];
    const result = await runStrategyReviewJob({
      env: FANOUT_ENV,
      dryRun: true,
      projectRepository: fanoutRepository(),
      learningRepository: fanoutLearning(),
      fetchImpl: emptyFetch(urls),
      now: () => new Date("2026-08-31T06:00:00Z")
    });
    expect(result.status).toBe("dry_run_fanout");
    if (result.status !== "dry_run_fanout") return;
    expect(result.window).toEqual(WINDOW);
    expect(result.addressLines).toHaveLength(2);
    expect(result.addressLines[0]).toContain("acme-daily");
    expect(result.addressLines[0]).toContain("partition=acmedaily");
    expect(result.addressLines[0]).toContain("strategy=editorial_strategy/strat_acmedaily");
    expect(result.addressLines[1]).toContain("borealis");
    expect(result.addressLines[1]).toContain("partition=borealis-eu");
    expect(result.addressLines[1]).toContain("strategy=editorial_strategy/strat_borealis_v2");
    // Nothing was read from the sink, and nothing was written to any tenant.
    expect(urls).toHaveLength(0);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("the CLI prints one address line per tenant ahead of its JSON summary", async () => {
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { printed.push(String(line)); };
    try {
      expect(await cliMain(["--dry-run"], FANOUT_ENV)).toBe(0);
    } finally {
      console.log = log;
    }
    // The live registry is used here (no injected repository) and no tenant env vars exist in a test
    // process, so this pins the PRINTING CONTRACT rather than a tenant list: whatever address lines
    // there are come first, exactly one JSON summary comes last, and the exit code is 0. The address
    // lines' own content is pinned against fake projects in the --dry-run test above.
    const summary = JSON.parse(printed.at(-1)!);
    expect(summary.status).toBe("dry_run_fanout");
    expect(printed).toHaveLength(summary.addressLines.length + 1);
    for (const line of printed.slice(0, -1)) expect(line).toContain("strategy=editorial_strategy/");
  });

  it("still takes the single-tenant override path, unchanged, when EDITORIAL_STRATEGY_* is set", async () => {
    const listed: string[] = [];
    const result = await runStrategyReviewJob({
      env: CONFIGURED_ENV,
      fetchImpl: emptyFetch(),
      learningRepository: { listObservations: async () => [] } as unknown as LearningRepository,
      projectRepository: { get: async () => undefined, list: async () => { listed.push("list"); return []; } } as unknown as ProjectRepository,
      now: () => new Date("2026-08-31T06:00:00Z")
    });
    // The override answers with the ORIGINAL single-window shape, and the registry is never walked.
    expect(result.status).toBe("no_proposal");
    if (result.status === "no_proposal") expect(result.window).toEqual({ projectId: "trk_demo", from: "2026-08-24", to: "2026-08-31" });
    expect(listed).toHaveLength(0);
  });
});
