import { describe, expect, it } from "vitest";
import { listWorkspaceNodes, validateWorkspaceGraph } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import {
  WorkflowCompositionError,
  composeWorkflowNodes,
  isTailNode,
  publishingTailBoundary,
  publishingTailConformanceIssues,
  publishingTailInternalEdges,
  publishingTailNodeIds,
  publishingTailUpstreamIds,
  tailBoundary
} from "../../../src/agent/workspace/publishingTail.js";

// §2.23 — the publishing tail is declared ONCE in publishingTail.ts and every workflow reuses it.
// These tests are the CI drift-guard: if the canonical array's tail slice ever diverges from the
// declaration (a fork of the tail), they fail, and the fix is to land the change in publishingTail.ts
// so it lands for every workflow at once.

const clone = <T,>(value: T): T => structuredClone(value);

// A synthetic second workflow's upstream — the shape a future money_page would bring: its own intake
// and editorial spine, ending in nodes the tail boundary binds to. Built from clones of canonical
// nodes so every runtime-required field is present.
const syntheticUpstream = (): WorkspaceNode[] => {
  const template = clone(listWorkspaceNodes()[0]);
  const make = (id: string, dependsOn: string[], produces: string[]): WorkspaceNode => ({
    ...clone(template),
    id,
    name: id,
    dependsOn,
    requiredInputs: [...dependsOn],
    produces
  });
  return [
    make("money_intake", [], ["content_source.v1"]),
    make("money_brief", ["money_intake"], ["article_brief.v1"]),
    make("money_draft", ["money_brief"], ["draft.v1"]),
    make("money_review", ["money_draft"], ["review_aggregation.v1"])
  ];
};

// The binding a money_page author supplies: contract_intelligence reads the brief, article_body reads
// the approved editorial content and the draft. narrative_movement/angle_strategy have no money_page
// equivalent here, so their edges are re-bound to what exists.
const syntheticBinding = {
  contract_intelligence: ["money_brief"],
  article_body: ["money_review", "money_draft", "money_brief"]
} as const;

describe("§2.23 publishing tail declaration", () => {
  it("declares the seven tail nodes in canonical order and predicates agree", () => {
    expect([...publishingTailNodeIds]).toEqual(["contract_intelligence", "article_body", "artifact_plan", "publish_payload", "publication_controller", "publish_executor", "learning_recorder"]);
    for (const nodeId of publishingTailNodeIds) expect(isTailNode(nodeId)).toBe(true);
    expect(isTailNode("brief_architect")).toBe(false);
  });

  it("captures the tail's upstream boundary exactly — the multi-edge entry contract", () => {
    expect(publishingTailBoundary).toEqual({
      contract_intelligence: ["brief_architect"],
      article_body: ["review_aggregator", "draft_writer", "narrative_movement", "angle_strategy"],
      artifact_plan: [],
      publish_payload: [],
      publication_controller: [],
      publish_executor: [],
      learning_recorder: []
    });
    expect(tailBoundary("article_body")).toEqual(["review_aggregator", "draft_writer", "narrative_movement", "angle_strategy"]);
    expect(tailBoundary("publish_payload")).toEqual([]);
    expect(tailBoundary("not_a_tail_node")).toEqual([]);
    expect([...publishingTailUpstreamIds]).toEqual(["brief_architect", "review_aggregator", "draft_writer", "narrative_movement", "angle_strategy"]);
  });

  it("derives internal edges as the complement of the boundary — shared verbatim by every workflow", () => {
    expect(publishingTailInternalEdges).toEqual({
      contract_intelligence: [],
      article_body: ["contract_intelligence"],
      artifact_plan: ["article_body"],
      publish_payload: ["article_body", "artifact_plan"],
      publication_controller: ["publish_payload"],
      publish_executor: ["publication_controller"],
      learning_recorder: ["publication_controller", "publish_executor"]
    });
  });
});

describe("§2.23 drift guard: the canonical array's tail slice matches the declaration", () => {
  it("conforms today (edges, order, produces, riskLevel — including learning_recorder downstream of publish_executor per §2.15)", () => {
    expect(publishingTailConformanceIssues(listWorkspaceNodes())).toEqual([]);
  });

  it("flags a forked tail edge", () => {
    const nodes = clone(listWorkspaceNodes());
    const learningRecorder = nodes.find((node) => node.id === "learning_recorder")!;
    learningRecorder.dependsOn = ["publication_controller"]; // the pre-§2.15 fork
    const issues = publishingTailConformanceIssues(nodes);
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("Tail edge drift on learning_recorder")]));
  });

  it("flags a missing tail node, a duplicated one, an order change, a produces change, and a risk downgrade", () => {
    const base = () => clone(listWorkspaceNodes());

    const missing = base().filter((node) => node.id !== "publish_executor");
    expect(publishingTailConformanceIssues(missing)).toEqual(expect.arrayContaining([expect.stringContaining("Tail node missing: publish_executor")]));

    const withDuplicate = base();
    withDuplicate.push(clone(withDuplicate.find((node) => node.id === "artifact_plan")!));
    expect(publishingTailConformanceIssues(withDuplicate)).toEqual(expect.arrayContaining([expect.stringContaining("Tail node duplicated: artifact_plan")]));

    const reordered = base();
    const executorIndex = reordered.findIndex((node) => node.id === "publish_executor");
    const controllerIndex = reordered.findIndex((node) => node.id === "publication_controller");
    [reordered[executorIndex], reordered[controllerIndex]] = [reordered[controllerIndex], reordered[executorIndex]];
    expect(publishingTailConformanceIssues(reordered)).toEqual(expect.arrayContaining([expect.stringContaining("Tail nodes out of declared order")]));

    const producesDrift = base();
    producesDrift.find((node) => node.id === "article_body")!.produces = ["something_else.v1"];
    expect(publishingTailConformanceIssues(producesDrift)).toEqual(expect.arrayContaining([expect.stringContaining("Tail artifact drift on article_body")]));

    const riskDrift = base();
    riskDrift.find((node) => node.id === "publish_executor")!.riskLevel = "write";
    expect(publishingTailConformanceIssues(riskDrift)).toEqual(expect.arrayContaining([expect.stringContaining("Tail risk drift on publish_executor")]));
  });
});

describe("§2.23 composeWorkflowNodes", () => {
  it("expresses the CURRENT workflow through the seam: canonical upstream + shared tail reproduces the canonical array exactly", () => {
    const upstream = listWorkspaceNodes().filter((node) => !isTailNode(node.id));
    expect(composeWorkflowNodes(upstream)).toEqual(listWorkspaceNodes());
  });

  it("composes a synthetic money_page upstream with the shared tail into a valid graph with re-bound boundary edges", () => {
    const composed = composeWorkflowNodes(syntheticUpstream(), syntheticBinding);
    expect(composed.map((node) => node.id)).toEqual(["money_intake", "money_brief", "money_draft", "money_review", ...publishingTailNodeIds]);
    const byId = new Map(composed.map((node) => [node.id, node]));
    // Boundary edges bound to the second workflow's own upstream; internal edges untouched.
    expect(byId.get("contract_intelligence")?.dependsOn).toEqual(["money_brief"]);
    expect(byId.get("article_body")?.dependsOn).toEqual(["money_review", "money_draft", "money_brief", "contract_intelligence"]);
    expect(byId.get("article_body")?.requiredInputs).toEqual(["money_review", "money_draft", "money_brief", "contract_intelligence"]);
    expect(byId.get("publish_payload")?.dependsOn).toEqual(["article_body", "artifact_plan"]);
    expect(byId.get("learning_recorder")?.dependsOn).toEqual(["publication_controller", "publish_executor"]);
    // The shared tail DEFINITIONS travel: same prompt, schema, tools, riskLevel as the canonical tail,
    // so a gate fixed in the tail is fixed for this workflow too.
    const canonicalExecutor = listWorkspaceNodes().find((node) => node.id === "publish_executor")!;
    expect(byId.get("publish_executor")?.prompt).toBe(canonicalExecutor.prompt);
    expect(byId.get("publish_executor")?.riskLevel).toBe("publish");
    // And the composed graph validates against ITSELF as the run sequence.
    expect(validateWorkspaceGraph(composed, composed)).toEqual({ valid: true, issues: [] });
  });

  it("refuses an unsatisfied boundary: an upstream set that lacks a default boundary dependency and binds nothing", () => {
    expect(() => composeWorkflowNodes(syntheticUpstream())).toThrowError(WorkflowCompositionError);
    try {
      composeWorkflowNodes(syntheticUpstream());
      expect.unreachable("composition must refuse");
    } catch (error) {
      const composition = error as WorkflowCompositionError;
      expect(composition.code).toBe("invalid_workflow_composition");
      expect(composition.issues).toEqual(expect.arrayContaining([expect.stringContaining("Unsatisfied boundary for contract_intelligence: brief_architect")]));
    }
  });

  it("refuses a binding that points outside the upstream set", () => {
    expect(() => composeWorkflowNodes(syntheticUpstream(), { ...syntheticBinding, article_body: ["nonexistent_node"] })).toThrowError(/Unsatisfied boundary for article_body: nonexistent_node/);
  });

  it("refuses an id collision between upstream and the tail", () => {
    const upstream = syntheticUpstream();
    upstream.push({ ...clone(upstream[0]), id: "article_body" });
    expect(() => composeWorkflowNodes(upstream, syntheticBinding)).toThrowError(/Upstream node id collides with a tail node: article_body/);
  });

  it("refuses duplicate upstream ids", () => {
    const upstream = syntheticUpstream();
    upstream.push(clone(upstream[1]));
    expect(() => composeWorkflowNodes(upstream, syntheticBinding)).toThrowError(/Duplicate upstream node id: money_brief/);
  });

  it("refuses an empty binding for a tail node whose declared boundary is non-empty, and a binding aimed at a tail node", () => {
    expect(() => composeWorkflowNodes(syntheticUpstream(), { ...syntheticBinding, article_body: [] })).toThrowError(/Boundary binding for article_body is empty/);
    expect(() => composeWorkflowNodes(syntheticUpstream(), { ...syntheticBinding, article_body: ["publish_payload"] })).toThrowError(/points at a tail node: publish_payload/);
  });

  it("does not mutate its inputs and returns fresh copies", () => {
    const upstream = syntheticUpstream();
    const before = clone(upstream);
    const composed = composeWorkflowNodes(upstream, syntheticBinding);
    expect(upstream).toEqual(before);
    const composedBody = composed.find((node) => node.id === "article_body")!;
    composedBody.dependsOn.push("mutated");
    expect(listWorkspaceNodes().find((node) => node.id === "article_body")!.dependsOn).not.toContain("mutated");
  });
});
