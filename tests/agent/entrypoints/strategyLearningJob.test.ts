import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliMain, exitCodeFor, runStrategyLearningJob } from "../../../src/agent/entrypoints/strategyLearningJob.js";
import { STRATEGY_PLAYBOOK_TARGET_NODES } from "../../../src/agent/improvement/strategyLearning.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// T21.35: the daily strategy-learning pass, the sibling of job:tracking-ingest on the same sink. These
// tests drive the job function and its CLI directly against an injected fetch — never a live sink —
// and pin the three no-op paths that must never become failures: an unconfigured sink, no partition,
// and a `by=strategy` grain the sink does not serve yet. Only env NAMES appear.
//
// Since kugel-data migration 012 the grain exists, which makes a FOURTH state
// worth telling apart: rows served with every label NULL (KI-08). That is exit 0
// and not a failure, but it is not a quiet week either.

const CONFIGURED_ENV = {
  [TRACKING_SINK_URL_ENV]: "https://sink.example/track",
  [TRACKING_SINK_TOKEN_ENV]: "test-token",
  TRACKING_PROJECT_ID: "trk_demo"
} as unknown as NodeJS.ProcessEnv;
const UNCONFIGURED_ENV = {} as unknown as NodeJS.ProcessEnv;

const jsonFetch = (body: unknown, status = 200, urls: string[] = []): typeof fetch =>
  (async (input: unknown) => {
    urls.push(String(input));
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

const rows = () => ({
  rows: [
    { strategy: "objection_first", intent: "objection_handling", day: "2026-08-30", n: 412, completion_rate: 0.58, cta_ctr: 0.09, buy_click_rate: 0.04, purchase_rate: 0.012, p75_dwell_ms: 42000 },
    { strategy: "listicle", intent: "awareness", day: "2026-08-30", n: 300, completion_rate: 0.4, cta_ctr: 0.05, buy_click_rate: 0.02, purchase_rate: 0.006, p75_dwell_ms: 20000 },
    { strategy: "how_to", intent: "education", day: "2026-08-30", n: 280, completion_rate: 0.4, cta_ctr: 0.05, buy_click_rate: 0.02, purchase_rate: 0.006, p75_dwell_ms: 20000 }
  ]
});

describe("runStrategyLearningJob", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("no-ops with a named, non-crashing reason when the tracking sink is unconfigured", async () => {
    const result = await runStrategyLearningJob({ env: UNCONFIGURED_ENV });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") {
      expect(result.reason).toContain(TRACKING_SINK_URL_ENV);
      expect(result.reason).toContain(TRACKING_SINK_TOKEN_ENV);
      expect(result.connection.urlConfigured).toBe(false);
    }
    expect(exitCodeFor(result)).toBe(0);
  });

  it("no-ops when the sink is configured but no tracking partition is named", async () => {
    const result = await runStrategyLearningJob({ env: { [TRACKING_SINK_URL_ENV]: "https://sink.example", [TRACKING_SINK_TOKEN_ENV]: "t" } as unknown as NodeJS.ProcessEnv });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") expect(result.reason).toContain("TRACKING_PROJECT_ID");
  });

  it("dry-run reports the resolved window and the target nodes without calling the sink or writing anything", async () => {
    const urls: string[] = [];
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, dryRun: true, fetchImpl: jsonFetch(rows(), 200, urls), now: () => new Date("2026-08-31T06:00:00Z") });
    expect(result.status).toBe("dry_run");
    if (result.status === "dry_run") {
      expect(result.window).toEqual({ projectId: "trk_demo", from: "2026-08-30", to: "2026-08-31" });
      expect(result.targetNodes).toEqual([...STRATEGY_PLAYBOOK_TARGET_NODES]);
    }
    expect(urls).toEqual([]);
    expect(await repositoryManager.getLearningRepository().listObservations()).toEqual([]);
  });

  it("defaults to the previous whole UTC day and records the window's observations", async () => {
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch(rows()), now: () => new Date("2026-08-31T06:00:00Z") });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.window).toEqual({ projectId: "trk_demo", from: "2026-08-30", to: "2026-08-31" });
      expect(result.result.rows).toBe(3);
      expect(result.result.observations).toHaveLength(1);
      expect(result.result.observations[0]!.observation).toContain("window 2026-08-30..2026-08-31");
      // One window is never enough to teach a node anything.
      expect(result.result.promotion.promoted).toEqual([]);
    }
    const stored = await repositoryManager.getLearningRepository().listObservations();
    expect(stored.filter((entry) => entry.metadata?.source === "tracking:strategy.v1")).toHaveLength(1);
  });

  it("promotes into the writer and planning playbooks on the second consecutive daily run", async () => {
    await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch(rows()), now: () => new Date("2026-08-31T06:00:00Z") });
    const second = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch(rows()), now: () => new Date("2026-09-01T06:00:00Z") });
    expect(second.status).toBe("completed");
    if (second.status === "completed") {
      expect([...new Set(second.result.promotion.promoted.map((entry) => entry.nodeId))].sort()).toEqual([...STRATEGY_PLAYBOOK_TARGET_NODES].sort());
    }
    const writer = await repositoryManager.getImprovementRepository().getPlaybook("draft_writer");
    expect(writer?.items.some((item) => item.provenance.source === "tracking")).toBe(true);
  });

  it("reports completed_no_groups when rows arrive with every label NULL — KI-08's exact shape", async () => {
    // The grain works, the sink serves a full window, and not one row carries a
    // label because the platform's export strip ate them. Every row is dropped by
    // strategyGroupsFromRows. Exit 0, because nothing failed — but a NAMED state,
    // because "0 observations" here means "go look at the dims push", and a
    // genuinely quiet week means "there was nothing to learn". Those two were
    // indistinguishable before this.
    const unlabelled = {
      rows: [
        { strategy: null, intent: null, day: "2026-08-30", n: 412, completion_rate: 0.58, p75_dwell_ms: 42000 },
        { strategy: null, intent: null, day: "2026-08-30", n: 300, completion_rate: 0.4, p75_dwell_ms: 20000 }
      ]
    };
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch(unlabelled) });
    expect(result.status).toBe("completed_no_groups");
    expect(exitCodeFor(result)).toBe(0);
    if (result.status === "completed_no_groups") {
      expect(result.result.rows).toBe(2);
      expect(result.result.rowsLabelled).toBe(0);
      expect(result.result.groups).toBe(0);
      expect(result.result.errors).toEqual([]);
    }
  });

  it("a genuinely empty window stays plain `completed` — no rows is not the same fault", async () => {
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch({ rows: [] }) });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.rows).toBe(0);
      expect(result.result.rowsLabelled).toBe(0);
    }
  });

  it("reports skipped_grain_unavailable — exit 0, no error — when the sink's by=strategy grain answers 503", async () => {
    // The playbook store is process-wide, so "unchanged" is asserted against the version this run
    // started from rather than against emptiness.
    const before = await repositoryManager.getImprovementRepository().getPlaybook("draft_writer");
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch({ error: "unknown grain" }, 503) });
    expect(result.status).toBe("skipped_grain_unavailable");
    if (result.status === "skipped_grain_unavailable") {
      // It used to say "migration 008", which was a real kugel-data migration
      // about something else that had long since run — so an operator who
      // checked got "yes" and was led away from the answer. The reason line is
      // the only thing they read, so it names the migration that actually built
      // the grain AND the request that settles which side is behind.
      expect(result.reason).toContain("migration 012");
      expect(result.reason).not.toContain("migration 008");
      expect(result.reason).toContain("rollups?by=strategy");
    }
    expect(exitCodeFor(result)).toBe(0);
    expect(await repositoryManager.getLearningRepository().listObservations()).toEqual([]);
    expect(await repositoryManager.getImprovementRepository().getPlaybook("draft_writer")).toEqual(before);
  });

  it("reports failed (not a thrown error) when the sink is reachable-but-erroring", async () => {
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch({}, 500) });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.result.errors[0]!.error).toContain("tracking_sink_http_500");
    expect(exitCodeFor(result)).toBe(1);
  });

  it("treats an empty window as a completed quiet day, not a failure", async () => {
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch({ rows: [] }) });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.result).toMatchObject({ rows: 0, observations: [], errors: [] });
  });

  it("honors an explicit window", async () => {
    const result = await runStrategyLearningJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch(rows()), from: "2026-08-01", to: "2026-08-08" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.window).toEqual({ projectId: "trk_demo", from: "2026-08-01", to: "2026-08-08" });
  });
});

describe("strategyLearningJob CLI", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("exits 0 and prints a summary when unconfigured", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    try {
      const code = await cliMain([], UNCONFIGURED_ENV);
      expect(code).toBe(0);
      expect(JSON.parse(lines[0]!)).toMatchObject({ status: "skipped_unconfigured" });
    } finally {
      console.log = originalLog;
    }
  });

  it("rejects an unparseable --from before touching the network", async () => {
    await expect(cliMain(["--from", "last-tuesday"], CONFIGURED_ENV)).rejects.toThrow(/--from/);
  });

  it("rejects an unparseable --to before touching the network", async () => {
    await expect(cliMain(["--to", "soon"], CONFIGURED_ENV)).rejects.toThrow(/--to/);
  });
});
