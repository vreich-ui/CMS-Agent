import { describe, expect, it } from "vitest";
import { listWorkspaceNodes, validateWorkspaceGraph } from "../../../src/agent/workspace/nodes.js";
import { listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import {
  WorkflowCompositionError,
  composeWorkflowNodes,
  isTailNode,
  publishingAuthoringSegmentIds,
  publishingPublishSegmentIds,
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

// The binding a money_page author supplies: contract_intelligence and artifact_plan both read the
// brief (T8: artifact_plan now depends on brief_architect directly, not on article_body), article_body
// reads the approved editorial content and the draft. narrative_movement/angle_strategy have no
// money_page equivalent here, so their edges are re-bound to what exists.
const syntheticBinding = {
  contract_intelligence: ["money_brief"],
  artifact_plan: ["money_brief"],
  article_body: ["money_review", "money_draft", "money_brief"]
} as const;

describe("§2.23 publishing tail declaration", () => {
  it("declares the eight tail nodes in canonical order and predicates agree", () => {
    // T8 (Wave 3, 2026-08-13, run_1786557897658_elj34j): artifact_plan moved ahead of article_body so
    // media is generated and verified BEFORE the body that would reference it is built.
    // T15.6 (2026-08-25, ADR-2026-08-25-publish-autonomy §4.3): release_executor lands after
    // publish_executor and before learning_recorder.
    expect([...publishingTailNodeIds]).toEqual(["contract_intelligence", "artifact_plan", "article_body", "publish_payload", "publication_controller", "publish_executor", "release_executor", "learning_recorder"]);
    for (const nodeId of publishingTailNodeIds) expect(isTailNode(nodeId)).toBe(true);
    expect(isTailNode("brief_architect")).toBe(false);
  });

  it("captures the tail's upstream boundary exactly — the multi-edge entry contract", () => {
    expect(publishingTailBoundary).toEqual({
      contract_intelligence: ["brief_architect"],
      artifact_plan: ["brief_architect"],
      article_body: ["review_aggregator", "draft_writer", "narrative_movement", "angle_strategy"],
      publish_payload: [],
      publication_controller: [],
      publish_executor: [],
      release_executor: [],
      learning_recorder: []
    });
    expect(tailBoundary("artifact_plan")).toEqual(["brief_architect"]);
    expect(tailBoundary("article_body")).toEqual(["review_aggregator", "draft_writer", "narrative_movement", "angle_strategy"]);
    expect(tailBoundary("publish_payload")).toEqual([]);
    expect(tailBoundary("release_executor")).toEqual([]);
    expect(tailBoundary("not_a_tail_node")).toEqual([]);
    expect([...publishingTailUpstreamIds]).toEqual(["brief_architect", "review_aggregator", "draft_writer", "narrative_movement", "angle_strategy"]);
  });

  it("derives internal edges as the complement of the boundary — shared verbatim by every workflow", () => {
    expect(publishingTailInternalEdges).toEqual({
      contract_intelligence: [],
      artifact_plan: ["contract_intelligence"],
      article_body: ["contract_intelligence", "artifact_plan"],
      publish_payload: ["article_body", "artifact_plan"],
      publication_controller: ["publish_payload"],
      publish_executor: ["publication_controller"],
      release_executor: ["publish_executor"],
      learning_recorder: ["publication_controller", "publish_executor", "release_executor"]
    });
  });

  it("partitions the tail into an authoring segment and a mandatory publish segment (ADR §6.1)", () => {
    expect([...publishingAuthoringSegmentIds]).toEqual(["contract_intelligence", "artifact_plan", "article_body"]);
    expect([...publishingPublishSegmentIds]).toEqual(["publish_payload", "publication_controller", "publish_executor", "release_executor", "learning_recorder"]);
    // Exact partition: every tail id in exactly one segment, nothing left over.
    const union = [...publishingAuthoringSegmentIds, ...publishingPublishSegmentIds].sort();
    expect(union).toEqual([...publishingTailNodeIds].sort());
    const overlap = publishingAuthoringSegmentIds.filter((id) => (publishingPublishSegmentIds as readonly string[]).includes(id));
    expect(overlap).toEqual([]);
  });
});

describe("§2.23 drift guard: the canonical array's tail slice matches the declaration", () => {
  it("conforms today (edges, order, produces, riskLevel — including learning_recorder downstream of publish_executor and release_executor)", () => {
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

    const missing = base().filter((node) => node.id !== "release_executor");
    expect(publishingTailConformanceIssues(missing)).toEqual(expect.arrayContaining([expect.stringContaining("Tail node missing: release_executor")]));

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
    riskDrift.find((node) => node.id === "release_executor")!.riskLevel = "write";
    expect(publishingTailConformanceIssues(riskDrift)).toEqual(expect.arrayContaining([expect.stringContaining("Tail risk drift on release_executor")]));
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
    expect(byId.get("artifact_plan")?.dependsOn).toEqual(["money_brief", "contract_intelligence"]);
    expect(byId.get("article_body")?.dependsOn).toEqual(["money_review", "money_draft", "money_brief", "contract_intelligence", "artifact_plan"]);
    expect(byId.get("article_body")?.requiredInputs).toEqual(["money_review", "money_draft", "money_brief", "contract_intelligence", "artifact_plan"]);
    expect(byId.get("publish_payload")?.dependsOn).toEqual(["article_body", "artifact_plan"]);
    expect(byId.get("release_executor")?.dependsOn).toEqual(["publish_executor"]);
    expect(byId.get("learning_recorder")?.dependsOn).toEqual(["publication_controller", "publish_executor", "release_executor"]);
    // The shared tail DEFINITIONS travel: same prompt, schema, tools, riskLevel as the canonical tail,
    // so a gate fixed in the tail is fixed for this workflow too.
    const canonicalExecutor = listWorkspaceNodes().find((node) => node.id === "publish_executor")!;
    expect(byId.get("publish_executor")?.prompt).toBe(canonicalExecutor.prompt);
    expect(byId.get("publish_executor")?.riskLevel).toBe("publish");
    const canonicalReleaser = listWorkspaceNodes().find((node) => node.id === "release_executor")!;
    expect(byId.get("release_executor")?.prompt).toBe(canonicalReleaser.prompt);
    expect(byId.get("release_executor")?.riskLevel).toBe("publish");
    expect(byId.get("release_executor")?.kind).toBe("releaser");
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

describe("§2.23 / T15.6 segment selector (ADR §6.1) — capture/clone can compose the publish segment alone", () => {
  // A capture-shaped upstream: its own emission report feeding publish_payload directly, with no
  // article_body/contract_intelligence/artifact_plan of its own. This exercises the seam ADR §6.2
  // describes without recomposing capture_conductor itself (that remains #187/#189's job).
  const captureUpstream = (): WorkspaceNode[] => {
    const template = clone(listWorkspaceNodes()[0]);
    const make = (id: string, dependsOn: string[], produces: string[], allowedTools: string[] = []): WorkspaceNode => ({
      ...clone(template),
      id,
      name: id,
      dependsOn,
      requiredInputs: [...dependsOn],
      produces,
      allowedTools
    });
    return [
      make("capture_intake", [], ["content_source.v1"]),
      make("capture_emit", ["capture_intake"], ["emission_report.v1"])
    ];
  };

  it("composes the publish segment alone (authoring:false) when the upstream binds publish_payload directly", () => {
    const composed = composeWorkflowNodes(captureUpstream(), { publish_payload: ["capture_emit"] }, { authoring: false, publish: true });
    expect(composed.map((node) => node.id)).toEqual(["capture_intake", "capture_emit", ...publishingPublishSegmentIds]);
    // None of the authoring-segment nodes are present.
    for (const authoringId of publishingAuthoringSegmentIds) {
      expect(composed.some((node) => node.id === authoringId)).toBe(false);
    }
    const byId = new Map(composed.map((node) => [node.id, node]));
    // publish_payload's declared dependency on article_body/artifact_plan is NOT part of this
    // composition, so it becomes boundary and is bound to capture's own upstream instead.
    expect(byId.get("publish_payload")?.dependsOn).toEqual(["capture_emit"]);
    expect(byId.get("publication_controller")?.dependsOn).toEqual(["publish_payload"]);
    expect(byId.get("release_executor")?.dependsOn).toEqual(["publish_executor"]);
    expect(byId.get("learning_recorder")?.dependsOn).toEqual(["publication_controller", "publish_executor", "release_executor"]);
    expect(validateWorkspaceGraph(composed, composed)).toEqual({ valid: true, issues: [] });
  });

  it("refuses a publish-segment-only composition whose binding names an authoring-segment node", () => {
    expect(() => composeWorkflowNodes(captureUpstream(), { publish_payload: ["capture_emit"], article_body: ["capture_emit"] }, { authoring: false, publish: true }))
      .toThrowError(/Boundary binding names article_body, which is not part of the composed segment selection/);
  });

  it("structurally refuses a workflow that can reach a publish verb but does not compose the publish segment (ADR §6.1/invariant 1)", () => {
    const upstream = captureUpstream();
    upstream[1] = { ...upstream[1], allowedTools: ["object_publish"] };
    expect(() => composeWorkflowNodes(upstream, {}, { publish: false }))
      .toThrowError(/can reach object_publish but the publish segment was not composed/);
  });

  it("structurally refuses when an upstream node can reach release_to_production directly, with the publish segment omitted", () => {
    const upstream = captureUpstream();
    upstream[1] = { ...upstream[1], allowedTools: ["release_to_production"] };
    expect(() => composeWorkflowNodes(upstream, {}, { publish: false }))
      .toThrowError(/can reach release_to_production but the publish segment was not composed/);
  });
});

// T15.7 (ADR-2026-08-25-publish-autonomy §5) — riskLevel is decoupled from approval-gate visibility
// (an autonomous publish is still gated the same way, just not held on a human), but it is NOT
// decoupled from CAPABILITY: riskLevel is what tells a reader — and any future policy that keys off
// it — that a node can reach production. A node whose allowedTools can reach object_publish or
// release_to_production carrying anything below "publish" would be exactly that kind of silent
// capability/label mismatch: composeWorkflowNodes's own structural refusal (above) only catches an
// UPSTREAM node outside the tail reaching one of the two verbs while the publish segment is absent;
// it says nothing about a node's riskLevel actually matching what it can reach. This is the general
// invariant, checked across every workflow's full composed node set — not the tail alone, so a future
// custom node that lists one of these verbs directly would be caught here too.
//
// "Reach" here means literal allowedTools string membership — the same, deliberately narrow
// convention composeWorkflowNodes's own PUBLISH_ONLY_VERBS check uses. It does not (and structurally
// cannot, by static inspection alone) catch a verb reached indirectly through a generic
// project.call_tool grant or through an engine's own internal dispatch code; the true backstop against
// an under-classified node actually publishing is the runtime gate (executor.ts's
// resolvePublishAuthority, scoped to isPublishRisk === riskLevel "publish"/"admin"), not this static
// check. This test is a floor on the DECLARATION matching the CAPABILITY, not a substitute for that
// runtime gate.
describe("riskLevel conformance — a node that can reach object_publish/release_to_production is never below \"publish\"", () => {
  const PUBLISH_CAPABLE_VERBS = new Set(["object_publish", "release_to_production"]);
  const BELOW_PUBLISH = new Set(["read", "write"]);

  const violations = (nodes: WorkspaceNode[]): string[] =>
    nodes
      .filter((node) => node.allowedTools.some((tool) => PUBLISH_CAPABLE_VERBS.has(tool)) && BELOW_PUBLISH.has(node.riskLevel))
      .map((node) => `${node.id}: riskLevel "${node.riskLevel}" but allowedTools reaches ${node.allowedTools.filter((tool) => PUBLISH_CAPABLE_VERBS.has(tool)).join(", ")}`);

  it("holds for the canonical publishing_conductor node set", () => {
    expect(violations(listWorkspaceNodes())).toEqual([]);
  });

  it("holds for capture_conductor's composed node set", () => {
    expect(violations(listCaptureConductorNodes())).toEqual([]);
  });

  it("holds for clone_conductor's composed node set", () => {
    expect(violations(listCloneConductorNodes())).toEqual([]);
  });

  it("actually fires: a node downgraded to \"write\" while its allowedTools reaches object_publish is caught", () => {
    const downgraded = listWorkspaceNodes().map((node) => (node.id === "publish_executor" ? { ...node, riskLevel: "write" as const, allowedTools: [...node.allowedTools, "object_publish"] } : node));
    expect(violations(downgraded)).toEqual([expect.stringContaining("publish_executor")]);
  });

  it("does not fire on riskLevel \"admin\" (never below \"publish\") or on a node that cannot reach either verb", () => {
    const upgraded = listWorkspaceNodes().map((node) => (node.id === "publish_executor" ? { ...node, riskLevel: "admin" as const } : node));
    expect(violations(upgraded)).toEqual([]);
  });
});
