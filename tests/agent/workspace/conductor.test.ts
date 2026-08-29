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

  // T3 (autonomous-publish): a caller whose result type distinguishes success from failure passes
  // shouldCache so a failed load is never memoized for the life of the run.
  it("does not store a value shouldCache rejects, and re-runs the loader next time", async () => {
    const cache = new RunScopedCache();
    let attempt = 0;
    const loader = vi.fn(async () => ({ ok: ++attempt > 2 }));
    const shouldCache = (value: { ok: boolean }) => value.ok;

    expect(await cache.getOrLoad("run_c", "k", loader, { shouldCache })).toEqual({ ok: false });
    expect(cache.has("run_c", "k")).toBe(false);
    expect(await cache.getOrLoad("run_c", "k", loader, { shouldCache })).toEqual({ ok: false });
    expect(await cache.getOrLoad("run_c", "k", loader, { shouldCache })).toEqual({ ok: true });
    expect(cache.has("run_c", "k")).toBe(true);
    await cache.getOrLoad("run_c", "k", loader, { shouldCache });
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("caches unconditionally when no shouldCache predicate is supplied", async () => {
    const cache = new RunScopedCache();
    const loader = vi.fn(async () => ({ ok: false }));
    await cache.getOrLoad("run_d", "k", loader);
    await cache.getOrLoad("run_d", "k", loader);
    expect(loader).toHaveBeenCalledTimes(1);
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
    // canonicalArticleBody is gone (R-23): the envelope contract comes from the article_body node's
    // own produces/outputSchema, never from per-project configuration.
    expect(context.projectContract).not.toHaveProperty("canonicalArticleBody");
    expect(context.projectContract.contentContract).toBeDefined();
    // The bundle carries the article_body node's OWN outputSchema (the client-shaped envelope) —
    // never the deleted workspace-local {schema_version, nodes} monolith.
    const articleBodySchema = context.articleBodySchema as { required: string[]; properties: Record<string, unknown> };
    expect(articleBodySchema.required).toEqual(["artifact", "summary", "clientProjectId", "clientObjectType", "contractSource", "body"]);
    expect(articleBodySchema.properties).not.toHaveProperty("schema_version");
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

  // Provider-error-details: the failure reason must show WHY, not just the bare code, when the failed
  // node's persisted output carries a classified provider error or our own budget guard's remedy.
  it("recommends retry_node and appends the provider's own message + operator remedy for a classified provider error", () => {
    const failed: NodeExecutionState = {
      nodeId: "article_body", status: "failed", errors: ["provider_quota", "Node received 429 ..."],
      output: { error: { code: "provider_quota", message: "Node received 429 ...", providerStatus: 429, providerMessage: "Your credit balance is too low", operatorAction: "Top up openai credit for this project's key, then workflow.retry_node article_body." } }
    };
    const plan = planRun(run({ nodes: [failed], status: "failed" }));
    expect(plan.strategy).toBe("retry_node");
    expect(plan.retryNodeId).toBe("article_body");
    expect(plan.reason).toContain("Run failed at article_body (provider_quota) — Your credit balance is too low. Top up openai credit");
  });

  it("appends only the operator remedy (no dangling dash) for budget_exceeded, which never carries a providerMessage", () => {
    const failed: NodeExecutionState = {
      nodeId: "article_body", status: "failed", errors: ["budget_exceeded", "Node stopped before the model turn..."],
      output: { error: { code: "budget_exceeded", message: "Node stopped before the model turn...", operatorAction: "Run budget 0.5 USD reached (spent 0.5). Raise the budget or stop." } }
    };
    const plan = planRun(run({ nodes: [failed], status: "failed" }));
    expect(plan.reason).toContain("Run failed at article_body (budget_exceeded) — Run budget 0.5 USD reached");
    expect(plan.reason).not.toContain("undefined");
  });

  it("leaves the reason exactly as before for a failure with no provider-error fields", () => {
    const failed: NodeExecutionState = { nodeId: "article_body", status: "failed", errors: ["max_turns_exceeded", "exhausted its agent-loop turn budget"], output: { error: { code: "max_turns_exceeded", message: "exhausted its agent-loop turn budget" } } };
    const plan = planRun(run({ nodes: [failed], status: "failed" }));
    expect(plan.reason).toBe(`Run failed at article_body (max_turns_exceeded) with 0 completed stage(s) intact. workflow.retry_node with nodeId "article_body" re-runs just that node and continues; nothing completed is recomputed.`);
  });
});
