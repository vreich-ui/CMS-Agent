import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OpenAI Agents SDK so the runner exercises real output/usage handling without a network
// call. run() returns a schema-valid finalOutput plus token usage; Agent/tool are inert.
const runMock = vi.fn(async () => ({
  finalOutput: { artifact: "content_source.v1", summary: "Live OpenAI summary." },
  rawResponses: [{ usage: { inputTokens: 120, outputTokens: 40 } }],
  lastResponseId: "resp_test_1"
}));
vi.mock("@openai/agents", () => ({
  Agent: class { constructor(_config: unknown) {} },
  run: (...args: unknown[]) => runMock(...(args as [])),
  tool: (definition: unknown) => definition
}));

import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

describe("OpenAINodeRunner output/usage handling (openai mode)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("completes the node with the model output and does not fail on the usage 'actual' marker", async () => {
    const result: any = await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });

    // Previously this failed: the runner spread `actual: true` into the strict usage schema, throwing
    // "unrecognized key: actual" and marking the successful node failed. It now completes.
    expect(result.execution.status).toBe("completed");
    const output = result.execution.nodes[0].output;
    expect(output).toEqual({ artifact: "content_source.v1", summary: "Live OpenAI summary." });
    // The model output has no stray top-level `actual` key.
    expect(output).not.toHaveProperty("actual");
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("records exactly one actual usage record for the run (no schema rejection)", async () => {
    const result: any = await executeNode({ nodeId: "input_triage", input: {}, executionMode: "openai" });
    const usage = await repositoryManager.getUsageRepository().list({ runId: result.execution.runId });

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ status: "actual", provider: "openai", nodeId: "input_triage", inputTokens: 120, outputTokens: 40 });
    // The usage record itself never carries the `actual` boolean (that lives only on the runner result).
    expect(usage[0]).not.toHaveProperty("actual");
  });
});
