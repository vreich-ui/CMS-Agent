import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContinuationTick } from "../../../src/agent/workspace/runContinuation.js";
import { tickExitCode } from "../../../src/agent/entrypoints/runContinuationTickJob.js";
import { MemoryDriverHealthRepository } from "../../../src/agent/repository/memory/MemoryDriverHealthRepository.js";
import { SILENT_TICK_THRESHOLD, TICK_LEDGER_RETENTION_MS } from "../../../src/agent/workspace/driverHealth.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W0 T0.2/T0.3 acceptance. The 2026-09-04 incident, in one sentence: a run sat "running" with
// nothing in flight for 44 minutes while the tick exited 0 every two minutes. Nothing in the store
// recorded that a tick had happened, `stall` could not express "no driver has looked at this", and
// Scheduler saw a green job throughout. These tests pin the three records that end that.

const fakeStore = (records: WorkflowExecutionRecord[]): ExecutionRepository => ({
  listRuns: async () => records,
  listRunsPage: async () => ({ runs: records, matchedCount: records.length, hasMore: false }),
  getRun: async (runId: string) => records.find((record) => record.runId === runId),
  createRun: async (record) => record,
  saveRun: async (record) => { const index = records.findIndex((candidate) => candidate.runId === record.runId); records[index] = record; return record; },
  resetRun: async (_runId, next) => next,
  health: async () => ({ backend: "memory", ok: true } as never)
});

const runningRun = (runId: string, projectId = "dr-lurie"): WorkflowExecutionRecord => ({
  runId, workflowId: "publishing_conductor", projectId, status: "running", executionMode: "mock",
  startedAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date(Date.now() - 5_000).toISOString(),
  nodes: [{ nodeId: "input_triage", status: "queued" }], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
});

describe("W0 T0.2 — tick ledger and driver-silence signal", () => {
  beforeEach(() => { delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.RUN_CONTINUATION_TICK; });

  it(`flags a run silent after ${SILENT_TICK_THRESHOLD} refused ticks, fails the job, and clears both when a tick drives it`, async () => {
    const records = [runningRun("run_silent")];
    const executionRepository = fakeStore(records);
    const driverHealthRepository = new MemoryDriverHealthRepository();
    // The driver is "up" (the tick runs, scans, and selects the run) but advances nothing — exactly
    // the shape of the incident, and invisible before this wave.
    const refusingTick = () => runContinuationTick({
      executionRepository,
      driverHealthRepository,
      projectRepository: repositoryManager.getProjectRepository(),
      env: { DR_LURIE_MCP_ENDPOINT: "https://dr-lurie.example/mcp" },
      advance: async () => { throw new Error("driver refused"); }
    });

    const first = await refusingTick();
    expect(first.driverSilent).toBeUndefined();
    expect(records[0].driverHealth?.silentTicks).toBe(1);
    expect(records[0].driverHealth?.lastSeenByTickAt).toBeTruthy();

    await refusingTick();
    const third = await refusingTick();

    expect(third.driverSilent).toBe(true);
    expect(records[0].warnings?.some((warning) => warning.startsWith("driver_silent_since:"))).toBe(true);
    expect(records[0].driverHealth?.lastRefusal?.code).toBeTruthy();

    // The ledger holds one document per tick, with the refusal named — the record the incident had
    // nowhere to live.
    const ticks = await driverHealthRepository.listTicks();
    expect(ticks).toHaveLength(3);
    // Addressed by id, not by position: three ticks in one test can share a millisecond.
    const thirdLedger = ticks.find((entry) => entry.tickId === third.tickId)!;
    expect(thirdLedger.scanned).toBe(1);
    expect(thirdLedger.driven).toEqual([]);
    expect(thirdLedger.refusals[0]?.runId).toBe("run_silent");
    expect(thirdLedger.driverSilent).toBe(true);

    // A fourth tick that actually drives the run clears the warning and the counter.
    const fourth = await runContinuationTick({
      executionRepository,
      driverHealthRepository,
      projectRepository: repositoryManager.getProjectRepository(),
      env: { DR_LURIE_MCP_ENDPOINT: "https://dr-lurie.example/mcp" },
      advance: async (runId) => { const record = records.find((candidate) => candidate.runId === runId)!; record.status = "completed"; return record; }
    });
    expect(fourth.driverSilent).toBeUndefined();
    expect(records[0].driverHealth?.silentTicks).toBeUndefined();
    expect(records[0].warnings?.some((warning) => warning.startsWith("driver_silent_since:"))).toBe(false);

    // T0.3 — and the tenant now carries the timestamp that answers "is anything driving dr-lurie".
    const tenant = await driverHealthRepository.getTenantHealth("dr-lurie");
    expect(tenant).toMatchObject({ projectId: "dr-lurie", driver: "continuation_tick", runId: "run_silent" });
  });

  it("the Cloud Run job exits 1 on driver silence and 0 on a quiet-but-healthy tick", () => {
    // "Nothing needed advancing" stays green — a non-zero exit there would alert on normal
    // operation. "I have failed to advance an advanceable run three ticks running" is the one new
    // failure, and it is the one Scheduler and alerting can actually see.
    expect(tickExitCode({ driverSilent: true })).toBe(1);
    expect(tickExitCode({})).toBe(0);
  });

  it("prunes ledger entries past the retention window", async () => {
    const repository = new MemoryDriverHealthRepository();
    const old = new Date(Date.now() - TICK_LEDGER_RETENTION_MS - 60_000).toISOString();
    await repository.recordTick({ tickId: "tick_old", startedAt: old, scanned: 0, driven: [], refusals: [] });
    await repository.recordTick({ tickId: "tick_new", startedAt: new Date().toISOString(), scanned: 0, driven: [], refusals: [] });
    expect(await repository.pruneTicks(new Date(Date.now() - TICK_LEDGER_RETENTION_MS).toISOString())).toBe(1);
    expect((await repository.listTicks()).map((entry) => entry.tickId)).toEqual(["tick_new"]);
  });
});

describe("W0 T0.3 — per-tenant background dispatch is readable from the MCP surface", () => {
  beforeEach(() => { delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });

  it("project.get reports the last background dispatch for the tenant", async () => {
    const at = new Date().toISOString();
    await repositoryManager.getDriverHealthRepository().recordTenantDispatch({ projectId: "dr-lurie", lastBackgroundDispatchAt: at, driver: "continuation_tick", runId: "run_x" });
    const tool = createWorkspaceTools({}).find((candidate) => candidate.name === "project.get")!;
    const result = await tool.execute({ projectId: "dr-lurie" }) as { data: { project?: { driverHealth?: { lastBackgroundDispatchAt?: string } | null } } };
    expect(result.data.project?.driverHealth?.lastBackgroundDispatchAt).toBe(at);
  });
});
