import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The SDK signals an exhausted agent loop by throwing MaxTurnsExceededError. Reproduced here exactly
// as the SDK raises it — name plus message — so the runner's classification is exercised, not a
// stand-in for it.
class MaxTurnsExceededError extends Error {
  constructor(turns: number) {
    super(`Max turns (${turns}) exceeded`);
    this.name = "MaxTurnsExceededError";
  }
}

const runMock = vi.fn(async (_agent: unknown, _prompt: unknown, options: any) => {
  throw new MaxTurnsExceededError(options?.maxTurns ?? 0);
});
vi.mock("@openai/agents", () => ({
  Agent: class { constructor(_config: unknown) {} },
  run: (...args: unknown[]) => runMock(...(args as [any, any, any])),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
}));

import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// research depends on reader_insight; supplying it lets the node reach execution, which is what these
// tests are about.
const RESEARCH_DEPENDENCIES = { reader_insight: { artifact: "reader_insight.v1", summary: "Upstream reader insight." } };

// run_1785235767862_uvjm83 failed with ["model_error", "Max turns (4) exceeded"] — a generic bucket
// that says nothing about what to change. An exhausted turn budget is a configuration problem with
// one specific fix, and it now reports as one.
describe("turn-cap exhaustion is a distinct, actionable failure", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("reports max_turns_exceeded, not model_error, and names the budget and the knob that raises it", async () => {
    const result: any = await executeNode({ nodeId: "research", input: {}, dependencyOutputs: RESEARCH_DEPENDENCIES, executionMode: "openai" });

    expect(result.execution.status).toBe("failed");
    const [code, message] = result.execution.nodes[0].errors as [string, string];
    expect(code).toBe("max_turns_exceeded");
    expect(code).not.toBe("model_error");
    // Actionable: which node, what the budget was, and what to change.
    expect(message).toContain("research");
    expect(message).toContain("maxTurns");
    expect(message).toContain("toolCallLimit");
  });

  it("does not burn retries re-exhausting the same cap", async () => {
    // research is configured retryCount 1. Retrying an exhausted budget with the same budget can only
    // exhaust it again, so the runner returns immediately instead of paying for a second attempt.
    await executeNode({ nodeId: "research", input: {}, dependencyOutputs: RESEARCH_DEPENDENCIES, executionMode: "openai" });
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved per-node budget to the SDK — above the node's tool-call allowance", async () => {
    await executeNode({ nodeId: "research", input: {}, dependencyOutputs: RESEARCH_DEPENDENCIES, executionMode: "openai" });
    const options = runMock.mock.calls[0]?.[2] as { maxTurns: number };
    expect(options.maxTurns).toBeGreaterThan(12);
  });
});
