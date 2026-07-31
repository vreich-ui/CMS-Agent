import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two limits that "existed" without holding (the node-limits audit, run_1785435947311_jl8hl4):
//   1. toolCallLimit fed the maxTurns derivation and bounded NOTHING — no code counted invocations
//      against it. It is now an enforced per-execution cap with a named denial the model can read.
//   2. tool results entered the model conversation unbounded (only web.fetch had a byte cap), and
//      the conversation is re-sent on every subsequent turn — artifact_plan reached 386K input
//      tokens for a 3K output exactly this way. Every controlled-tool result is now bounded before
//      it enters the conversation, with the truncation explicit.
import { boundToolResult, DEFAULT_TOOL_RESULT_MAX_CHARS, OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import { createToolRegistry } from "../../../src/agent/tools/toolRegistry.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const { runMock, toolCallOutcomes } = vi.hoisted(() => {
  const outcomes: Array<{ ok: boolean; message?: string }> = [];
  return {
    toolCallOutcomes: outcomes,
    runMock: vi.fn(async (agent: any) => {
      // Simulate a model that keeps calling its first tool past the limit; the SDK forwards a
      // thrown tool error's message back to the model, so record what each call produced.
      const sdkTool = agent.config.tools[0];
      for (let i = 0; i < 4; i++) {
        try { await sdkTool.execute({ id: "research" }); outcomes.push({ ok: true }); }
        catch (error) { outcomes.push({ ok: false, message: (error as Error).message }); }
      }
      return { finalOutput: { artifact: "research_brief.v1", summary: "done" }, rawResponses: [{ usage: { inputTokens: 10, outputTokens: 5 } }], lastResponseId: "resp_1" };
    })
  };
});
vi.mock("@openai/agents", () => ({
  Agent: class { config: unknown; constructor(config: unknown) { this.config = config; } },
  run: (...args: unknown[]) => runMock(...(args as [any])),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} },
  OpenAIProvider: class { async getModel(name?: string) { return { name, async getResponse() { return { usage: { inputTokens: 0, outputTokens: 0 }, output: [] }; }, async *getStreamedResponse() {} } as any; } }
}));

const makeRun = (): WorkflowExecutionRecord => ({
  runId: "run-limit-probe", workflowId: "publishing_conductor", projectId: "p", status: "running",
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai"
});

describe("toolCallLimit is an enforced cap, not just a turn-budget input", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); toolCallOutcomes.length = 0; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("refuses calls beyond the limit with a named denial the model can read, and records the calls", async () => {
    const nodes = await repositoryManager.getWorkspaceRepository().getNodes();
    const research = nodes.find((node) => node.id === "research")!;
    const runner = new OpenAINodeRunner();
    const result = await runner.run(
      { node: { ...research, modelConfig: { ...research.modelConfig, toolCallLimit: 2, budgetUsd: undefined } }, input: {} },
      { run: makeRun(), executionRepository: repositoryManager.getExecutionRepository() }
    );

    expect(result.ok).toBe(true);
    expect(toolCallOutcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
    const denied = toolCallOutcomes.filter((outcome) => !outcome.ok);
    expect(denied).toHaveLength(2);
    expect(denied[0].message).toMatch(/tool_denied:tool_call_limit_exceeded/);
    expect(denied[0].message).toMatch(/all 2 of its allowed tool calls/);
    // The per-call audit stubs travel with the result: 2 successes + 2 named denials.
    expect(result.toolCalls).toHaveLength(4);
    expect(result.toolCalls!.filter((call) => call.status === "denied" && call.errorCode === "tool_call_limit_exceeded")).toHaveLength(2);
  });
});

describe("boundToolResult — the per-result conversation cap", () => {
  it("passes small results through untouched", () => {
    const value = { ok: true, data: "small" };
    expect(boundToolResult(value, DEFAULT_TOOL_RESULT_MAX_CHARS)).toBe(value);
  });

  it("replaces an oversized result with an explicit truncation envelope, never a silent slice", () => {
    const value = { blob: "x".repeat(50_000) };
    const bounded = boundToolResult(value, 10_000) as { truncated: boolean; originalChars: number; note: string; preview: string };
    expect(bounded.truncated).toBe(true);
    expect(bounded.originalChars).toBeGreaterThan(50_000);
    expect(bounded.preview).toHaveLength(10_000);
    expect(bounded.note).toMatch(/narrower/i);
  });
});

describe("stage.list_outputs returns bounded summaries, never full values", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  it("lists id/stage/size/preview and omits the value itself", async () => {
    const ws = repositoryManager.getWorkspaceRepository();
    await ws.saveStageOutput("draft_writer", { artifact: "draft.v1", body: "y".repeat(5_000) }, "stage_big");
    const tool = createToolRegistry().find((t) => t.toolId === "stage.list_outputs")!;
    const result: any = await tool.handler({ stage: "draft_writer" }, { runId: "r", nodeId: "n" } as any);
    const outputs = result.data.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ id: "stage_big", stage: "draft_writer" });
    expect(outputs[0].valueChars).toBeGreaterThan(5_000);
    expect((outputs[0].preview as string).length).toBeLessThanOrEqual(240);
    expect(outputs[0].value).toBeUndefined();
    // The summary is two orders of magnitude smaller than the value it describes.
    expect(JSON.stringify(outputs[0]).length).toBeLessThan(600);
  });
});
