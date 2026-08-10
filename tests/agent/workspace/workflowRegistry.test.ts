import { describe, expect, it } from "vitest";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { composeWorkflowNodes, isTailNode, publishingTailNodeIds } from "../../../src/agent/workspace/publishingTail.js";
import { getWorkflowDefinition, listRegisteredWorkflowIds, registerWorkflow } from "../../../src/agent/workspace/workflowRegistry.js";
import { __test__, publishingConductorWorkflowId } from "../../../src/agent/workspace/executor.js";

// §2.23 — minimal multi-workflow plumbing at the seam that matters. The registry is prepared but NOT
// activated: publishing_conductor is the only shipped entry, and everything an existing run does is
// byte-identical (unknown workflowIds fall back to the publishing_conductor canonical set).

describe("§2.23 workflow registry", () => {
  it("ships publishing_conductor as the only registered workflow, resolving the canonical array", () => {
    expect(listRegisteredWorkflowIds()).toEqual([publishingConductorWorkflowId]);
    expect(getWorkflowDefinition(publishingConductorWorkflowId)?.canonicalNodes()).toEqual(listWorkspaceNodes());
    expect(getWorkflowDefinition("money_page")).toBeUndefined();
  });

  it("refuses a duplicate registration", () => {
    expect(() => registerWorkflow({ workflowId: publishingConductorWorkflowId, canonicalNodes: listWorkspaceNodes })).toThrowError(/already registered: publishing_conductor/);
  });

  it("lets a future workflow register a composed node array (different upstream + the shared tail) and the executor resolve it by workflowId", async () => {
    const upstream = listWorkspaceNodes()
      .filter((node) => !isTailNode(node.id))
      .map((node) => ({ ...node, id: `money_${node.id}`, dependsOn: node.dependsOn.map((dependency) => `money_${dependency}`), requiredInputs: node.requiredInputs.map((input) => (input.includes(".") ? input : `money_${input}`)) }));
    const binding = {
      contract_intelligence: ["money_brief_architect"],
      article_body: ["money_review_aggregator", "money_draft_writer", "money_narrative_movement", "money_angle_strategy"]
    } as const;
    registerWorkflow({ workflowId: "money_page_test", canonicalNodes: () => composeWorkflowNodes(upstream, binding) });

    const resolved = await __test__.resolveConductorNodes(undefined, "money_page_test");
    expect(resolved.map((node) => node.id)).toEqual([...upstream.map((node) => node.id), ...publishingTailNodeIds]);
    expect(resolved.find((node) => node.id === "contract_intelligence")?.dependsOn).toEqual(["money_brief_architect"]);
    // The shared tail's publish gates travel with it.
    expect(resolved.find((node) => node.id === "publish_executor")?.riskLevel).toBe("publish");
  });

  it("keeps behavior byte-identical for existing runs: an unregistered workflowId resolves the publishing_conductor canonical set", async () => {
    const resolved = await __test__.resolveConductorNodes(undefined, "some_legacy_stamp");
    expect(resolved.map((node) => node.id)).toEqual(listWorkspaceNodes().map((node) => node.id));
  });
});
