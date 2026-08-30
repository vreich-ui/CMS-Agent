import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { runContinuationTick } from "../../../src/agent/workspace/runContinuation.js";
import { __resetDriverEnvLogForTests, logProjectEnvNamesOnce, preflightDriverEnv } from "../../../src/agent/workspace/driverEnvPreflight.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// S1 (chat-path). Two facts a diagnosis needs and the record never carried:
//   1. WHICH driver dispatched a node and whether that driver could see the project's MCP endpoint
//      (dispatch provenance, stamped on the claim and kept on lastDispatch).
//   2. A background driver (tick / job) that CANNOT see the endpoint must not dispatch at all — it
//      records driver_env_missing:<VAR> on the run once and leaves it for a driver that can.

const fakeStore = (records: WorkflowExecutionRecord[]): ExecutionRepository => ({
  listRuns: async () => records,
  listRunsPage: async () => ({ runs: records, matchedCount: records.length, hasMore: false }),
  getRun: async (runId: string) => records.find((record) => record.runId === runId),
  createRun: async (record) => record,
  saveRun: async (record) => { const index = records.findIndex((candidate) => candidate.runId === record.runId); records[index] = record; return record; },
  resetRun: async (_runId, next) => next,
  health: async () => ({ backend: "memory", ok: true } as never)
});

const openaiRun = (runId: string, projectId: string): WorkflowExecutionRecord => ({
  runId, workflowId: "publishing_conductor", projectId, status: "queued", executionMode: "openai",
  startedAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date(Date.now() - 5_000).toISOString(),
  nodes: [{ nodeId: "n1", status: "queued" }], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
});

describe("driver env preflight", () => {
  beforeEach(() => { repositoryManager.getUsageRepository().clear(); __resetDriverEnvLogForTests(); });
  afterEach(() => { delete process.env.PLATFORM_MCP_ENDPOINT; delete process.env.DR_LURIE_MCP_ENDPOINT; delete process.env.RUN_CONTINUATION_TICK; });

  it("tick with an empty env: no dispatch, run carries driver_env_missing:<VAR> exactly once", async () => {
    const records = [openaiRun("r-env", "dr-lurie")];
    const advanced: string[] = [];
    const tick = () => runContinuationTick({
      executionRepository: fakeStore(records),
      projectRepository: repositoryManager.getProjectRepository(),
      env: {},
      advance: async (runId) => { advanced.push(runId); return records[0]; }
    });
    const first = await tick();
    expect(advanced).toEqual([]);
    expect(first.driven[0]).toMatchObject({ runId: "r-env", steps: 0, skippedReason: "driver_env_missing:DR_LURIE_MCP_ENDPOINT" });
    expect(records[0].warnings).toEqual(["driver_env_missing:DR_LURIE_MCP_ENDPOINT"]);
    // Idempotent across ticks: the warning is not appended again.
    await tick();
    expect(advanced).toEqual([]);
    expect(records[0].warnings).toEqual(["driver_env_missing:DR_LURIE_MCP_ENDPOINT"]);
  });

  it("tick with the endpoint visible dispatches as before", async () => {
    const records = [openaiRun("r-ok", "dr-lurie")];
    const advanced: string[] = [];
    await runContinuationTick({
      executionRepository: fakeStore(records),
      projectRepository: repositoryManager.getProjectRepository(),
      env: { DR_LURIE_MCP_ENDPOINT: "https://dr-lurie.example/mcp" },
      advance: async (runId) => { advanced.push(runId); records[0].status = "blocked"; return records[0]; }
    });
    expect(advanced).toEqual(["r-ok"]);
    expect(records[0].warnings).toBeUndefined();
  });

  it("mock runs and unknown projects are exempt (nothing to preflight)", async () => {
    const repo = repositoryManager.getProjectRepository();
    expect((await preflightDriverEnv({ projectId: "dr-lurie", executionMode: "mock" }, repo, {})).ok).toBe(true);
    expect((await preflightDriverEnv({ projectId: "no-such-project", executionMode: "openai" }, repo, {})).ok).toBe(true);
    expect(await preflightDriverEnv({ projectId: "dr-lurie", executionMode: "openai" }, repo, {})).toMatchObject({ ok: false, envVar: "DR_LURIE_MCP_ENDPOINT" });
  });

  it("logs project env var NAMES once per cold start, never values", async () => {
    const lines: string[] = [];
    const env = { PLATFORM_MCP_ENDPOINT: "https://secret.example/mcp?token=abc" };
    await logProjectEnvNamesOnce(repositoryManager.getProjectRepository(), env, (line) => lines.push(line));
    await logProjectEnvNamesOnce(repositoryManager.getProjectRepository(), env, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PLATFORM_MCP_ENDPOINT");
    expect(lines[0]).toContain("DR_LURIE_MCP_ENDPOINT");
    expect(lines[0]).not.toContain("secret.example");
  });

  it("stamps dispatch provenance (driver + projectEndpointConfigured) and keeps it after completion", async () => {
    process.env.PLATFORM_MCP_ENDPOINT = "https://platform.example/mcp";
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "provenance" }, store);
    const advanced = await runNextNode(started.runId, { executionRepository: store, driver: "continuation_tick" });
    const first = advanced.nodes.find((node) => node.status === "completed")!;
    expect(first.dispatch).toBeUndefined();
    expect(first.lastDispatch).toMatchObject({ driver: "continuation_tick", projectEndpointConfigured: true });

    delete process.env.PLATFORM_MCP_ENDPOINT;
    const again = await runNextNode(started.runId, { executionRepository: store });
    const second = again.nodes.filter((node) => node.status === "completed").at(-1)!;
    expect(second.lastDispatch).toMatchObject({ driver: "http_run_all", projectEndpointConfigured: false });
    expect((await getRun(started.runId, store))!.nodes.filter((node) => node.lastDispatch).length).toBeGreaterThanOrEqual(2);
  });
});
