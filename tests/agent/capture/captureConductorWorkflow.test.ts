import { describe, expect, it } from "vitest";
import { CAPTURE_AI_NODE_IDS, captureConductorNodes, listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { readCaptureStage } from "../../../src/agent/workspace/captureConductorRoutes.js";
import { getWorkflowDefinition } from "../../../src/agent/workspace/workflowRegistry.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { __test__ } from "../../../src/agent/workspace/executor.js";

// T12.9 — the capture_conductor node set's structural law:
//   * deterministic-first: every non-AI node routes through captureStageDeterministic engine code;
//   * exactly THREE model-judgment nodes (R-C3 v2);
//   * the human gate is preserved: no capture node is publish-risk, no capture node can reach a
//     publish-capable tool, and the graph's terminal node is the report.
describe("capture_conductor canonical node set", () => {
  const nodes = listCaptureConductorNodes();

  it("is registered and resolvable by workflowId through the executor's registry seam", async () => {
    expect(getWorkflowDefinition("capture_conductor")?.canonicalNodes().map((node) => node.id)).toEqual(nodes.map((node) => node.id));
    const resolved = await __test__.resolveConductorNodes(undefined, "capture_conductor");
    expect(resolved.map((node) => node.id)).toEqual(nodes.map((node) => node.id));
  });

  it("forms a valid DAG: unique ids, resolvable edges, acyclic, requiredInputs satisfiable", () => {
    const ids = new Set(nodes.map((node) => node.id));
    expect(ids.size).toBe(nodes.length);
    for (const node of nodes) {
      for (const dependency of node.dependsOn) expect(ids.has(dependency), `${node.id} depends on unknown ${dependency}`).toBe(true);
      for (const input of node.requiredInputs) expect(ids.has(input), `${node.id} requires unknown input ${input}`).toBe(true);
    }
    // Acyclic: canonical order must already be a topological order (the executor dispatches in it).
    const seen = new Set<string>();
    for (const node of nodes) {
      for (const dependency of node.dependsOn) expect(seen.has(dependency), `${node.id} listed before its dependency ${dependency}`).toBe(true);
      seen.add(node.id);
    }
  });

  it("has exactly three AI nodes; every other node declares a deterministic capture stage", () => {
    const aiNodes = nodes.filter((node) => !readCaptureStage(node));
    expect(aiNodes.map((node) => node.id).sort()).toEqual([...CAPTURE_AI_NODE_IDS].sort());
    for (const node of nodes) {
      if ((CAPTURE_AI_NODE_IDS as readonly string[]).includes(node.id)) expect(readCaptureStage(node)).toBeUndefined();
      else expect(readCaptureStage(node), `${node.id} must declare a deterministic capture stage`).toBeDefined();
    }
  });

  it("gives each AI node a tight per-node modelConfig budget", () => {
    for (const id of CAPTURE_AI_NODE_IDS) {
      const node = nodes.find((candidate) => candidate.id === id)!;
      const config = node.modelConfig as Record<string, number>;
      expect(config.budgetUsd).toBeGreaterThan(0);
      expect(config.budgetUsd).toBeLessThanOrEqual(1);
      expect(config.maxTurns).toBeLessThanOrEqual(4);
      expect(config.toolCallLimit).toBeLessThanOrEqual(3);
    }
  });

  it("preserves the human gate: no publish-risk node, no publish-capable tool grant, terminal = report", () => {
    for (const node of nodes) {
      expect(["read", "write"]).toContain(node.riskLevel);
      expect(node.kind).not.toBe("publisher");
      for (const tool of node.allowedTools) {
        expect(tool).not.toBe("project.call_tool");
        expect(tool.startsWith("publish.")).toBe(false);
      }
    }
    const terminal = nodes[nodes.length - 1];
    expect(terminal.id).toBe("capture_report");
    expect(terminal.produces).toEqual(["capture_run_report.v1"]);
    // Nothing depends on the report: the workflow ENDS at the prepared report + drafts.
    expect(nodes.some((node) => node.dependsOn.includes("capture_report"))).toBe(false);
  });

  it("gates block_classifier and copy_regenerator with the deterministic capture skip predicates", () => {
    const classifier = nodes.find((node) => node.id === "block_classifier")!;
    const regenerator = nodes.find((node) => node.id === "copy_regenerator")!;
    expect(classifier.metadata?.skipWhen).toEqual([{ when: "capture_no_declined_blocks" }]);
    expect(regenerator.metadata?.skipWhen).toEqual([{ when: "capture_rights_allow_extracted_copy" }]);
  });

  it("generates schema-valid mock outputs for every capture node (mock CI traversal cannot dead-end)", () => {
    for (const node of nodes) {
      const mock = mockOutputForNode(node);
      const validation = validateOutput(mock, node.outputSchema);
      expect(validation.ok, `${node.id} mock output invalid: ${validation.ok ? "" : validation.errors.join("; ")}`).toBe(true);
    }
  });

  it("listCaptureConductorNodes returns fresh copies (callers cannot mutate the canonical literal)", () => {
    const first = listCaptureConductorNodes();
    first[0].dependsOn.push("tampered");
    (first[0].metadata as Record<string, unknown>).captureStageDeterministic = "tampered";
    expect(captureConductorNodes[0].dependsOn).not.toContain("tampered");
    expect(listCaptureConductorNodes()[0].metadata?.captureStageDeterministic).toBe("crawl");
  });
});
