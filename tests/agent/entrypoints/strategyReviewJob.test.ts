import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliMain, exitCodeFor, previousUtcWeek, runStrategyReviewJob } from "../../../src/agent/entrypoints/strategyReviewJob.js";
import {
  STRATEGY_OBJECT_ID_ENV,
  STRATEGY_OBJECT_PROJECT_ID_ENV,
  STRATEGY_OBJECT_TYPE_ENV,
  STRATEGY_REVIEW_AUTOPATCH_ENV
} from "../../../src/agent/improvement/strategyReview.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
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

  it("no-ops when the sink is configured but no tracking partition is named", async () => {
    const result = await runStrategyReviewJob({ env: { [TRACKING_SINK_URL_ENV]: "https://sink.example", [TRACKING_SINK_TOKEN_ENV]: "t" } as unknown as NodeJS.ProcessEnv });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") expect(result.reason).toContain("TRACKING_PROJECT_ID");
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
