import { describe, expect, it } from "vitest";
import { listWorkspaceNodes, validateWorkspaceGraph } from "../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../src/agent/execution/outputValidator.js";

describe("Publishing Conductor workspace nodes", () => {
  // R-22: 21, not 18 — nodes.ts is re-seeded from the live workspace by
  // scripts/seedNodesFromWorkspace.ts, which brought in contract_intelligence, artifact_plan and
  // publish_executor; before the re-seed the conductor ran an 18-node graph that no longer existed
  // anywhere but in this file, which is why T-2 certified an obsolete pipeline. §2.16 (2026-08-10)
  // adds placement_resolver (the computed aggression target) and monetization_strategy (the offer
  // decision before the brief): 23. This canonical change reaches live runs only via a deliberate
  // re-seed + redeploy (Wolf's coordinated step).
  // T15.6 (2026-08-25, ADR-2026-08-25-publish-autonomy §4.3) adds release_executor between
  // publish_executor and learning_recorder: 24.
  it("defines the full 24-node graph", () => {
    expect(listWorkspaceNodes()).toHaveLength(24);
  });

  // §2.16 — the two new scaffolds and their edges.
  it("wires placement_resolver between input_triage and topic_opportunity, and monetization_strategy between topic_opportunity and brief_architect", () => {
    const nodes = listWorkspaceNodes();
    const node = (id: string) => nodes.find((candidate) => candidate.id === id)!;
    expect(node("placement_resolver")).toMatchObject({ kind: "strategy", riskLevel: "read", status: "active", dependsOn: ["input_triage"], requiredInputs: ["input_triage"], produces: ["placement_resolution.v1"] });
    expect(node("placement_resolver").metadata?.placementResolverDeterministic).toBe(true);
    expect(node("topic_opportunity").dependsOn).toContain("placement_resolver");
    expect(node("topic_opportunity").requiredInputs).toContain("placement_resolver");
    expect(node("monetization_strategy")).toMatchObject({ riskLevel: "read", status: "active", dependsOn: ["topic_opportunity"], requiredInputs: ["topic_opportunity"], produces: ["monetization_strategy.v1"] });
    // The offer decision needs the monetizer project reachable at runtime — read-only surface only.
    expect(node("monetization_strategy").allowedTools).toContain("project.call_read_tool");
    expect(node("monetization_strategy").allowedTools).not.toContain("project.call_tool");
    // brief_architect's dependency is HARD: the brief is aimed at a selected offer, never written first.
    expect(node("brief_architect").dependsOn).toContain("monetization_strategy");
    expect(node("brief_architect").requiredInputs).toContain("monetization_strategy");
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

  // §2.14 (handoff 2026-08-10) — edges whose absence silently degraded output: article_body was
  // re-writing the article from notes because the drafted prose only reached it via
  // review_aggregator's single-string schema; emotional_resonance judged "resonance with the intended
  // audience" without ever receiving the audience definition; reader_simulation simulated drop-off
  // and conversion readiness from the draft alone.
  it("delivers the drafted prose and the audience/strategy context to the nodes that judge against them (§2.14)", () => {
    const nodes = listWorkspaceNodes();
    const edges = (id: string) => nodes.find((node) => node.id === id)!;
    expect(edges("article_body").dependsOn).toContain("draft_writer");
    expect(edges("article_body").requiredInputs).toContain("draft_writer");
    expect(edges("emotional_resonance").dependsOn).toEqual(expect.arrayContaining(["reader_insight", "objection_mapping"]));
    expect(edges("emotional_resonance").requiredInputs).toEqual(expect.arrayContaining(["reader_insight", "objection_mapping"]));
    expect(edges("reader_simulation").dependsOn).toEqual(expect.arrayContaining(["reader_insight", "objection_mapping", "angle_strategy"]));
    expect(edges("reader_simulation").requiredInputs).toEqual(expect.arrayContaining(["reader_insight", "objection_mapping", "angle_strategy"]));
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
    // publish_executor is ACTIVE, per the operator go-live of 2026-07-31 ("remove all publishing
    // barriers"). That decision was applied to the live workspace and never re-seeded, so this
    // assertion went on enforcing the pre-go-live draft state in code for eleven days — which is
    // precisely why nobody noticed that a static-mode run or a freshly seeded workspace would get a
    // publisher blocked on `draft status`. The locks that actually stop a publish are the riskLevel
    // gate and per-run approval on project.call_tool, both asserted above; node status is not one of
    // them, and pinning it here only froze the drift.
    expect(listWorkspaceNodes().find((node) => node.id === "publish_executor")?.status).toBe("active");
  });

  // §3 correctness batch (handoff 2026-08-10, items 2.24-2.29).
  describe("§3 lower-priority correctness items", () => {
    const node = (id: string) => listWorkspaceNodes().find((candidate) => candidate.id === id)!;

    // 2.24: artifact_plan metadata hardcoded "projectId": "pdf-tool" — the run carries projectId, and
    // the system's own rule forbids hardcoding a client into a node.
    it("artifact_plan no longer hardcodes a projectId in its metadata (2.24)", () => {
      expect(node("artifact_plan").metadata?.projectId).toBeUndefined();
    });

    // 2.25: ONE project.call_tool policy across the client-reaching nodes: reads go via
    // project.call_read_tool; project.call_tool is approval-gated and for writes only.
    //
    // artifact_plan is deliberately NOT in that set (2026-08-28). "Reads go via call_read_tool" is
    // true only of the verbs on call_read_tool's FIXED server-side allowlist (object_contract,
    // registry_get, object_inventory, object_get, object_list, object_validate, ping). The artifact
    // bridge's verbs are not on it, and two of them — get_agent_artifact_job_status and
    // get_agent_artifact_by_slot — only read. Routing those through call_read_tool is refused before
    // any transport with read_tool_operation_not_permitted, so artifact_plan must send them through
    // call_tool. Asserting the blanket writes-only sentence here forced the prompt to state a rule
    // that is false for this node, which is how the node came to be told nothing about polling an
    // asynchronous job at all.
    it("the three read-only client-reaching prompts state the same call_tool policy (2.25)", () => {
      for (const id of ["article_body", "publish_payload", "contract_intelligence"]) {
        const prompt = node(id).prompt;
        expect(prompt, `${id} names the read surface`).toContain("project.call_read_tool");
        expect(prompt, `${id} states the approval-gated writes-only rule`).toMatch(/approval-gated and (?:reserved )?for writes only|approval-gated and reserved for writes/);
        expect(prompt, `${id} carries no future-write grant language`).not.toContain("granted for a future write");
        expect(prompt).not.toContain("Reach external services only through project.call_tool");
      }
    });

    // artifact_plan's own routing rule, stated because the shared one does not fit it.
    it("artifact_plan routes the artifact bridge's own read verbs through call_tool (2.25b)", () => {
      const prompt = node("artifact_plan").prompt;
      expect(prompt, "names the read surface it still uses for contract/registry reads").toContain("project.call_read_tool");
      for (const verb of ["create_agent_artifact_job", "get_agent_artifact_job_status", "get_agent_artifact_by_slot"]) {
        expect(prompt, `names ${verb}`).toContain(verb);
      }
      expect(prompt, "says the bridge verbs are not on call_read_tool's allowlist").toContain("read_tool_operation_not_permitted");
      expect(prompt, "carries no future-write grant language").not.toContain("granted for a future write");
      expect(prompt).not.toContain("Reach external services only through project.call_tool");
    });

    // The defect this pair of assertions exists to prevent (2026-08-28, run_1787919896283_yybhg0):
    // the prompt asserted that create_agent_artifact_job "GENERATES the artifact AND VERIFIES it was
    // materialized ... before returning, so its response IS the verification evidence". It does not —
    // it returns a job whose terminal statuses are complete|failed. Believing the create response,
    // the node stopped after ~16s of polling and reported the hero slot blocked; the image
    // materialized nine seconds later and article_body was built with no media, so the run died at
    // the publish gate on media_requested_vs_delivered. A re-run then made a SECOND image, because
    // nothing told the node to adopt the artifact that already existed for the slot.
    it("artifact_plan treats artifact generation as asynchronous, and adopts before generating (2.25c)", () => {
      const prompt = node("artifact_plan").prompt;
      expect(prompt, "must not claim the create call returns verified").not.toMatch(/GENERATES the artifact AND VERIFIES/);
      expect(prompt, "names the create call as asynchronous").toMatch(/create_agent_artifact_job is ASYNCHRONOUS/);
      expect(prompt, "adopts an existing slot artifact before creating a job").toMatch(/get_agent_artifact_by_slot[\s\S]{0,600}CREATE NOTHING/);
      expect(prompt, "polls the job id to a terminal state").toMatch(/get_agent_artifact_job_status[\s\S]{0,400}terminal state/);
      expect(prompt, "an in-flight job is needs_generation, not blocked").toMatch(/still RUNNING[\s\S]{0,300}needs_generation/);
    });

    // 2.26: artifact_plan performs approval-gated writes (artifact generation) — the one pre-executor
    // node that does — so its approval flag matches the other approval-carrying nodes, and it holds
    // the read grant it needs to confirm the request id with the client.
    it("artifact_plan carries approvalRequired and the client read grant (2.26)", () => {
      expect(node("artifact_plan").metadata?.approvalRequired).toBe(true);
      expect(node("artifact_plan").allowedTools).toContain("project.call_read_tool");
    });

    // 2.28: the zero-media shortcut ("emit the plan immediately... with zero tool calls") used to
    // collide with a schema requiring artifactProtocol minLength 1 — a text-only article had to
    // invent a protocol string it never consulted. The schema is now honest: artifactProtocol may be
    // absent for a zero-media plan, and is still required the moment any media slot exists.
    it("artifact_plan's schema permits a protocol-less zero-media plan but requires the protocol once media exists (2.28)", () => {
      const artifactPlan = node("artifact_plan");
      const zeroMedia = { artifact: "artifact_plan.v1", summary: "Text-only object; no media slots.", clientProjectId: "client-x", clientObjectType: "content_item", media_slots: [] };
      const withMedia = { ...zeroMedia, media_slots: [{ slotId: "hero", purpose: "hero image", status: "needs_generation" }] };
      for (const schema of [artifactPlan.outputSchema, artifactPlan.schema]) {
        expect(validateOutput(zeroMedia, schema).ok).toBe(true);
        expect(validateOutput({ ...zeroMedia, artifactProtocol: "" }, schema).ok).toBe(false); // present must still be non-empty
        expect(validateOutput(withMedia, schema).ok).toBe(false); // media without a protocol
        expect(validateOutput({ ...withMedia, artifactProtocol: "agent_artifact_jobs" }, schema).ok).toBe(true);
      }
      // Both schema copies stay in sync.
      expect(artifactPlan.schema).toEqual(artifactPlan.outputSchema);
    });

    // 2.29: the prompt said "Inputs expected: article_brief" while requiredInputs is
    // ["brief_architect"] — node-name/artifact-name confusion.
    it("contract_intelligence's prompt names its input by node id and artifact (2.29)", () => {
      const prompt = node("contract_intelligence").prompt;
      expect(prompt).toContain("Inputs expected: brief_architect (its article_brief.v1 output)");
      expect(prompt).not.toContain("Inputs expected: article_brief,");
    });
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
