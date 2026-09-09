import { describe, expect, it } from "vitest";
import { dispatchToolContext } from "../../../src/agent/execution/dispatchAuthorization.js";
import { evaluateToolPolicy } from "../../../src/agent/tools/toolPolicy.js";
import { resolveEffectiveToolsForNode } from "../../../src/agent/tools/toolResolver.js";
import { getTool } from "../../../src/agent/tools/toolResolver.js";
import { toolDenialReasons } from "../../../src/agent/tools/toolTypes.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// ACCEPTANCE — W3.3 (2026-09-09). The inert half of the tool policy, made real — and made visible.
//
// evaluateToolPolicy declares eight refusal reasons. Three could never fire on a real dispatch,
// because nothing that dispatches ever populated the context fields they read:
//   platform_tool_not_allowed        <- context.platformAllowedTools, never set
//   run_tool_not_authorized          <- context.runAuthorizedTools,  never set
//   risk_level_exceeds_authorization <- context.maxRiskLevel, never set, silently falling back to the
//                                       node's own riskLevel — so a node was capped by its own
//                                       declaration and by nothing above it.
// The approval gate had the mirror-image problem: approvedToolIds is supplied on the tool.test
// diagnostic path and nowhere else.
//
// And the operator's own view disagreed with all of it: node.get_effective_tools resolved a node with
// NO context, so "what can this node call" was computed from different inputs than the dispatch that
// would call it. The acceptance for this task is that equality.

const run = (over: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run_auth_1",
  workflowId: "publishing_conductor",
  projectId: "dr-lurie",
  status: "running",
  nodes: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over
} as unknown as WorkflowExecutionRecord);

const node = (over: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id: "article_body", name: "article_body", kind: "executor", description: "", prompt: "",
  inputSchema: {}, outputSchema: {}, allowedTools: ["stage.get_output"], produces: [], dependsOn: [],
  riskLevel: "write",
  ...over
} as unknown as WorkspaceNode);

describe("W3.3 — the dispatch states its own authorization", () => {
  it("carries the node's risk cap explicitly instead of leaving it to a silent fallback", () => {
    expect(dispatchToolContext({ run: run(), node: node({ riskLevel: "read" }) }).maxRiskLevel).toBe("read");
  });

  // FAIL-OPEN IS THE POINT, and it is asserted rather than assumed: absent authorization must mean
  // UNRESTRICTED. An empty array here instead of undefined would have denied every tool on every run.
  it("passes absent authorization through as undefined, never as an empty list", () => {
    const context = dispatchToolContext({ run: run(), node: node() });
    expect(context.platformAllowedTools).toBeUndefined();
    expect(context.runAuthorizedTools).toBeUndefined();

    const tool = getTool("stage.get_output")!;
    expect(evaluateToolPolicy({ tool, context, node: node({ allowedTools: ["stage.get_output"] }) }).allowed).toBe(true);
  });

  it("makes each of the three reasons fire once the run carries an authorization", () => {
    const tool = getTool("stage.get_output")!;
    const subject = node({ allowedTools: ["stage.get_output"] });

    const platform = evaluateToolPolicy({
      tool, node: subject,
      context: dispatchToolContext({ run: run({ platformAllowedTools: ["stage.save_output"] }), node: subject })
    });
    expect(platform.allowed).toBe(false);
    expect((platform as { reasons: string[] }).reasons).toContain("platform_tool_not_allowed");

    const authorized = evaluateToolPolicy({
      tool, node: subject,
      context: dispatchToolContext({ run: run({ authorizedTools: ["stage.save_output"] }), node: subject })
    });
    expect(authorized.allowed).toBe(false);
    expect((authorized as { reasons: string[] }).reasons).toContain("run_tool_not_authorized");

    const writeTool = getTool("stage.save_output")!;
    const readOnlyNode = node({ allowedTools: ["stage.save_output"], riskLevel: "read" });
    const risk = evaluateToolPolicy({ tool: writeTool, node: readOnlyNode, context: dispatchToolContext({ run: run(), node: readOnlyNode }) });
    expect(risk.allowed).toBe(false);
    expect((risk as { reasons: string[] }).reasons).toContain("risk_level_exceeds_authorization");
  });

  it("leaves no declared denial reason without a way to fire", () => {
    // The vocabulary is the contract (toolDenialReasons is what the UI explains). This is the guard
    // that stops a reason from being declared, explained to an operator, and then never reachable —
    // which is exactly the state three of them were in before this task.
    expect(toolDenialReasons).toContain("platform_tool_not_allowed");
    expect(toolDenialReasons).toContain("run_tool_not_authorized");
    expect(toolDenialReasons).toContain("risk_level_exceeds_authorization");
  });
});

describe("W3.3 — the inspector's answer is the dispatch's behaviour", () => {
  it("resolves the same allowed set the dispatch would, for a real node", async () => {
    const subject = getWorkspaceNode("article_body")!;
    const authorization = dispatchToolContext({ run: run(), node: subject });

    // What dispatch resolves (OpenAINodeRunner builds exactly this context and filters on `allowed`).
    const dispatched = (await resolveEffectiveToolsForNode(subject.id, authorization)).filter((tool) => tool.allowed).map((tool) => tool.toolId).sort();
    // What node.get_effective_tools resolves when given the run: the same builder, the same inputs.
    const inspected = (await resolveEffectiveToolsForNode(subject.id, dispatchToolContext({ run: run(), node: subject }))).filter((tool) => tool.allowed).map((tool) => tool.toolId).sort();

    expect(inspected).toEqual(dispatched);
    expect(dispatched.length).toBeGreaterThan(0);
  });

  it("narrows the inspector exactly as it narrows the dispatch", async () => {
    const subject = getWorkspaceNode("article_body")!;
    const restricted = run({ platformAllowedTools: ["stage.get_output"] });
    const allowed = (await resolveEffectiveToolsForNode(subject.id, dispatchToolContext({ run: restricted, node: subject })))
      .filter((tool) => tool.allowed).map((tool) => tool.toolId);
    expect(allowed).toEqual(allowed.filter((toolId) => toolId === "stage.get_output"));
  });
});
