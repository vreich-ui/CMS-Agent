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
  // The runner resolves the default provider's Model object to wrap it with the budget guard; the
  // fake run() below never invokes it, so tests exercise the same control flow without a network.
  OpenAIProvider: class { async getModel(name?: string) { return { name, async getResponse() { return { usage: { inputTokens: 0, outputTokens: 0 }, output: [] }; }, async *getStreamedResponse() {} } as any; } },
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
// The judge's standing instructions reach the model through the Agent config; the run prompt carries
// only the per-call payload (output + evidence).
const judgeInstructions = () => String(captured.agentConfigs[0]?.instructions ?? "");

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

  // A judge that simply omits a non-negotiable criterion must not clear it by omission — and the
  // ledger must not record the omission as if the judge had scored a zero.
  it("vetoes a non-negotiable the judge declined to score, with reason not_scored", async () => {
    const gated: EvalRubric = { ...rubric, criteria: [{ id: "quality", name: "Quality", description: "overall", weight: 9, scaleMax: 5 }, { id: "provenance", name: "Provenance", description: "cites its source", weight: 1, scaleMax: 5, criticalMin: 0 }] };
    captured.queue.push({ scores: [{ criterionId: "quality", score: 5, evidence: "excellent" }] });
    const result = await scoreOutput({ rubric: gated, nodeId: "input_triage", output: { summary: "judge me" }, mode: "openai" }, judgeDeps());

    expect(result.pass).toBe(false);
    expect(result.veto).toMatchObject({ criterionId: "provenance", criticalMin: 0, reason: "not_scored" });
    expect(result.scores.find((score) => score.criterionId === "provenance")?.evidence).toBe("criterion not scored by judge");
    // The judge was told the criterion was mandatory before it skipped it.
    expect(judgeInstructions()).toContain("You MUST return a score for it");
  });

  it("fires the floor veto on an explicit zero against criticalMin 0", async () => {
    const gated: EvalRubric = { ...rubric, criteria: [{ id: "quality", name: "Quality", description: "overall", weight: 9, scaleMax: 5 }, { id: "provenance", name: "Provenance", description: "cites its source", weight: 1, scaleMax: 5, criticalMin: 0 }] };
    captured.queue.push({ scores: [{ criterionId: "quality", score: 5, evidence: "excellent" }, { criterionId: "provenance", score: 0, evidence: "no source cited" }] });
    const result = await scoreOutput({ rubric: gated, nodeId: "input_triage", output: { summary: "judge me" }, mode: "openai" }, judgeDeps());

    expect(result.normalizedScore).toBe(0.9); // the mean says pass...
    expect(result.pass).toBe(false);          // ...the non-negotiable says otherwise
    expect(result.veto).toMatchObject({ criterionId: "provenance", score: 0, criticalMin: 0, reason: "at_or_below_floor" });
  });

  it("puts the source contract in front of the judge, and says so in the instructions", async () => {
    captured.queue.push({ scores: [{ criterionId: "quality", score: 4, evidence: "matches the contract's clientObjectType" }] });
    const contract = { clientObjectType: "content_item", contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-01T00:00:00.000Z" } };
    const result = await scoreOutput({ rubric, nodeId: "contract_intelligence", output: { summary: "judge me" }, mode: "openai", evidence: { contract, dependencyOutputs: { brief_architect: { artifact: "article_brief.v1" } } } }, judgeDeps());

    expect(result.evidenceUsed).toEqual(["contract", "dependencyOutputs"]);
    // The evidence travels in the judge's user message, not just in the recorded metadata.
    expect(captured.runPrompts[0]).toContain("content_item");
    expect(judgeInstructions()).toContain("REFERENCE MATERIAL is supplied");
  });

  it("tells the judge plainly when there is no reference material, so it cannot claim a comparison", async () => {
    captured.queue.push({ scores: [{ criterionId: "quality", score: 4, evidence: "internal consistency only" }] });
    const result = await scoreOutput({ rubric, nodeId: "contract_intelligence", output: { summary: "judge me" }, mode: "openai" }, judgeDeps());

    expect(result.evidenceUsed).toEqual([]);
    expect(judgeInstructions()).toContain("NO REFERENCE MATERIAL is supplied");
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
