import { beforeEach, describe, expect, it } from "vitest";
import { getBudgetStatus, estimateModelCost, recordModelUsage, summarizeModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { InMemoryModelUsageStore } from "../../../src/agent/observability/modelUsageStore.js";

const base = { model: "gpt-5.5", provider: "openai", inputTokens: 1000, outputTokens: 500, status: "estimated" as const };

describe("model usage observability", () => {
  let store: InMemoryModelUsageStore;

  beforeEach(() => { store = new InMemoryModelUsageStore(); });

  it("estimates cost from the placeholder catalog", () => {
    expect(estimateModelCost({ model: "gpt-5.5", inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(20);
  });

  it("stores usage records", async () => {
    const record = await recordModelUsage({ ...base, runId: "run-a" }, store);
    expect(record.usageId).toMatch(/^usage_/);
    expect(await store.list({ runId: "run-a" })).toHaveLength(1);
  });

  it("summarizes usage totals", async () => {
    await recordModelUsage({ ...base, reasoningTokens: 25, projectId: "project-a", nodeId: "node-a" }, store);
    await recordModelUsage({ ...base, inputTokens: 200, outputTokens: 300, projectId: "project-a", nodeId: "node-b" }, store);
    const summary = await summarizeModelUsage({}, store);
    expect(summary.totalInputTokens).toBe(1200);
    expect(summary.totalOutputTokens).toBe(800);
    expect(summary.totalTokens).toBe(2000);
    expect(summary.totalReasoningTokens).toBe(25);
    expect(summary.recordCount).toBe(2);
    expect(summary.byModel["gpt-5.5"].recordCount).toBe(2);
  });

  it("filters by runId, projectId, and nodeId", async () => {
    await recordModelUsage({ ...base, runId: "run-a", projectId: "project-a", nodeId: "node-a" }, store);
    await recordModelUsage({ ...base, runId: "run-b", projectId: "project-b", nodeId: "node-b" }, store);
    expect((await store.list({ runId: "run-a" })).map((record) => record.runId)).toEqual(["run-a"]);
    expect((await store.list({ projectId: "project-b" })).map((record) => record.projectId)).toEqual(["project-b"]);
    expect((await store.list({ nodeId: "node-a" })).map((record) => record.nodeId)).toEqual(["node-a"]);
  });

  it("returns ok budget status", async () => {
    await recordModelUsage({ ...base, costUsdEstimate: 10 }, store);
    expect((await getBudgetStatus({ budgetUsd: 100 }, store)).status).toBe("ok");
  });

  it("returns warning budget status", async () => {
    await recordModelUsage({ ...base, costUsdEstimate: 80 }, store);
    expect((await getBudgetStatus({ budgetUsd: 100 }, store)).status).toBe("warning");
  });

  it("returns exceeded budget status", async () => {
    await recordModelUsage({ ...base, costUsdEstimate: 101 }, store);
    expect((await getBudgetStatus({ budgetUsd: 100 }, store)).status).toBe("exceeded");
  });
});
