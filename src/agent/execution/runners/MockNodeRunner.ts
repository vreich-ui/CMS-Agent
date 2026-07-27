import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { NodeRunner, NodeRunnerInput, NodeRunnerResult } from "./NodeRunner.js";
import type { NodeRunnerContext, ExecutionMode } from "../executionContext.js";
import { mockValueFromSchema, type MockHints } from "../mockOutputFromSchema.js";
import type { WorkflowExecutionRecord } from "../../workspace/executionTypes.js";

// Dry-run outputs are DERIVED from each node's own output schema (R-17). They used to be hand-written
// literals, which is how `article_body` came to emit a shape that failed all six required fields of its
// schema after the node was generalized to a contract-driven envelope, and how `publish_payload` came
// to omit the `summary` its schema requires. A fixture generated from the schema cannot drift from it.
//
// The dry-run markers are HINTS rather than a fixed shape: mockValueFromSchema applies them only where
// the schema permits, so a strict schema is never polluted to make the fixture read nicely.

export const mockHintsForNode = (node: WorkspaceNode, run?: WorkflowExecutionRecord): MockHints => {
  const hints: MockHints = {
    summary: `Dry-run mock output for ${node.name}.`,
    nodeId: node.id,
    dryRun: true,
    dependencyOutputs: node.dependsOn
  };
  // The payload builder is the one node whose dry-run value is genuinely more useful carrying the body
  // it was handed, so a reader can see the handoff actually happened.
  if (node.id === "publish_payload") {
    hints.target = "preview";
    hints.publicationSideEffects = false;
    if (run) hints.articleBody = run.stageOutputs.article_body;
  }
  return hints;
};

export const mockOutputForNode = (node: WorkspaceNode, run?: WorkflowExecutionRecord): unknown =>
  mockValueFromSchema(node.outputSchema, mockHintsForNode(node, run));

export class MockNodeRunner implements NodeRunner {
  supports(mode: ExecutionMode) { return mode === "mock"; }
  validateConfiguration(_node: WorkspaceNode) { return { ok: true as const }; }
  async run({ node }: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult> {
    return { ok: true, output: mockOutputForNode(node, context.run) };
  }
}
