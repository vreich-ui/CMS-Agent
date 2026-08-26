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
// a publish verb sneaking into an UPSTREAM node's allowedTools, a cycle, an orphaned dependency, a
// second terminal node), not to catch the node set legitimately growing again.
//
// T15.10 (2026-08-25, #189; ADR-2026-08-25-publish-autonomy §6, §9) SUPERSEDES this suite's old
// "human gate preserved" invariant, exactly as T15.7 did for capture_conductor: clone composes the
// shared publishing tail's PUBLISH segment, so publish-risk nodes, project.call_tool, and
// object_publish/release_to_production ARE now reachable — through the IDENTICAL governed tail every
// workflow shares, with the identical safety machinery watching them (see
// tests/agent/workspace/publishingTail.test.ts's riskLevel conformance suite and
// tests/agent/capture/clonePublishTail.test.ts). What is preserved is narrower and still real:
// clone_report is still the workflow's terminal REPORT (nothing depends on it), and clone still
// authors no article body (the tail's AUTHORING segment stays uncomposed).
//   (a) the AI nodes are EXACTLY CLONE_AI_NODE_IDS — whatever CLONE_AI_NODE_IDS names, today four;
//   (b) every other UPSTREAM node carries metadata.cloneStageDeterministic and is a member of
//       CLONE_STAGES (the tail's own release_executor/learning_recorder need no clone-specific route);
//   (c) no UPSTREAM node has riskLevel publish or admin, or a publish verb in allowedTools — the
//       tail's own publish-risk nodes are the ONLY ones that do, exactly as every workflow shares,
//       with exactly ONE deliberate exception since T15.34/#210: pdf_template_publish, upstream and
//       riskLevel "publish" BY ITSELF (never a tail composition) so it reuses the SAME generic
//       publish-risk gate without touching object_publish or any CMS-object machinery — see (c)'s own
//       test for the full argument;
//   (d) the graph is acyclic, every dependsOn/requiredInputs names a real node, and clone_report is
//       the unique terminal node (report, not necessarily last array entry).
describe("clone_conductor canonical node set", () => {
  const nodes = listCloneConductorNodes();
  const UPSTREAM_IDS = new Set(cloneConductorNodes.map((node) => node.id));
  const upstream = () => nodes.filter((node) => UPSTREAM_IDS.has(node.id));

  it("is registered and resolvable by workflowId through the executor's registry seam", async () => {
    expect(getWorkflowDefinition("clone_conductor")?.canonicalNodes().map((node) => node.id)).toEqual(nodes.map((node) => node.id));
    const resolved = await __test__.resolveConductorNodes(undefined, "clone_conductor");
    expect(resolved.map((node) => node.id)).toEqual(nodes.map((node) => node.id));
  });

  it("(d) forms a valid DAG: unique ids, resolvable edges, acyclic, requiredInputs satisfiable", () => {
    const ids = new Set(nodes.map((node) => node.id));
    expect(ids.size).toBe(nodes.length);
    for (const node of nodes) {
      for (const dependency of node.dependsOn) expect(ids.has(dependency), `${node.id} depends on unknown ${dependency}`).toBe(true);
      for (const input of node.requiredInputs) expect(ids.has(input), `${node.id} requires unknown input ${input}`).toBe(true);
    }
    // Acyclic — checked structurally (DFS), not by array position. T15.10: composeWorkflowNodes
    // appends the shared tail AFTER the whole upstream array, but clone_report (upstream) now depends
    // on publish_executor/release_executor (tail, appended after it) — so the canonical array is no
    // longer itself a topological order, though the graph it describes is still acyclic.
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

  it("(a) the AI nodes are EXACTLY CLONE_AI_NODE_IDS; (b) every other UPSTREAM node declares a deterministic clone stage that is a member of CLONE_STAGES", () => {
    const SHARED_TAIL_DETERMINISTIC_IDS = new Set(["release_executor", "learning_recorder"]);
    const aiNodes = upstream().filter((node) => !readCloneStage(node));
    expect(aiNodes.map((node) => node.id).sort()).toEqual([...CLONE_AI_NODE_IDS].sort());
    for (const node of upstream()) {
      if ((CLONE_AI_NODE_IDS as readonly string[]).includes(node.id)) {
        expect(readCloneStage(node)).toBeUndefined();
      } else {
        const stage = readCloneStage(node);
        expect(stage, `${node.id} must declare a deterministic clone stage`).toBeDefined();
        expect(CLONE_STAGES as readonly string[]).toContain(stage);
      }
    }
    // The tail's own nodes need no clone-specific route: release_executor/learning_recorder are
    // already object/workflow-agnostic (executor.ts), and readCloneStage is deliberately silent on
    // them — the identical shape captureConductorWorkflow.test.ts asserts for capture.
    for (const id of SHARED_TAIL_DETERMINISTIC_IDS) {
      const node = nodes.find((candidate) => candidate.id === id)!;
      expect(readCloneStage(node)).toBeUndefined();
    }
    expect(nodes.find((node) => node.id === "release_executor")?.metadata?.releaseExecutorDeterministic).toBe(true);
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

  it("(c) T15.10: publish-risk nodes ARE now reachable, through the identical shared-tail safety machinery — clone_report stays the terminal report", () => {
    // The shared tail's own publish-risk nodes, PLUS exactly one deliberate upstream exception:
    // pdf_template_publish (T15.34/#210; ADR-2026-08-25-structure-studio §7). It is riskLevel
    // "publish" ON PURPOSE and BY ITSELF — not because it composes the shared tail (it does not: it
    // is clone's own upstream node, dispatched by cloneConductorRoutes.ts's "pdf_publish" case, never
    // by publishingTail.ts) but so the executor's SAME generic publish-risk gate
    // (isPublishRisk/resolvePublishAuthority, keyed on riskLevel alone) reuses the identical
    // operator-veto/autonomy check every tail-composed publish-risk node gets, without a pdf_template
    // needing to pass through object_publish or any CMS-object machinery to earn it. This is the ONE
    // upstream node this suite's own header (c) now names as a sanctioned exception; every other
    // upstream node keeps the invariant unchanged.
    const publishRisk = nodes.filter((node) => node.riskLevel === "publish" || node.riskLevel === "admin");
    expect(publishRisk.map((node) => node.id).sort()).toEqual(["pdf_template_publish", "publication_controller", "publish_executor", "release_executor"]);
    for (const node of upstream()) {
      if (node.id === "pdf_template_publish") {
        expect(node.riskLevel).toBe("publish");
        expect(node.kind).not.toBe("publisher"); // never masquerades as the shared tail's releaser/publisher kind
      } else {
        expect(["read", "write"]).toContain(node.riskLevel);
        expect(node.riskLevel).not.toBe("publish");
        expect(node.riskLevel).not.toBe("admin");
      }
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
    // clone_report is still the workflow's terminal REPORT: nothing depends on it, even though it is
    // no longer the last array entry (the tail's own learning_recorder is, per composeWorkflowNodes).
    const report = nodes.find((node) => node.id === "clone_report")!;
    expect(report.produces).toEqual(["clone_run_report.v1"]);
    expect(nodes.some((node) => node.dependsOn.includes("clone_report"))).toBe(false);
    expect(nodes[nodes.length - 1].id).toBe("learning_recorder");
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
