import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliMain, previousUtcDay, runTrackingIngestJob } from "../../../src/agent/entrypoints/trackingIngestJob.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../../../src/agent/improvement/trackingIngest.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// T21.7: this daily job is the only caller of feedback.ingest_tracking outside a manual MCP call.
// These tests exercise the job function directly (never a live tracking sink) via an injected fetch,
// plus its CLI wrapper. Only env var NAMES appear here.

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

const rows = (count: number) => ({ rows: Array.from({ length: count }, (_value, index) => ({ node_id: "draft_writer", run_id: `run_${index}`, exposures: 100 + index, cta_ctr: 0.05 })) });

describe("previousUtcDay", () => {
  it("resolves the previous whole UTC day — the window a daily schedule should pull", () => {
    expect(previousUtcDay(new Date("2026-08-31T04:12:00Z"))).toEqual({ from: "2026-08-30", to: "2026-08-31" });
    expect(previousUtcDay(new Date("2026-03-01T23:59:59Z"))).toEqual({ from: "2026-02-28", to: "2026-03-01" });
  });
});

describe("runTrackingIngestJob", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("no-ops with a named, non-crashing reason when the tracking sink is unconfigured", async () => {
    const result = await runTrackingIngestJob({ env: UNCONFIGURED_ENV });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") {
      expect(result.reason).toContain(TRACKING_SINK_URL_ENV);
      expect(result.reason).toContain(TRACKING_SINK_TOKEN_ENV);
      expect(result.connection.urlConfigured).toBe(false);
    }
  });

  it("no-ops when the sink is configured but no tracking partition is named", async () => {
    const result = await runTrackingIngestJob({ env: { [TRACKING_SINK_URL_ENV]: "https://sink.example", [TRACKING_SINK_TOKEN_ENV]: "t" } as unknown as NodeJS.ProcessEnv });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") expect(result.reason).toContain("TRACKING_PROJECT_ID");
  });

  it("dry-run reports the resolved window without calling the sink or writing anything", async () => {
    const urls: string[] = [];
    const result = await runTrackingIngestJob({ env: CONFIGURED_ENV, dryRun: true, fetchImpl: jsonFetch(rows(2), 200, urls), now: () => new Date("2026-08-31T06:00:00Z") });
    expect(result.status).toBe("dry_run");
    if (result.status === "dry_run") expect(result.window).toEqual({ projectId: "trk_demo", from: "2026-08-30", to: "2026-08-31" });
    expect(urls).toEqual([]);
    expect(await repositoryManager.getEvaluationRepository().listFeedback({ kind: "outcome" })).toEqual([]);
  });

  it("ingests every returned row as a feedback OUTCOME, stamped with the job actor", async () => {
    const result = await runTrackingIngestJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch(rows(3)), now: () => new Date("2026-08-31T06:00:00Z") });
    expect(result.status).toBe("completed");
    if (result.status === "completed" || result.status === "failed") {
      expect(result.result.rows).toBe(3);
      expect(result.result.ingested).toHaveLength(3);
      expect(result.result.errors).toEqual([]);
    }
    const feedback = await repositoryManager.getEvaluationRepository().listFeedback({ nodeId: "draft_writer", kind: "outcome" });
    expect(feedback).toHaveLength(3);
    expect(feedback[0]?.actor).toMatchObject({ kind: "agent", label: "tracking_ingest_job" });
    expect(feedback[0]?.note).toBe("window 2026-08-30..2026-08-31");
  });

  it("honors an explicit window and node filter", async () => {
    const result = await runTrackingIngestJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch(rows(1)), from: "2026-08-01", to: "2026-08-08", nodeId: "draft_writer" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.window).toEqual({ projectId: "trk_demo", from: "2026-08-01", to: "2026-08-08", nodeId: "draft_writer" });
  });

  it("reports failed (not a thrown error) when the sink is reachable-but-erroring", async () => {
    const result = await runTrackingIngestJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch({}, 500) });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.result.errors[0]!.error).toContain("tracking_sink_http_500");
  });

  it("treats an empty window as a completed quiet day, not a failure", async () => {
    const result = await runTrackingIngestJob({ env: CONFIGURED_ENV, fetchImpl: jsonFetch({ rows: [] }) });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.result).toMatchObject({ rows: 0, ingested: [], errors: [] });
  });
});

describe("trackingIngestJob CLI", () => {
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
