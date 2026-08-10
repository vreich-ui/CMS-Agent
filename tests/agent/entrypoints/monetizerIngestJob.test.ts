import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliMain, runMonetizerIngestJob } from "../../../src/agent/entrypoints/monetizerIngestJob.js";
import type { CallToolFn } from "../../../src/agent/improvement/monetizerIngest.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// P3-cost §2.19: this job is the only caller of feedback.ingest_monetizer outside a manual MCP call —
// before it existed the feedback store held zero outcome records, ever. These tests exercise the job
// function directly (never a live Monetizer endpoint) via a mocked project adapter (callTool), plus
// its CLI wrapper.

const okCall = (result: unknown): Awaited<ReturnType<CallToolFn>> => ({ ok: true, projectId: "monetizer", connection: {}, tool: "x", permission: "allowed", result } as unknown as Awaited<ReturnType<CallToolFn>>);
const failCall = (error: string): Awaited<ReturnType<CallToolFn>> => ({ ok: false, projectId: "monetizer", connection: {}, tool: "x", permission: "allowed", error } as unknown as Awaited<ReturnType<CallToolFn>>);
const stubCall = (map: Record<string, () => Promise<Awaited<ReturnType<CallToolFn>>>>): CallToolFn => async (tool) => {
  const handler = map[tool];
  if (!handler) throw new Error(`unexpected tool ${tool}`);
  return handler();
};

const CONFIGURED_ENV = { MONETIZER_MCP_ENDPOINT: "https://monetizer.example/mcp", MONETIZER_MCP_TOKEN: "secret-token" } as unknown as NodeJS.ProcessEnv;
const UNCONFIGURED_ENV = {} as unknown as NodeJS.ProcessEnv;

describe("runMonetizerIngestJob", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("no-ops with a named, non-crashing reason when the Monetizer connection is unconfigured", async () => {
    const result = await runMonetizerIngestJob({ env: UNCONFIGURED_ENV });
    expect(result.status).toBe("skipped_unconfigured");
    if (result.status === "skipped_unconfigured") {
      expect(result.reason).toContain("MONETIZER_MCP_ENDPOINT");
      expect(result.reason).toContain("MONETIZER_MCP_TOKEN");
      expect(result.connection.endpointConfigured).toBe(false);
    }
  });

  it("dry-run reports what would run without calling Monetizer or writing anything", async () => {
    const callTool = stubCall({ performance: async () => okCall({ structuredContent: { revenue: 1 } }), demand_signals: async () => okCall({ structuredContent: {} }) });
    const result = await runMonetizerIngestJob({ env: CONFIGURED_ENV, dryRun: true, callTool });
    expect(result.status).toBe("dry_run");
    if (result.status === "dry_run") expect(result.signals).toEqual(["performance", "demand_signals"]);
    expect(await repositoryManager.getEvaluationRepository().listFeedback({ kind: "outcome" })).toEqual([]);
  });

  it("ingests both signals as feedback OUTCOME records when configured and reachable", async () => {
    const callTool = stubCall({
      performance: async () => okCall({ structuredContent: { revenue: 900, epc: 1.4 } }),
      demand_signals: async () => okCall({ structuredContent: { demandIndex: 72 } })
    });
    const result = await runMonetizerIngestJob({ env: CONFIGURED_ENV, callTool, runId: "run_job_1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed" || result.status === "failed") {
      expect(result.result.ingested.map((entry) => entry.signal)).toEqual(["performance", "demand_signals"]);
      expect(result.result.errors).toEqual([]);
    }
    const feedback = await repositoryManager.getEvaluationRepository().listFeedback({ runId: "run_job_1", kind: "outcome" });
    expect(feedback).toHaveLength(2);
    expect(feedback[0]?.actor).toMatchObject({ kind: "agent", label: "monetizer_ingest_job" });
  });

  it("reports failed (not a thrown error) when configured but every requested signal errors", async () => {
    const callTool = stubCall({ performance: async () => failCall("client_unreachable") });
    const result = await runMonetizerIngestJob({ env: CONFIGURED_ENV, callTool, signals: ["performance"] });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.result.errors).toEqual([{ signal: "performance", error: "client_unreachable" }]);
  });

  it("still completes on a PARTIAL failure — one signal ingested, one errored is not a job failure", async () => {
    const callTool = stubCall({
      performance: async () => failCall("client_unreachable"),
      demand_signals: async () => okCall({ structuredContent: { demandIndex: 3 } })
    });
    const result = await runMonetizerIngestJob({ env: CONFIGURED_ENV, callTool });
    expect(result.status).toBe("completed");
  });

  it("honors a requested signal subset", async () => {
    const callTool = stubCall({ demand_signals: async () => okCall({ structuredContent: { demandIndex: 9 } }) });
    const result = await runMonetizerIngestJob({ env: CONFIGURED_ENV, callTool, signals: ["demand_signals"] });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.signals).toEqual(["demand_signals"]);
  });
});

describe("monetizerIngestJob CLI", () => {
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

  it("rejects an unknown --signals value before touching the network", async () => {
    await expect(cliMain(["--signals", "bogus_signal"], CONFIGURED_ENV)).rejects.toThrow(/unknown signal/);
  });

  it("rejects a non-positive --limit", async () => {
    await expect(cliMain(["--limit", "0"], CONFIGURED_ENV)).rejects.toThrow(/--limit/);
  });
});
