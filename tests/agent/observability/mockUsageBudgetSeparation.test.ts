import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { UsageRepository } from "../../../src/agent/repository/interfaces/UsageRepository.js";
import { getBudgetStatus, recordModelUsage, summarizeModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// R-20 (T-2 finding F-5): a MOCK run recorded $0.029 against the budget ceiling despite making zero
// model calls. Estimated (mock/dry-run) usage records must stay visible for reporting but must NEVER
// accrue against budgetUsd — budgets meter money, and only status:"actual" records represent money.

const actual = { model: "gpt-5.5", provider: "openai", inputTokens: 1000, outputTokens: 500, status: "actual" as const };
const estimated = { ...actual, status: "estimated" as const };

describe("R-20: estimated vs actual cost separation", () => {
  let store: UsageRepository;
  beforeEach(() => { store = new RepositoryManager().getUsageRepository(); });

  it("summarizes the two populations separately while keeping the combined total", async () => {
    await recordModelUsage({ ...actual, runId: "run-r20", costUsdEstimate: 0.5 }, store);
    await recordModelUsage({ ...estimated, runId: "run-r20", costUsdEstimate: 0.2 }, store);

    const summary = await summarizeModelUsage({ runId: "run-r20" }, store);
    expect(summary.actualCostUsdEstimate).toBe(0.5);
    expect(summary.estimatedCostUsdEstimate).toBe(0.2);
    expect(summary.totalCostUsdEstimate).toBeCloseTo(0.7, 6);
  });

  it("filters records by status", async () => {
    await recordModelUsage({ ...actual, runId: "run-r20" }, store);
    await recordModelUsage({ ...estimated, runId: "run-r20" }, store);

    expect(await store.list({ runId: "run-r20", status: "actual" })).toHaveLength(1);
    expect(await store.list({ runId: "run-r20", status: "estimated" })).toHaveLength(1);
    expect((await summarizeModelUsage({ runId: "run-r20", status: "estimated" }, store)).recordCount).toBe(1);
  });

  it("budget status meters only actual spend — estimated records do not consume the ceiling", async () => {
    await recordModelUsage({ ...estimated, runId: "run-r20", costUsdEstimate: 99 }, store);
    await recordModelUsage({ ...actual, runId: "run-r20", costUsdEstimate: 0.4 }, store);

    const status = await getBudgetStatus({ runId: "run-r20", budgetUsd: 1 }, store);
    expect(status.spentUsdEstimate).toBe(0.4);
    expect(status.remainingUsdEstimate).toBe(0.6);
    expect(status.status).toBe("ok");
  });

  it("a full mock run accrues $0 actual: its estimates are recorded but the budget stays untouched (F-5)", async () => {
    repositoryManager.getUsageRepository().clear();
    const executionStore = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "r20-proj", input: "Draft this", budgetUsd: 1 }, executionStore);
    // Drive to a terminal state; with R-20 the mock estimates must not trip the $1 ceiling.
    let run = await getRun(started.runId, executionStore);
    for (let i = 0; run && i < 40 && !(["blocked", "completed", "failed", "cancelled"].includes(run.status)); i++) {
      run = await runNextNode(started.runId, { executionRepository: executionStore });
    }

    const summary = await summarizeModelUsage({ runId: started.runId });
    expect(summary.estimatedCostUsdEstimate).toBeGreaterThan(0); // the estimates are still recorded and visible
    expect(summary.actualCostUsdEstimate).toBe(0);               // but no money was spent...
    expect(run!.budgetBlock).toBeUndefined();                    // ...so the ceiling was never consumed
    const status = await getBudgetStatus({ runId: started.runId, budgetUsd: 1 });
    expect(status.spentUsdEstimate).toBe(0);
  });
});
