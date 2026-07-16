import { describe, expect, it, vi } from "vitest";
import { RunScopedCache, getRunContext, planRun, summarizeRunCost } from "../../../src/agent/workspace/conductor.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ModelUsageSummary } from "../../../src/agent/observability/modelUsageTypes.js";
import type { WorkflowExecutionRecord, NodeExecutionState } from "../../../src/agent/workspace/executionTypes.js";

const projectRepositoryStub = (get: (id: string) => unknown) => ({ get: async (id: string) => get(id) }) as unknown as ProjectRepository;

const usageSummary = (byNode: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number; costUsdEstimate: number }>): ModelUsageSummary => {
  const totals = Object.values(byNode).reduce((acc, bucket) => ({ input: acc.input + bucket.inputTokens, output: acc.output + bucket.outputTokens, total: acc.total + bucket.totalTokens, cost: acc.cost + bucket.costUsdEstimate }), { input: 0, output: 0, total: 0, cost: 0 });
  return {
    inputTokens: totals.input, outputTokens: totals.output, totalTokens: totals.total, reasoningTokens: 0, costUsdEstimate: totals.cost, recordCount: Object.keys(byNode).length,
    totalInputTokens: totals.input, totalOutputTokens: totals.output, totalReasoningTokens: 0, totalCostUsdEstimate: totals.cost,
    byModel: {}, byProject: {},
    byNode: Object.fromEntries(Object.entries(byNode).map(([id, bucket]) => [id, { ...bucket, reasoningTokens: 0, recordCount: 1 }]))
  } as unknown as ModelUsageSummary;
};

const node = (nodeId: string, status: NodeExecutionState["status"]): NodeExecutionState => ({ nodeId, status });
const run = (overrides: Partial<WorkflowExecutionRecord> & { nodes: NodeExecutionState[] }): WorkflowExecutionRecord => ({
  runId: "run_x", workflowId: "publishing_conductor", projectId: "dr-lurie", status: "queued", startedAt: "t", updatedAt: "t",
  artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, ...overrides
});

describe("RunScopedCache", () => {
  it("loads once per (runId,key) and reuses the value", async () => {
    const cache = new RunScopedCache();
    const loader = vi.fn(async () => ({ n: 1 }));
    const first = await cache.getOrLoad("run_a", "k", loader);
    const second = await cache.getOrLoad("run_a", "k", loader);
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.has("run_a", "k")).toBe(true);
  });

  it("keys per run and supports invalidate/clear", async () => {
    const cache = new RunScopedCache();
    const loader = vi.fn(async () => 1);
    await cache.getOrLoad("run_a", "k", loader);
    await cache.getOrLoad("run_b", "k", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toEqual({ runs: 2, entries: 2 });
    cache.invalidateRun("run_a");
    expect(cache.has("run_a", "k")).toBe(false);
    await cache.getOrLoad("run_a", "k", loader);
    expect(loader).toHaveBeenCalledTimes(3);
    cache.clear();
    expect(cache.stats()).toEqual({ runs: 0, entries: 0 });
  });
});

describe("getRunContext", () => {
  it("assembles the reusable bundle and memoizes it per run", async () => {
    const cache = new RunScopedCache();
    const get = vi.fn((id: string) => (id === "dr-lurie" ? drLurieProjectConfig : undefined));
    const projectRepository = projectRepositoryStub(get);

    const context = await getRunContext({ runId: "run_ctx", projectId: "dr-lurie", projectRepository, cache });
    expect(context.projectContract.canonicalArticleBody).toBe("article_body.v1");
    expect((context.articleBodySchema as { properties: { nodes: unknown } }).properties.nodes).toBeDefined();
    expect(context.projectToolPolicy.defaultToolPolicy).toBe("allowed");
    expect(context.objectContracts).not.toBeNull();
    expect(context.registry.map((entry) => entry.id)).toContain("article_body");

    await getRunContext({ runId: "run_ctx", projectId: "dr-lurie", projectRepository, cache });
    // Memoized: the project repository is read once for the run.
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("throws for an unknown project", async () => {
    await expect(getRunContext({ runId: "r", projectId: "nope", projectRepository: projectRepositoryStub(() => undefined), cache: new RunScopedCache() })).rejects.toThrow(/Unknown projectId/);
  });
});

describe("summarizeRunCost", () => {
  it("joins node states with usage and marks completed stages reusable", () => {
    const record = run({ nodes: [node("input_triage", "completed"), node("article_body", "completed"), node("publish_payload", "queued")], status: "queued" });
    const usage = usageSummary({ input_triage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsdEstimate: 0.001 }, article_body: { inputTokens: 500, outputTokens: 300, totalTokens: 800, costUsdEstimate: 0.02 } });

    const ledger = summarizeRunCost(record, usage);
    expect(ledger.totalCostUsdEstimate).toBeCloseTo(0.021);
    expect(ledger.mostExpensiveNodeId).toBe("article_body");
    expect(ledger.reusableNodeIds).toEqual(["input_triage", "article_body"]);
    expect(ledger.remainingNodeIds).toEqual(["publish_payload"]);
    const publish = ledger.stages.find((stage) => stage.nodeId === "publish_payload")!;
    expect(publish).toMatchObject({ costUsdEstimate: 0, reusable: false });
  });
});

describe("planRun", () => {
  it("recommends polling for a terminal run", () => {
    expect(planRun(run({ nodes: [node("input_triage", "completed")], status: "completed" })).strategy).toBe("poll");
  });
  it("recommends resuming a blocked run", () => {
    expect(planRun(run({ nodes: [node("publication_controller", "blocked")], status: "blocked" })).strategy).toBe("resume");
  });
  it("recommends a narrow late-stage re-run when article_body is already complete", () => {
    const plan = planRun(run({ nodes: [node("article_body", "completed"), node("publish_payload", "queued")], status: "queued" }));
    expect(plan.strategy).toBe("late_stage_rerun");
    expect(plan.recommendedEntrypoint).toBe("article_body");
    expect(plan.narrowerThanFullRun).toBe(true);
  });
  it("falls back to a full run when no reusable late-stage artifact exists", () => {
    const plan = planRun(run({ nodes: [node("input_triage", "queued"), node("article_body", "queued")], status: "queued" }));
    expect(plan.strategy).toBe("full_run");
    expect(plan.narrowerThanFullRun).toBe(false);
  });
});
