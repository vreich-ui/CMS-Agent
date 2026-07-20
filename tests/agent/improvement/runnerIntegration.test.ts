import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Agents SDK: run() answers from a scripted queue (so pairwise orderings can disagree),
// Agent captures its construction config, and OpenAIChatCompletionsModel captures (client, model)
// so provider wiring is observable without a network call.
const captured = vi.hoisted(() => ({
  agentConfigs: [] as any[],
  runPrompts: [] as string[],
  compatModels: [] as Array<{ baseURL?: string; apiKey?: string; model: string }>,
  queue: [] as any[]
}));
vi.mock("@openai/agents", () => ({
  Agent: class { constructor(config: unknown) { captured.agentConfigs.push(config); } },
  run: vi.fn(async (_agent: unknown, prompt: string) => {
    captured.runPrompts.push(prompt);
    const next = captured.queue.shift();
    if (!next) throw new Error("runner mock queue empty");
    return { finalOutput: next, rawResponses: [{ usage: { inputTokens: 50, outputTokens: 20 } }], lastResponseId: "resp_mock" };
  }),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(client: { baseURL?: string; apiKey?: string }, model: string) { captured.compatModels.push({ baseURL: client?.baseURL, apiKey: client?.apiKey, model }); } }
}));
vi.mock("openai", () => ({ default: class { baseURL?: string; apiKey?: string; constructor(options: { baseURL?: string; apiKey?: string }) { this.baseURL = options?.baseURL; this.apiKey = options?.apiKey; } } }));

import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { applyPlaybookDelta } from "../../../src/agent/improvement/playbook.js";
import { scoreOutput, comparePairwise, JUDGE_NODE_ID } from "../../../src/agent/improvement/rubricJudge.js";
import { resolveProvider } from "../../../src/agent/execution/providers/providerRegistry.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import type { EvalRubric } from "../../../src/agent/improvement/improvementTypes.js";

const savedEnv = { ...process.env };
beforeEach(() => {
  resetRepositoryManager();
  process.env.OPENAI_API_KEY = "test-key";
  captured.agentConfigs.length = 0;
  captured.runPrompts.length = 0;
  captured.compatModels.length = 0;
  captured.queue.length = 0;
});
afterEach(() => { process.env = { ...savedEnv }; resetRepositoryManager(); });

const rubric: EvalRubric = {
  rubricId: "rubric_runner_test",
  nodeId: "input_triage",
  name: "Runner-path rubric",
  description: "test",
  status: "active",
  criteria: [{ id: "quality", name: "Quality", description: "overall", weight: 1, scaleMax: 5 }],
  passThreshold: 0.5,
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const judgeDeps = () => ({ evaluationRepository: repositoryManager.getEvaluationRepository(), executionRepository: repositoryManager.getExecutionRepository() });

describe("playbook injection (replaces global observations — gap §6)", () => {
  it("injects the node-scoped playbook into the prompt and never the observations key", async () => {
    const improvementRepository = repositoryManager.getImprovementRepository();
    await improvementRepository.savePlaybook(applyPlaybookDelta(undefined, "input_triage", { add: [{ text: "Always restate the envelope id.", kind: "strategy" }] }, new Date().toISOString()));
    captured.queue.push({ artifact: "content_source.v1", summary: "with playbook" });

    const result: any = await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });
    expect(result.execution.status).toBe("completed");
    expect(captured.runPrompts[0]).toContain("Always restate the envelope id.");
    expect(captured.runPrompts[0]).toContain("playbook");
    expect(captured.runPrompts[0]).not.toContain("\"observations\"");
  });

  it("omits the playbook key entirely for nodes without one", async () => {
    // Memory repositories are static per backend, so the previous test's playbook survives the
    // manager reset — clear it explicitly to model a node with no lessons.
    await repositoryManager.getImprovementRepository().savePlaybook({ nodeId: "input_triage", items: [], budget: { maxItems: 12, maxChars: 2000 }, version: 1, updatedAt: new Date().toISOString() });
    captured.queue.push({ artifact: "content_source.v1", summary: "no playbook" });
    const result: any = await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });
    expect(result.execution.status).toBe("completed");
    expect(captured.runPrompts[0]).not.toContain("\"playbook\"");
    expect(captured.runPrompts[0]).not.toContain("\"observations\"");
  });
});

describe("synthetic judge through the real runner", () => {
  it("scores via the LLM judge (empty allowedTools short-circuit) and records judge usage", async () => {
    captured.queue.push({ scores: [{ criterionId: "quality", score: 4, evidence: "well structured" }] });
    const result = await scoreOutput({ rubric, nodeId: "input_triage", output: { summary: "judge me" }, mode: "openai" }, judgeDeps());

    expect(result.normalizedScore).toBe(0.8);
    expect(result.pass).toBe(true);
    expect(result.judge.mode).toBe("openai");
    const usage = await repositoryManager.getUsageRepository().list({ nodeId: JUDGE_NODE_ID });
    expect(usage.length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces position bias as an inconsistent pairwise verdict (a judge that always answers A)", async () => {
    captured.queue.push({ winner: "A", rationale: "first looked better" });
    captured.queue.push({ winner: "A", rationale: "first looked better again" });
    const comparison = await comparePairwise({ rubric, nodeId: "input_triage", champion: { v: 1 }, challenger: { v: 2 }, mode: "openai" }, judgeDeps());

    expect(comparison.orderings).toHaveLength(2);
    expect(comparison.orderings[0]!.winner).toBe("champion");
    expect(comparison.orderings[1]!.winner).toBe("challenger");
    expect(comparison.verdict).toBe("inconsistent");
  });

  it("agreeing orderings yield a decisive verdict", async () => {
    captured.queue.push({ winner: "B", rationale: "second is stronger" });
    captured.queue.push({ winner: "A", rationale: "first is stronger" });
    const comparison = await comparePairwise({ rubric, nodeId: "input_triage", champion: { v: 1 }, challenger: { v: 2 }, mode: "openai" }, judgeDeps());
    expect(comparison.verdict).toBe("challenger");
  });
});

describe("provider registry", () => {
  const runner = new OpenAINodeRunner();
  const nodeStub = (modelConfig: Record<string, unknown>) => ({ id: "stub", name: "stub", description: "", prompt: "p", allowedTools: [], dependsOn: [], produces: [], riskLevel: "read", status: "active", outputSchema: { type: "object" }, modelConfig }) as any;

  it("resolves presets and rejects invalid configurations before any run exists", () => {
    expect(resolveProvider({}).label).toBe("openai");
    expect(resolveProvider({ provider: "google" })).toMatchObject({ kind: "openai_compatible", apiKeyEnv: "GEMINI_API_KEY" });
    expect(runner.validateConfiguration(nodeStub({ provider: "made_up" }))).toMatchObject({ ok: false });
    expect(runner.validateConfiguration(nodeStub({ provider: "openai_compatible" }))).toMatchObject({ ok: false });
    expect(runner.validateConfiguration(nodeStub({ provider: "google" }))).toMatchObject({ ok: true });
  });

  it("gates on the provider's API-key env NAME, not OPENAI_API_KEY", async () => {
    delete process.env.GEMINI_API_KEY;
    const run = { runId: "prov_test", workflowId: "w", projectId: "p", status: "running", startedAt: "", updatedAt: "", nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai" } as any;
    const denied = await runner.run({ node: nodeStub({ provider: "google", model: "gemini-3.1-flash-lite" }), input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() } as any);
    expect(denied).toMatchObject({ ok: false, code: "invalid_node_configuration" });
    expect((denied as { message: string }).message).toContain("GEMINI_API_KEY");
  });

  it("builds a chat-completions model bound to the compatible endpoint", async () => {
    process.env.GEMINI_API_KEY = "gemini-test-key";
    captured.queue.push({ anything: true });
    const run = { runId: "prov_test2", workflowId: "w", projectId: "p", status: "running", startedAt: "", updatedAt: "", nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai" } as any;
    const result = await runner.run({ node: nodeStub({ provider: "google", model: "gemini-3.1-flash-lite" }), input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() } as any);

    expect(result.ok).toBe(true);
    expect(captured.compatModels).toHaveLength(1);
    expect(captured.compatModels[0]).toMatchObject({ model: "gemini-3.1-flash-lite", apiKey: "gemini-test-key" });
    expect(captured.compatModels[0]!.baseURL).toContain("generativelanguage.googleapis.com");
    const usage = await repositoryManager.getUsageRepository().list({ runId: "prov_test2" });
    expect(usage[0]?.provider).toBe("google");
  });
});
