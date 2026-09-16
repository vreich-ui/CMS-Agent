import { describe, expect, it } from "vitest";
import "../../../src/agent/workspace/captureConductorWorkflow.js";
import "../../../src/agent/workspace/cloneConductorWorkflow.js";
import "../../../src/agent/workspace/visualIdentityWorkflow.js";
import "../../../src/agent/workspace/pdfTemplateStudioWorkflow.js";
import "../../../src/agent/workspace/assetLookupWorkflow.js";
import "../../../src/agent/workspace/documentRenderWorkflow.js";
import "../../../src/agent/workspace/imageTemplateRevisionWorkflow.js";
import { getWorkflowDefinition, listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import { resolveExecutionKind } from "../../../src/agent/workspace/routeRegistry.js";
import { algorithmFor, describedNodeIds } from "../../../src/agent/workspace/nodeAlgorithms.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// W4 acceptance. A deterministic node explains itself through this or not at all: its prompt tab is
// empty by construction and its Tools tab is empty by construction (a deterministic route consults
// no node grant). The test WALKS THE REGISTRY rather than a list, so a new deterministic node — or
// an existing model node that gains a deterministic route — cannot ship without an explanation.

const deterministicNodes = (): Array<{ workflowId: string; node: WorkspaceNode }> => {
  const out: Array<{ workflowId: string; node: WorkspaceNode }> = [];
  for (const workflowId of listRegisteredWorkflowIds()) {
    for (const node of getWorkflowDefinition(workflowId)!.canonicalNodes()) {
      if (resolveExecutionKind(node) === "deterministic") out.push({ workflowId, node });
    }
  }
  return out;
};

describe("every deterministic node can explain itself", () => {
  it("covers every deterministic node in every registered workflow", () => {
    const missing = deterministicNodes()
      .filter(({ node }) => algorithmFor(node) === null)
      .map(({ workflowId, node }) => `${node.id} (${workflowId})`);
    expect(missing, "deterministic nodes with no algorithm — add one in src/agent/workspace/nodeAlgorithms.ts").toEqual([]);
  });

  it("gives each one numbered steps, a source to check against, and what it reads", () => {
    for (const { node } of deterministicNodes()) {
      const algorithm = algorithmFor(node)!;
      expect(algorithm.steps.length, `${node.id} has too few steps to be an explanation`).toBeGreaterThanOrEqual(2);
      expect(algorithm.summary.length, `${node.id} has no summary`).toBeGreaterThan(20);
      expect(algorithm.reads.length, `${node.id} does not say what it reads`).toBeGreaterThanOrEqual(1);
      expect(algorithm.source, `${node.id} names no implementing module`).toMatch(/^src\/agent\//);
    }
  });

  it("takes the engine's tenant verbs from the route manifest rather than re-typing them", () => {
    // capture_emit_live is the node whose verb list is longest and most load-bearing; if this ever
    // comes back empty, the composition from ROUTE_MANIFESTS has broken and the panel would be
    // telling an operator that the emission stage touches no tenant.
    const emit = deterministicNodes().find(({ node }) => node.id === "capture_emit_live")!;
    const algorithm = algorithmFor(emit.node)!;
    expect(algorithm.route?.routeId).toBe("capture_stage");
    expect(algorithm.route?.phaseId).toBe("emit_live");
    expect(algorithm.engineTools.map((tool) => tool.verb)).toContain("object_create");
    expect(algorithm.engineTools.some((tool) => tool.risk === "write")).toBe(true);

    // ...and a local-computation stage reports an EMPTY list, which is a fact about it, not a gap.
    const report = deterministicNodes().find(({ node }) => node.id === "capture_report")!;
    expect(algorithmFor(report.node)!.engineTools).toEqual([]);
  });

  it("returns null for a model node — its explanation is its prompt", () => {
    const modelNode = getWorkflowDefinition("publishing_conductor")!.canonicalNodes().find((node) => resolveExecutionKind(node) === "model")!;
    expect(algorithmFor(modelNode)).toBeNull();
  });

  it("describes no node that is not deterministic anywhere in the registry", () => {
    const deterministicIds = new Set(deterministicNodes().map(({ node }) => node.id));
    const orphans = describedNodeIds().filter((id) => !deterministicIds.has(id));
    expect(orphans, "algorithms written for nodes that are not deterministic (or no longer exist)").toEqual([]);
  });
});
