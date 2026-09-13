import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the Agent config the runner builds so the schema actually handed to the Responses API can
// be asserted without a network call. Everything else is the inert harness openaiNodeRunner.test.ts uses.
const agentConfigs: any[] = [];
const runMock = vi.fn(async () => ({
  finalOutput: { artifact: "materialization_spec.v1", summary: "Offline spec.", clientProjectId: "p", clientObjectType: "content_item", requestId: "r", slots: [] },
  rawResponses: [{ usage: { inputTokens: 10, outputTokens: 5 } }],
  lastResponseId: "resp_rf_1"
}));
vi.mock("@openai/agents", () => ({
  OpenAIProvider: class { async getModel(name?: string) { return { name, async getResponse() { return { usage: { inputTokens: 0, outputTokens: 0 }, output: [] }; }, async *getStreamedResponse() {} } as any; } },
  Agent: class { constructor(config: unknown) { agentConfigs.push(config); } },
  run: (...args: unknown[]) => runMock(...(args as [])),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class { constructor(_client: unknown, _model: string) {} }
}));

import { executeNode } from "../../../src/agent/workspace/nodeRuntime.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";

describe("OpenAI response_format is derived, not the raw node schema (B1)", () => {
  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; runMock.mockClear(); agentConfigs.length = 0; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  it("sends artifact_plan without the root if/then the Responses API refuses", async () => {
    // artifact_plan is a canonical node whose output schema carries a root-level if/then invariant
    // ("a spec with slots must declare artifactProtocol"). Before B1 this schema went to OpenAI
    // verbatim and the request was rejected 400 before the model saw a token.
    const canonical = listWorkspaceNodes().find((node) => node.id === "artifact_plan")!.outputSchema as any;
    expect(canonical.if).toBeDefined();

    // Dependency stubs only exist to get the node to the dispatch: this test asserts what was SENT,
    // not what came back.
    const dependencyOutputs = { brief_architect: { mediaSlots: [] }, contract_intelligence: {}, draft_writer: {} };
    await executeNode({ nodeId: "artifact_plan", input: {}, dependencyOutputs, executionMode: "openai" }).catch(() => undefined);

    expect(agentConfigs).toHaveLength(1);
    const sent = agentConfigs[0].outputType;
    expect(sent.type).toBe("json_schema");
    expect(sent.schema.if).toBeUndefined();
    expect(sent.schema.then).toBeUndefined();
    // The enforceable half survives — a bare {} would tell the model nothing.
    expect(sent.schema.type).toBe("object");
    expect(sent.schema.required).toEqual(canonical.required);
    expect(Object.keys(sent.schema.properties)).toEqual(Object.keys(canonical.properties));
    // The model still READS the full rule: the prompt payload carries the untouched node schema.
    expect(agentConfigs[0].instructions).toBeTruthy();
  });
});
