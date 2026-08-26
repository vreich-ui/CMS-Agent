import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { CAPTURE_CONDUCTOR_WORKFLOW_ID } from "../../../src/agent/workspace/captureConductorWorkflow.js";
import { CLONE_CONDUCTOR_WORKFLOW_ID } from "../../../src/agent/workspace/cloneConductorWorkflow.js";
import { runContinuationTick } from "../../../src/agent/workspace/runContinuation.js";
import { HALTED_EXECUTION_STATUSES, type WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { maybeChainCloneAfterCapture, SITE_DUPLICATION_REQUEST_STAGE_KEY } from "../../../src/agent/workspace/siteDuplicationChain.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";
import type { ModelUsageRecord } from "../../../src/agent/observability/modelUsageTypes.js";

// T15.9 (#188) — "URL in -> live site out" is one call: site.duplicate starts capture_conductor, and
// the moment that capture run reaches a terminal state, clone_conductor is chained by captureRunId
// with no second human-issued workflow.start_dry_run. These tests exercise maybeChainCloneAfterCapture
// (the function both site.duplicate's in-call kick and the run-continuation tick call — see
// siteDuplicationChain.ts) directly against fixture capture runs, so the chain's own decision logic
// is proven without re-running a full crawl for every case. siteDuplicateOneCallChain.test.ts (below,
// same file's second describe block) proves the SAME logic wired end to end through a real capture
// run and a real clone run, published through the shared segment.

const TARGET = "zilberman-chain-clone";
const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";

const createTargetProject = async () => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: TARGET,
      name: "Zilberman chain-clone fixture",
      mcpEndpointEnvVar: "ZILBERMAN_CHAIN_CLONE_MCP_ENDPOINT",
      authMode: "none",
      defaultToolPolicy: "allowed"
    })
  );
};

type FixtureOptions = { status: WorkflowExecutionRecord["status"]; budgetUsd?: number; withMarker?: boolean };

// A capture_conductor run, real nodes/rev from startDryRun, then forced to the status/marker the
// test needs via a direct saveRun — this exercises maybeChainCloneAfterCapture against the SAME
// record shape a real capture run reaches, without re-running a crawl for every case.
const buildCaptureRun = async (opts: FixtureOptions): Promise<WorkflowExecutionRecord> => {
  const store = repositoryManager.getExecutionRepository();
  const started = await startDryRun(
    { projectId: TARGET, workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID, executionMode: "mock", input: { sourceUrl: SOURCE_URL, targetProjectId: TARGET }, ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}) },
    store
  );
  const request = {
    artifact: "site_duplication.v1" as const,
    requestedAt: started.startedAt,
    sourceUrl: SOURCE_URL,
    targetProjectId: TARGET,
    statusTool: "site.duplicate_status" as const,
    humanChecklist: [],
    ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {})
  };
  const updated: WorkflowExecutionRecord = {
    ...started,
    status: opts.status,
    stageOutputs: opts.withMarker === false ? started.stageOutputs : { ...started.stageOutputs, [SITE_DUPLICATION_REQUEST_STAGE_KEY]: request },
    updatedAt: new Date().toISOString()
  };
  return store.saveRun(updated);
};

const recordActualSpend = async (runId: string, costUsdEstimate: number): Promise<void> => {
  const record: ModelUsageRecord = {
    usageId: `usage_test_${runId}`,
    runId,
    workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID,
    projectId: TARGET,
    nodeId: "capture_map_refine",
    model: "gpt-5.5-mini",
    provider: "openai",
    inputTokens: 500,
    outputTokens: 200,
    totalTokens: 700,
    costUsdEstimate,
    currency: "USD",
    status: "actual",
    recordedAt: new Date().toISOString()
  };
  await repositoryManager.getUsageRepository().record(record);
};

const chainDeps = () => ({
  executionRepository: repositoryManager.getExecutionRepository(),
  workspaceRepository: repositoryManager.getWorkspaceRepository(),
  usageRepository: repositoryManager.getUsageRepository()
});

describe("maybeChainCloneAfterCapture", () => {
  beforeEach(async () => {
    resetRepositoryManager();
    await createTargetProject();
  });
  afterEach(() => {
    resetRepositoryManager();
  });

  it("chains a clone carrying the capture run's own runId as captureRunId", async () => {
    const capture = await buildCaptureRun({ status: "completed" });
    const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
    expect(outcome.action).toBe("chained");
    if (outcome.action !== "chained") throw new Error("unreachable");

    expect(outcome.cloneRun.workflowId).toBe(CLONE_CONDUCTOR_WORKFLOW_ID);
    expect(outcome.cloneRun.projectId).toBe(TARGET);
    expect((outcome.cloneRun.initialInput as Record<string, unknown>).captureRunId).toBe(capture.runId);
    expect((outcome.cloneRun.initialInput as Record<string, unknown>).targetProjectId).toBe(TARGET);

    // Provenance is durable: the capture run's OWN persisted request record now names the chain —
    // this is what site.duplicate_status and the future template library (#207) both read.
    const persisted = await getRun(capture.runId, repositoryManager.getExecutionRepository());
    const request = persisted!.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY] as Record<string, unknown>;
    expect((request.chain as Record<string, unknown>).status).toBe("started");
    expect((request.chain as Record<string, unknown>).cloneRunId).toBe(outcome.cloneRunId);
  });

  it("is idempotent: a second call against the same (now-chained) capture run starts no second clone", async () => {
    const capture = await buildCaptureRun({ status: "completed" });
    const first = await maybeChainCloneAfterCapture(capture, chainDeps());
    expect(first.action).toBe("chained");
    if (first.action !== "chained") throw new Error("unreachable");

    const reloaded = (await getRun(capture.runId, repositoryManager.getExecutionRepository()))!;
    const second = await maybeChainCloneAfterCapture(reloaded, chainDeps());
    expect(second.action).toBe("already_decided");

    const cloneRuns = await repositoryManager.getExecutionRepository().listRuns({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID });
    expect(cloneRuns).toHaveLength(1);
    expect(cloneRuns[0].runId).toBe(first.cloneRunId);
  });

  it.each(["blocked", "failed", "cancelled", "paused"] as const)(
    "refuses to chain a capture run that halted as \"%s\" (not a terminal SUCCESS) — names the refusal, starts no clone",
    async (status) => {
      const capture = await buildCaptureRun({ status });
      const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
      expect(outcome.action).toBe("refused");
      if (outcome.action !== "refused") throw new Error("unreachable");
      expect(outcome.code).toBe("chain_capture_not_terminal_success");
      expect(outcome.reason).toContain(status);
      expect(outcome.reason).toContain("must never start against a partial or withheld capture snapshot");

      const cloneRuns = await repositoryManager.getExecutionRepository().listRuns({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID });
      expect(cloneRuns).toHaveLength(0);

      const persisted = await getRun(capture.runId, repositoryManager.getExecutionRepository());
      const request = persisted!.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY] as Record<string, unknown>;
      expect((request.chain as Record<string, unknown>).status).toBe("refused");
      expect((request.chain as Record<string, unknown>).code).toBe("chain_capture_not_terminal_success");
    }
  );

  it("does nothing to a capture run that is not yet halted (still parked mid-flight)", async () => {
    const capture = await buildCaptureRun({ status: "running" });
    const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
    expect(outcome.action).toBe("not_applicable");
    const persisted = await getRun(capture.runId, repositoryManager.getExecutionRepository());
    expect(persisted!.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY]).toMatchObject({ sourceUrl: SOURCE_URL });
    expect((persisted!.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY] as Record<string, unknown>).chain).toBeUndefined();
    const cloneRuns = await repositoryManager.getExecutionRepository().listRuns({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID });
    expect(cloneRuns).toHaveLength(0);
  });

  it("never auto-chains a capture run started directly via workflow.start_dry_run (no site.duplicate marker) — chaining is a site.duplicate behavior only", async () => {
    const capture = await buildCaptureRun({ status: "completed", withMarker: false });
    const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
    expect(outcome.action).toBe("not_applicable");
    const cloneRuns = await repositoryManager.getExecutionRepository().listRuns({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID });
    expect(cloneRuns).toHaveLength(0);
  });

  describe("budget — one budgetUsd spans the chain", () => {
    it("gives the clone run the REMAINING shared budget (original minus capture's own accrued spend), not a fresh ceiling", async () => {
      const capture = await buildCaptureRun({ status: "completed", budgetUsd: 1 });
      await recordActualSpend(capture.runId, 0.3);

      const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
      expect(outcome.action).toBe("chained");
      if (outcome.action !== "chained") throw new Error("unreachable");
      expect(outcome.cloneRun.budgetUsd).toBeCloseTo(0.7, 6);

      const persisted = await getRun(capture.runId, repositoryManager.getExecutionRepository());
      const chain = (persisted!.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY] as Record<string, unknown>).chain as Record<string, unknown>;
      expect(chain.budgetUsd).toBeCloseTo(0.7, 6);
    });

    it("refuses the chain — rather than minting a clone born blocked — when the remaining budget is below clone_conductor's own entry-node reservation", async () => {
      // clone_intake's own modelConfig.budgetUsd reservation is $0.05 (cloneConductorNodes.ts); leave
      // only $0.01 remaining after capture's own spend.
      const capture = await buildCaptureRun({ status: "completed", budgetUsd: 0.15 });
      await recordActualSpend(capture.runId, 0.14);

      const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
      expect(outcome.action).toBe("refused");
      if (outcome.action !== "refused") throw new Error("unreachable");
      expect(outcome.code).toBe("chain_budget_exhausted");
      expect(outcome.reason).toContain("entry-node reservation");

      const cloneRuns = await repositoryManager.getExecutionRepository().listRuns({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID });
      expect(cloneRuns).toHaveLength(0);
    });

    it("a mock run's ESTIMATED usage never erodes the ceiling (R-20: only status:\"actual\" records count) — chain gets the full original budget", async () => {
      const capture = await buildCaptureRun({ status: "completed", budgetUsd: 0.5 });
      // An "estimated" record (what a mock run actually produces) must be ignored by the chain's own
      // budget read, exactly as evaluateRunBudget/getBudgetStatus already ignore it everywhere else.
      await repositoryManager.getUsageRepository().record({
        usageId: `usage_estimated_${capture.runId}`,
        runId: capture.runId,
        workflowId: CAPTURE_CONDUCTOR_WORKFLOW_ID,
        projectId: TARGET,
        nodeId: "block_classifier",
        model: "gpt-5.5-mini",
        provider: "openai",
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        costUsdEstimate: 0.2,
        currency: "USD",
        status: "estimated",
        recordedAt: new Date().toISOString()
      });

      const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
      expect(outcome.action).toBe("chained");
      if (outcome.action !== "chained") throw new Error("unreachable");
      expect(outcome.cloneRun.budgetUsd).toBeCloseTo(0.5, 6);
    });

    it("no budgetUsd on the original call -> no ceiling on the chained clone either", async () => {
      const capture = await buildCaptureRun({ status: "completed" });
      const outcome = await maybeChainCloneAfterCapture(capture, chainDeps());
      expect(outcome.action).toBe("chained");
      if (outcome.action !== "chained") throw new Error("unreachable");
      expect(outcome.cloneRun.budgetUsd).toBeUndefined();
    });
  });

  describe("determinism (#200)", () => {
    it("two independent capture runs of the same URL, same target, same budget and same accrued spend chain to the IDENTICAL clone shape", async () => {
      const captureA = await buildCaptureRun({ status: "completed", budgetUsd: 1 });
      await recordActualSpend(captureA.runId, 0.25);
      const captureB = await buildCaptureRun({ status: "completed", budgetUsd: 1 });
      await recordActualSpend(captureB.runId, 0.25);

      const outcomeA = await maybeChainCloneAfterCapture(captureA, chainDeps());
      const outcomeB = await maybeChainCloneAfterCapture(captureB, chainDeps());
      expect(outcomeA.action).toBe("chained");
      expect(outcomeB.action).toBe("chained");
      if (outcomeA.action !== "chained" || outcomeB.action !== "chained") throw new Error("unreachable");

      // The run ids themselves differ (each capture run is its own record, as it must be) — but
      // every DERIVED value is identical: same workflow, same target, same rounded remaining
      // budget. Nothing here diverges based on wall-clock timing or random ordering.
      expect(outcomeA.cloneRun.workflowId).toBe(outcomeB.cloneRun.workflowId);
      expect((outcomeA.cloneRun.initialInput as Record<string, unknown>).targetProjectId).toBe((outcomeB.cloneRun.initialInput as Record<string, unknown>).targetProjectId);
      expect(outcomeA.cloneRun.budgetUsd).toBeCloseTo(outcomeB.cloneRun.budgetUsd!, 6);
      expect((outcomeA.cloneRun.initialInput as Record<string, unknown>).captureRunId).toBe(captureA.runId);
      expect((outcomeB.cloneRun.initialInput as Record<string, unknown>).captureRunId).toBe(captureB.runId);
    });
  });
});
