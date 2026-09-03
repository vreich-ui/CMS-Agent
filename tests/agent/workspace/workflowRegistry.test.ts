import { describe, expect, it } from "vitest";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { composeWorkflowNodes, isTailNode, publishingTailNodeIds } from "../../../src/agent/workspace/publishingTail.js";
import { getWorkflowDefinition, listRegisteredWorkflowIds, registerWorkflow } from "../../../src/agent/workspace/workflowRegistry.js";
import { __test__, publishingConductorWorkflowId } from "../../../src/agent/workspace/executor.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";

// §2.23 — minimal multi-workflow plumbing at the seam that matters. The registry now carries THREE
// shipped entries: publishing_conductor (the canonical array), capture_conductor (since T12.9,
// registered by captureConductorWorkflow.ts) and, since T13.1, clone_conductor (registered by
// cloneConductorWorkflow.ts) — both side-effect-imported by executor.ts, which this file imports, so
// all three registrations are present here exactly as on every run-driving plane. Everything an
// existing run does is byte-identical (unknown workflowIds still fall back to the publishing_conductor
// canonical set).

describe("§2.23 workflow registry", () => {
  it("ships publishing_conductor, capture_conductor, clone_conductor and visual_identity as the registered workflows, resolving the canonical arrays", () => {
    expect(listRegisteredWorkflowIds()).toEqual([publishingConductorWorkflowId, "capture_conductor", "clone_conductor", "visual_identity"]);
    expect(getWorkflowDefinition(publishingConductorWorkflowId)?.canonicalNodes()).toEqual(listWorkspaceNodes());
    expect(getWorkflowDefinition("capture_conductor")?.canonicalNodes().map((node) => node.id)).toContain("capture_crawl");
    expect(getWorkflowDefinition("clone_conductor")?.canonicalNodes().map((node) => node.id)).toContain("clone_intake");
    // C5's pair — two nodes, no composed tail: visual_identity publishes nothing (visual_standard is
    // not a publishable type), so it is the first registered workflow that carries no tail node at all.
    expect(getWorkflowDefinition("visual_identity")?.canonicalNodes().map((node) => node.id)).toEqual(["brand_imagery_writer", "visual_standard_materializer"]);
    expect(getWorkflowDefinition("money_page")).toBeUndefined();
  });

  // REVIEW — R-17's rule ("dry-run outputs are DERIVED from each node's own output schema") only
  // holds if the derivation can actually satisfy the schema. brand_imagery_writer's outputSchema
  // declares a hex-pattern palette and a patternProperties-keyed aspectRatios map with
  // minProperties: 1, and mockValueFromSchema could satisfy neither — so every mock traversal of
  // visual_identity failed at the writer with output_schema_violation, and the materializer's own
  // "a mock run falls through so CI graph traversal keeps working" branch was unreachable in a real
  // run. Asserted across every registered workflow, so the next schema that outruns the generator
  // fails here rather than the first time somebody dry-runs it.
  it("every registered workflow's nodes have a dry-run output their own schema accepts", () => {
    for (const workflowId of listRegisteredWorkflowIds()) {
      for (const node of getWorkflowDefinition(workflowId)?.canonicalNodes() ?? []) {
        const mock = mockOutputForNode(node);
        const validation = validateOutput(mock, node.outputSchema);
        expect(validation.ok, `${workflowId}/${node.id}: ${JSON.stringify(validation.ok ? [] : validation.errors)}`).toBe(true);
      }
    }
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
      artifact_plan: ["money_brief_architect", "money_draft_writer"],
      artifact_materializer: ["money_brief_architect"],
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
