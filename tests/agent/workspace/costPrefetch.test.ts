import { describe, expect, it } from "vitest";
import type { ExecutionRepository, ListRunsFilters } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { NodeTimingRepository } from "../../../src/agent/repository/interfaces/NodeTimingRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { NodeTimingFilters, NodeTimingRecord } from "../../../src/agent/workspace/nodeTimings.js";
import { getRunCostEstimate, MAX_RUN_COST_HISTORY_CANDIDATES } from "../../../src/agent/workspace/costPrefetch.js";

const ROUTES = { research: "model" };
const run = (runId: string, projectId = "dr-lurie"): WorkflowExecutionRecord => ({
  runId, projectId, workflowId: "publishing", status: "completed", executionMode: "openai", startedAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:01:00.000Z",
  nodes: [{ nodeId: "research", status: "completed" }], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
}) as WorkflowExecutionRecord;
const row = (runId: string, costUsd: number): NodeTimingRecord => ({
  timingId: `timing_${runId}`, runId, workflowId: "publishing", nodeId: "research", durationMs: 1000, costUsd, outcome: "completed", recordedAt: "2026-09-10T00:00:30.000Z",
  projectId: "dr-lurie", executionMode: "openai", routeEra: "model"
});

describe("getRunCostEstimate bounded qualified candidate path", () => {
  it("pages completed candidates first and joins timing by run, never by a whole workflow ledger", async () => {
    const own = [run("hist_a"), run("hist_b")];
    const pages: Array<Record<string, unknown>> = [];
    const executionRepository = {
      listRunsPage: async (filters: ListRunsFilters = {}) => {
        pages.push(filters as Record<string, unknown>);
        return { runs: own, matchedCount: own.length, hasMore: true };
      }
    } as unknown as ExecutionRepository;
    const timingFilters: Array<Record<string, unknown>> = [];
    const nodeTimingRepository = {
      list: async (filters: NodeTimingFilters = {}) => {
        timingFilters.push(filters as Record<string, unknown>);
        return filters?.runId === "hist_a" ? [row("hist_a", 2)] : [row("hist_b", 5)];
      }
    } as unknown as NodeTimingRepository;

    const result = await getRunCostEstimate({ runId: "run_now", workflowId: "publishing", projectId: "dr-lurie", currentRouteEras: ROUTES }, { executionRepository, nodeTimingRepository });

    expect(result.estimate).toMatchObject({ basis: "workflow_history", scope: "project", estimatedRunCostUsd: 2, candidateRuns: 2, coverageRuns: 2 });
    expect(pages).toHaveLength(2);
    expect(pages.every((page) => page.status === "completed" && page.workflowId === "publishing" && page.limit === MAX_RUN_COST_HISTORY_CANDIDATES)).toBe(true);
    expect(timingFilters).toEqual([{ runId: "hist_a" }, { runId: "hist_b" }]);
  });

  it("does not read either ledger when the caller has not supplied current route evidence", async () => {
    const executionRepository = { listRunsPage: async () => { throw new Error("must not read"); } } as unknown as ExecutionRepository;
    const nodeTimingRepository = { list: async () => { throw new Error("must not read"); } } as unknown as NodeTimingRepository;
    const result = await getRunCostEstimate({ runId: "run_now", workflowId: "publishing", projectId: "dr-lurie" }, { executionRepository, nodeTimingRepository });
    expect(result.estimate).toMatchObject({ basis: "no_history", estimatedRunCostUsd: 0 });
    expect(result.warningCode).toBe("cost_history_insufficient");
  });
});
