import { describe, expect, it } from "vitest";
import { CLONE_AI_NODE_IDS, cloneConductorNodes, listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { readCloneStage, CLONE_STAGES } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { getWorkflowDefinition } from "../../../src/agent/workspace/workflowRegistry.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { __test__ } from "../../../src/agent/workspace/executor.js";

// T13.1 — the clone_conductor node set's structural law (CLONE-ENGINE-API.md), mirroring
// captureConductorWorkflow.test.ts in spirit, but NOT in count: capture_conductor's node set is
// fixed at "exactly three" because it only reads; this workflow authors, and T13.4 grew it to FOUR
// AI nodes (fit_adjudicator, judging substitutions the engine merely enumerates). The assertions
// below are written against CLONE_AI_NODE_IDS itself and against graph SHAPE, not against a count —
// they exist to catch a SAFETY property breaking (a node escaping deterministic-stage bookkeeping,
// a publish verb sneaking into allowedTools, a cycle, an orphaned dependency, a second terminal
// node), not to catch the node set legitimately growing again:
//   (a) the AI nodes are EXACTLY CLONE_AI_NODE_IDS — whatever CLONE_AI_NODE_IDS names, today four;
//   (b) every other node carries metadata.cloneStageDeterministic and it is a member of CLONE_STAGES;
//   (c) no node has riskLevel publish or admin;
//   (d) no node's allowedTools contain a publish verb;
//   (e) the graph is acyclic, every dependsOn names a real node, and clone_report is the unique
//       terminal node.
describe("clone_conductor canonical node set", () => {
  const nodes = listCloneConductorNodes();

  it("is registered and resolvable by workflowId through the executor's registry seam", async () => {
    expect(getWorkflowDefinition("clone_conductor")?.canonicalNodes().map((node) => node.id)).toEqual(nodes.map((node) => node.id));
    const resolved = await __test__.resolveConductorNodes(undefined, "clone_conductor");
    expect(resolved.map((node) => node.id)).toEqual(nodes.map((node) => node.id));
  });

  it("(e) forms a valid DAG: unique ids, resolvable edges, acyclic, requiredInputs satisfiable", () => {
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

  it("(a) the AI nodes are EXACTLY CLONE_AI_NODE_IDS, whatever its size; (b) every other node declares a deterministic clone stage that is a member of CLONE_STAGES", () => {
    const aiNodes = nodes.filter((node) => !readCloneStage(node));
    expect(aiNodes.map((node) => node.id).sort()).toEqual([...CLONE_AI_NODE_IDS].sort());
    for (const node of nodes) {
      if ((CLONE_AI_NODE_IDS as readonly string[]).includes(node.id)) {
        expect(readCloneStage(node)).toBeUndefined();
      } else {
        const stage = readCloneStage(node);
        expect(stage, `${node.id} must declare a deterministic clone stage`).toBeDefined();
        expect(CLONE_STAGES as readonly string[]).toContain(stage);
      }
    }
    // There is no "pending" stage in this workflow — clone never polls an external job plane.
    expect(CLONE_STAGES as readonly string[]).not.toContain("pending");
  });

  it("gives each AI node a tight per-node modelConfig budget", () => {
    for (const id of CLONE_AI_NODE_IDS) {
      const node = nodes.find((candidate) => candidate.id === id)!;
      const config = node.modelConfig as Record<string, number>;
      expect(config.budgetUsd).toBeGreaterThan(0);
      expect(config.budgetUsd).toBeLessThanOrEqual(1);
      expect(config.maxTurns).toBeLessThanOrEqual(6);
      expect(config.toolCallLimit).toBeLessThanOrEqual(4);
    }
  });

  it("(c) no node has riskLevel publish or admin; (d) no node's allowedTools contain a publish verb; clone_report is the unique terminal node", () => {
    for (const node of nodes) {
      // Structural, not a hardcoded count: riskLevel is a closed enum, so proving membership in
      // {read, write} IS proving "not publish, not admin" — restated explicitly below too, so this
      // property reads directly off the assertion rather than off an inference from the allowlist.
      expect(["read", "write"]).toContain(node.riskLevel);
      expect(node.riskLevel).not.toBe("publish");
      expect(node.riskLevel).not.toBe("admin");
      expect(node.kind).not.toBe("publisher");
      for (const tool of node.allowedTools) {
        expect(tool).not.toBe("project.call_tool");
        expect(tool.startsWith("publish.")).toBe(false);
        expect(tool).not.toBe("object_publish");
        expect(tool).not.toBe("release_to_production");
        expect(tool).not.toBe("trigger_netlify_build");
        expect(tool).not.toBe("deploy");
      }
    }
    // clone_report is the UNIQUE terminal node: every other node is an ancestor of something. This
    // is derived structurally from the dependency graph (the set of ids nothing's dependsOn
    // mentions) rather than assumed from array position, so inserting a node anywhere in the
    // canonical list — as fit_adjudicator was — cannot silently stop this test from meaning what it
    // says.
    const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn));
    const terminalNodes = nodes.filter((node) => !dependedOn.has(node.id));
    expect(terminalNodes.map((node) => node.id)).toEqual(["clone_report"]);
    const terminal = terminalNodes[0];
    expect(terminal.produces).toEqual(["clone_run_report.v1"]);
    // Nothing depends on the report: the workflow ENDS at the prepared report + drafts.
    expect(nodes.some((node) => node.dependsOn.includes("clone_report"))).toBe(false);
  });

  it("generates schema-valid mock outputs for every clone node (mock CI traversal cannot dead-end)", () => {
    for (const node of nodes) {
      const mock = mockOutputForNode(node);
      const validation = validateOutput(mock, node.outputSchema);
      expect(validation.ok, `${node.id} mock output invalid: ${validation.ok ? "" : validation.errors.join("; ")}`).toBe(true);
    }
  });

  it("listCloneConductorNodes returns fresh copies (callers cannot mutate the canonical literal)", () => {
    const first = listCloneConductorNodes();
    first[0].dependsOn.push("tampered");
    (first[0].metadata as Record<string, unknown>).cloneStageDeterministic = "tampered";
    expect(cloneConductorNodes[0].dependsOn).not.toContain("tampered");
    expect(listCloneConductorNodes()[0].metadata?.cloneStageDeterministic).toBe("intake");
  });
});
