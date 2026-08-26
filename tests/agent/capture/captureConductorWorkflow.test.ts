import { describe, expect, it } from "vitest";
import { CAPTURE_AI_NODE_IDS, captureConductorNodes, listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { readCaptureStage } from "../../../src/agent/workspace/captureConductorRoutes.js";
import { getWorkflowDefinition } from "../../../src/agent/workspace/workflowRegistry.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { __test__ } from "../../../src/agent/workspace/executor.js";

// T12.9 — the capture_conductor node set's structural law:
//   * deterministic-first: every non-AI node routes through captureStageDeterministic engine code (or,
//     for the three tail nodes T15.7 added that are NOT captureStageDeterministic — release_executor,
//     learning_recorder — through the SAME shared-tail deterministic route every workflow uses);
//   * exactly THREE model-judgment nodes (R-C3 v2);
//   * T15.7 (ADR-2026-08-25-publish-autonomy §6, §9) SUPERSEDES this suite's old "human gate preserved"
//     invariant: capture composes the shared publishing tail's PUBLISH segment, so publish-risk nodes,
//     project.call_tool, and object_publish/release_to_production ARE now reachable — through the
//     IDENTICAL governed tail every workflow shares, with the identical safety machinery watching them
//     (see tests/agent/workspace/publishingTail.test.ts's riskLevel conformance suite and
//     tests/agent/capture/capturePublishTail.test.ts). What is preserved is narrower and still real:
//     capture_report is still the workflow's terminal REPORT (nothing depends on it), and capture
//     still authors no article body (the tail's AUTHORING segment stays uncomposed).
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
    // Acyclic — checked structurally (DFS), not by array position. T15.7: composeWorkflowNodes
    // appends the shared tail AFTER the whole upstream array, but capture_report (upstream) now
    // depends on publish_executor/release_executor (tail, appended after it) — so the canonical
    // array is no longer itself a topological order, though the graph it describes is still acyclic
    // and the executor dispatches by resolved dependency state, never by array position.
    const state = new Map<string, "visiting" | "done">();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visit = (id: string, path: string[]): void => {
      const mark = state.get(id);
      if (mark === "done") return;
      if (mark === "visiting") throw new Error(`Cycle detected: ${[...path, id].join(" -> ")}`);
      state.set(id, "visiting");
      for (const dependency of byId.get(id)!.dependsOn) visit(dependency, [...path, id]);
      state.set(id, "done");
    };
    expect(() => { for (const node of nodes) visit(node.id, []); }).not.toThrow();
  });

  it("has exactly three AI nodes; every other node declares a deterministic capture stage or the shared tail's own deterministic route", () => {
    // T15.7: release_executor and learning_recorder are the shared tail's own deterministic nodes —
    // they need no capture-specific route (releaseExecutorDeterministic / learningRecorderDeterministic
    // metadata, unrelated to captureStageDeterministic) because they are already object/workflow
    // agnostic (executor.ts). readCaptureStage is deliberately silent on them; this is what makes them
    // "not an AI node" without being a capture-route node either.
    const SHARED_TAIL_DETERMINISTIC_IDS = new Set(["release_executor", "learning_recorder"]);
    const hasKnownDeterministicRoute = (node: (typeof nodes)[number]) => readCaptureStage(node) !== undefined || SHARED_TAIL_DETERMINISTIC_IDS.has(node.id);
    const aiNodes = nodes.filter((node) => !hasKnownDeterministicRoute(node));
    expect(aiNodes.map((node) => node.id).sort()).toEqual([...CAPTURE_AI_NODE_IDS].sort());
    for (const node of nodes) {
      if ((CAPTURE_AI_NODE_IDS as readonly string[]).includes(node.id)) expect(readCaptureStage(node)).toBeUndefined();
      else if (!SHARED_TAIL_DETERMINISTIC_IDS.has(node.id)) expect(readCaptureStage(node), `${node.id} must declare a deterministic capture stage`).toBeDefined();
    }
    expect(nodes.find((node) => node.id === "release_executor")?.metadata?.releaseExecutorDeterministic).toBe(true);
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

  it("T15.7: publish-risk nodes ARE now reachable, through the identical shared-tail safety machinery — capture_report stays the terminal report", () => {
    // Exactly the shared tail's own publish-risk nodes, none belonging to capture's own upstream —
    // the same conformance every workflow composing the tail gets, asserted generally in
    // publishingTail.test.ts's riskLevel conformance suite.
    const publishRisk = nodes.filter((node) => node.riskLevel === "publish" || node.riskLevel === "admin");
    expect(publishRisk.map((node) => node.id).sort()).toEqual(["publication_controller", "publish_executor", "release_executor"]);
    for (const node of nodes) {
      if (publishRisk.includes(node)) continue;
      expect(["read", "write"]).toContain(node.riskLevel);
      expect(node.kind).not.toBe("publisher");
    }
    // capture_report is still the workflow's terminal REPORT: nothing depends on it, even though it is
    // no longer the last array entry (the tail's own learning_recorder is, per composeWorkflowNodes).
    const report = nodes.find((node) => node.id === "capture_report")!;
    expect(report.produces).toEqual(["capture_run_report.v1"]);
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
