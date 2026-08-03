import { describe, expect, it } from "vitest";
import { listWorkspaceNodes, validateWorkspaceGraph } from "../../src/agent/workspace/nodes.js";

describe("Publishing Conductor workspace nodes", () => {
  // R-22: 21, not 18. nodes.ts is now re-seeded from the live workspace by
  // scripts/seedNodesFromWorkspace.ts, which brought in contract_intelligence, artifact_plan and
  // publish_executor. Before the re-seed the conductor ran an 18-node graph that no longer existed
  // anywhere but in this file — which is why T-2 certified an obsolete pipeline.
  it("defines the full 21-node graph", () => {
    expect(listWorkspaceNodes()).toHaveLength(21);
  });

  it("includes the three nodes store mode could never have delivered", () => {
    const ids = listWorkspaceNodes().map((node) => node.id);
    // resolveConductorNodes maps over the canonical list, so a store node with no canonical counterpart
    // is ignored no matter what WORKSPACE_NODES_SOURCE says. These three had none.
    expect(ids).toContain("contract_intelligence");
    expect(ids).toContain("artifact_plan");
    expect(ids).toContain("publish_executor");
  });

  it("routes the client contract into article_body and the artifact plan into publish_payload", () => {
    const nodes = listWorkspaceNodes();
    // The four edges overlayStoreNode pins to canonical, and therefore would also have discarded.
    expect(nodes.find((node) => node.id === "article_body")?.dependsOn).toContain("contract_intelligence");
    expect(nodes.find((node) => node.id === "publish_payload")?.dependsOn).toContain("artifact_plan");
    expect(nodes.find((node) => node.id === "trust_factual")?.dependsOn).toContain("research");
    expect(nodes.find((node) => node.id === "emotional_resonance")?.dependsOn).toContain("input_triage");
  });

  it("has no duplicate ids", () => {
    const ids = listWorkspaceNodes().map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has valid dependencies and graph invariants", () => {
    expect(validateWorkspaceGraph()).toEqual({ valid: true, issues: [] });
  });

  it("marks article_body as the canonical client_object.v1 producer", () => {
    expect(listWorkspaceNodes().find((node) => node.id === "article_body")?.produces).toContain("client_object.v1");
  });

  it("connects publish_payload after article_body", () => {
    expect(listWorkspaceNodes().find((node) => node.id === "publish_payload")?.dependsOn).toContain("article_body");
  });

  it("marks publication_controller as publish risk", () => {
    expect(listWorkspaceNodes().find((node) => node.id === "publication_controller")?.riskLevel).toBe("publish");
  });

  // These two assertions previously pinned WORKSPACE-LOCAL edicts — the literal string
  // "rendering.placement" and "Markdown is adapter/export only". The alignment wave deliberately replaced
  // both with contract-driven equivalents, because the client brings its own publishing rules and a
  // workspace-local edict about a client's field names is exactly the assumption R-23 is about. The
  // substance is asserted here in its new form rather than dropped: media placement must still be honored,
  // and representation must still come from the contract instead of a workspace default.
  it("keeps media placement a requirement in article_body, sourced from the contract", () => {
    const node = listWorkspaceNodes().find((workspaceNode) => workspaceNode.id === "article_body");

    expect(node?.prompt).toContain("placement or rendering metadata the contract requires");
    expect(node?.prompt).toContain("silently drop the media");
    expect(node?.metadata?.canonicalRules).toEqual(expect.arrayContaining([
      "The client's fetched contract is the only authoritative content schema",
      "Renderable media fields carry the client's public path; raw artifact keys only in the client's designated reference fields"
    ]));
    // The replacement must not have loosened into "any workspace schema will do".
    expect(node?.metadata?.canonicalRules).toEqual(expect.arrayContaining(["Workspace-local article schemas are advisory and must never be used to validate"]));
  });

  it("keeps artifact verification and client-side validation binding on publish_payload", () => {
    const node = listWorkspaceNodes().find((workspaceNode) => workspaceNode.id === "publish_payload");

    expect(node?.prompt).toContain("artifactReferences");
    expect(node?.prompt).toContain("A pattern-valid key is not proof");
    expect(node?.metadata?.canonicalRules).toEqual(expect.arrayContaining([
      "Produces a dry-run candidate only, never a publish",
      "Client validation evidence is required; a workspace verdict is not sufficient",
      "Artifact references must be verified for the current request"
    ]));
  });

  // The two publish-risk nodes now CARRY project.call_tool. Both assign the dr_lurie_contract_intelligence
  // skill, which requests that tool, and without the grant both resolved allowed:false with
  // ["node_tool_not_allowed", "approval_required"] — activating publish_executor would have produced a
  // publisher that could not reach the client at all. The grant is a capability, not a permission: the
  // locks that actually stop a publish are unchanged and asserted here beside it.
  it("grants the publish-risk nodes the client call_tool capability while keeping every publish lock closed", () => {
    for (const nodeId of ["publish_executor", "publication_controller"]) {
      const node = listWorkspaceNodes().find((workspaceNode) => workspaceNode.id === nodeId);
      expect(node?.riskLevel, `${nodeId} stays publish-risk`).toBe("publish");
      expect(node?.allowedTools, `${nodeId} can reach the client`).toContain("project.call_tool");
      // project.call_tool is requiresApproval:true in the controlled-tool registry, so the grant alone
      // never executes anything — the tool still needs per-run approval. The contract skill is
      // deliberately NOT assigned here (node-system overhaul): its instructions request
      // project.call_read_tool, which these nodes rightly deny, and that mismatch was the standing
      // attention warning. The grant stays; the skill went.
      expect(node?.assignedSkills).toEqual([]);
    }
    expect(listWorkspaceNodes().find((node) => node.id === "publish_executor")?.status).toBe("draft");
  });

  // Defect (T-2, run_1785352838155_l544ye): F5's timeout audit sized every node the T-2 run actually
  // exercised, but learning_recorder depended on publication_controller completing — which a dry run's
  // own design never lets happen — so it had never actually run and F5 had no observed profile to size
  // it from. It kept the 120s global default and timed out the moment F4 made it fire for the first
  // time ever, on a node whose input is an entire run's worth of stage outputs. It now carries the
  // same explicit override draft_writer's own large single-output case needed.
  it("gives learning_recorder an explicit timeout sized for its large (whole-run) input", () => {
    const node = listWorkspaceNodes().find((candidate) => candidate.id === "learning_recorder");
    expect(node?.modelConfig?.timeout).toBeTypeOf("number");
    expect(node!.modelConfig!.timeout as number).toBeGreaterThanOrEqual(180000);
  });
});

// R-21 (T-2 finding F-7): article_body declared contract_intelligence in both dependsOn and
// requiredInputs while the conductor sequence omitted it, and validate_graph still said "valid".
// resolveConductorNodes maps over the canonical list, so a dependency outside that sequence is
// silently ignored at execution time; validation must flag it, not bless it.
describe("R-21: conductor-sequence dependency validation", () => {
  const clone = <T,>(value: T): T => structuredClone(value);

  it("flags a sequence node whose dependsOn entry is not in the conductor sequence, even when the node exists in the validated graph", () => {
    const nodes = clone(listWorkspaceNodes());
    // An authored node present in the workspace but absent from the canonical conductor sequence —
    // the exact F-7 shape: the old "Missing dependency" check cannot see anything wrong.
    const authored = { ...clone(nodes[0]), id: "authored_side_node", dependsOn: [], requiredInputs: [], produces: ["authored_output.v1"] };
    const articleBody = nodes.find((node) => node.id === "article_body")!;
    articleBody.dependsOn = [...articleBody.dependsOn, "authored_side_node"];

    const result = validateWorkspaceGraph([...nodes, authored]);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("Dependency not in conductor sequence for article_body: authored_side_node")]));
  });

  it("flags a sequence node whose requiredInputs artifact no sequence node produces", () => {
    const nodes = clone(listWorkspaceNodes());
    const articleBody = nodes.find((node) => node.id === "article_body")!;
    articleBody.requiredInputs = [...articleBody.requiredInputs, "phantom_artifact.v1"];

    const result = validateWorkspaceGraph(nodes);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("Required input not satisfiable by the conductor sequence for article_body: phantom_artifact.v1")]));
  });

  it("does not punish authored non-conductor nodes: they are not run by the conductor, so the sequence cannot starve them", () => {
    const nodes = clone(listWorkspaceNodes());
    const authored = { ...clone(nodes[0]), id: "authored_side_node", dependsOn: ["article_body"], requiredInputs: ["client_object.v1"], produces: ["authored_output.v1"] };
    expect(validateWorkspaceGraph([...nodes, authored])).toEqual({ valid: true, issues: [] });
  });

  it("still validates the canonical graph clean (no false positives from the new checks)", () => {
    expect(validateWorkspaceGraph()).toEqual({ valid: true, issues: [] });
  });
});
