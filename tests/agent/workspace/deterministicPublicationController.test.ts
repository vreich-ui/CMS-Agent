import { describe, expect, it } from "vitest";
import {
  buildPublicationDecision,
  collectSourcedBlockers,
  DEFAULT_CONTENT_CLASS,
  isOwnProperty,
  OWN_PROPERTY_CONTENT_CLASS,
  partitionBlockers,
  readContentClass,
  runDeterministicPublicationController,
  WAIVER_RULE_ID
} from "../../../src/agent/workspace/publicationController.js";
import { evaluatePlatformPublishReadiness } from "../../../src/agent/projects/platform/publishReadiness.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { readPublicationDecision } from "../../../src/agent/workspace/publishDecision.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// W1 + W6.1 (determinism program, 2026-08-12). This suite proves:
//   (1) the mapping — readiness.status -> decision, checklist[].detail -> notes, blockers -> blockers —
//       and that the built record satisfies BOTH the node's canonical outputSchema and the store's
//       fixed publication_decision schema (decision enum + if/then forcing empty blockers on "go"),
//       AND the publish gate's own reader (readPublicationDecision);
//   (2) W6.1 — an upstream blocker reaches the decision and prevents "go" (the live defect on
//       run_1786468126136_ev9goe was a "go" emitted alongside aggression_ceiling_missing and an
//       EV-floor block);
//   (3) the own-property waiver is BY RULE and AUDITED: exactly the two exempt classes are waived,
//       only on own-property content, and every waived blocker is recorded with its rule and source;
//   (4) wired into a real run it replaces the model call entirely (openai mode, no provider stub).

// The store-side schema publication_controller actually carries (work order §W1: "required decision
// enum go/no_go/blocked with an if/then forcing empty blockers on go"). The canonical seed in nodes.ts
// is the looser {artifact, summary} shape, so this replica is what pins the deterministic record to
// the schema it must satisfy in production.
const storePublicationDecisionSchema = {
  type: "object",
  additionalProperties: true,
  required: ["artifact", "summary", "decision", "blockers"],
  properties: {
    artifact: { const: "publication_decision.v1" },
    summary: { type: "string", minLength: 1 },
    decision: { enum: ["go", "no_go", "blocked"] },
    blockers: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  },
  if: { required: ["decision"], properties: { decision: { const: "go" } } },
  then: { properties: { blockers: { maxItems: 0 } } }
};

const sampleBody = () => ({ slug: "governed-content-lifecycle", title: "Governed content lifecycle", nodes: [{ id: "n1", type: "paragraph", text: "Body." }] });

const sampleArticleBody = (overrides: Record<string, unknown> = {}) => ({
  artifact: "client_object.v1",
  summary: "Client object built to the fetched contract.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-12T08:00:00.000Z", fingerprint: "fp_sample" },
  body: sampleBody(),
  blockers: [],
  ...overrides
});

const goReadiness = () => evaluatePlatformPublishReadiness({ articleBody: sampleArticleBody() });

describe("W1 — the readiness mapping", () => {
  it("maps a GO readiness verdict onto decision \"go\" with an empty blockers array", () => {
    const readiness = goReadiness();
    expect(readiness.status).toBe("go");

    const decision = buildPublicationDecision({ readiness, clientProjectId: "platform", contentClass: DEFAULT_CONTENT_CLASS, upstreamBlockers: [] });

    expect(decision.artifact).toBe("publication_decision.v1");
    expect(decision.decision).toBe("go");
    expect(decision.blockers).toEqual([]);
    expect(decision.state).toBe("ready_for_publish_execution");
    expect(decision.summary).toMatch(/No model call/);
  });

  it("carries every checklist entry's detail into notes, and every readiness blocker into blockers", () => {
    // Approval explicitly withheld is platform's own no_go path.
    const readiness = evaluatePlatformPublishReadiness({ articleBody: sampleArticleBody(), approval: { pinned: false } });
    expect(readiness.status).toBe("no_go");

    const decision = buildPublicationDecision({ readiness, clientProjectId: "platform", contentClass: DEFAULT_CONTENT_CLASS, upstreamBlockers: [] });

    expect(decision.decision).toBe("no_go");
    expect(decision.state).toBe("blocked_for_publish_execution");
    expect(decision.blockers).toContain("publish_readiness: pinned_approval");
    for (const check of readiness.checklist) {
      expect(decision.notes.some((note) => note.startsWith(`${check.key} [${check.status}]`))).toBe(true);
      if (check.detail) expect(decision.notes.some((note) => note.includes(check.detail!))).toBe(true);
    }
    expect(decision.checklist).toEqual(readiness.checklist);
  });

  it("satisfies the node's canonical outputSchema, the store's fixed decision schema, and the publish gate's own reader", () => {
    const decision = buildPublicationDecision({ readiness: goReadiness(), clientProjectId: "platform", contentClass: DEFAULT_CONTENT_CLASS, upstreamBlockers: [] });

    expect(validateOutput(decision, getWorkspaceNode("publication_controller")?.outputSchema).ok).toBe(true);
    expect(validateOutput(decision, storePublicationDecisionSchema).ok).toBe(true);
    // The gate that actually consumes this record must read it as an authorization.
    expect(readPublicationDecision(decision)).toEqual({ authorized: true, decision: "go" });
  });

  it("refuses to decide for a project with no readiness policy rather than inventing a checklist", async () => {
    const result = await runDeterministicPublicationController({
      projectId: "project-with-no-hooks",
      clientProjectId: "project-with-no-hooks",
      articleBody: sampleArticleBody(),
      stageOutputs: [],
      contentClassCarriers: []
    });
    expect(result).toEqual({ ok: false, code: "readiness_policy_unavailable", error: expect.stringContaining("no publish-readiness policy") });
  });
});

describe("W6.1 — blocker propagation as a rule", () => {
  const upstream = [
    { nodeId: "input_triage", output: { artifact: "content_source.v1", blockers: [] } },
    { nodeId: "contract_intelligence", output: { artifact: "contract_intelligence.v1", blockers: ["aggression_ceiling_missing: the client contract declares no aggression_ceiling."] } },
    { nodeId: "monetization_strategy", output: { artifact: "monetization_strategy.v1", blockers: ["ev_floor: expected value does not clear the EV floor for this run."] } },
    { nodeId: "artifact_plan", output: { artifact: "artifact_plan.v1", blockers: ["artifact_unverified: hero image was never materialized for this request."] } }
  ];

  it("collects blockers from every upstream stage output, in node order, de-duplicated", () => {
    const collected = collectSourcedBlockers([...upstream, { nodeId: "publish_payload", output: { blockers: ["Aggression_Ceiling_Missing:  the client contract declares no aggression_ceiling."] } }]);
    expect(collected.map((entry) => entry.nodeId)).toEqual(["contract_intelligence", "monetization_strategy", "artifact_plan"]);
  });

  it("cannot emit \"go\" while an unwaived upstream blocker exists — even on a GO readiness verdict", () => {
    const decision = buildPublicationDecision({ readiness: goReadiness(), clientProjectId: "platform", contentClass: DEFAULT_CONTENT_CLASS, upstreamBlockers: collectSourcedBlockers(upstream) });

    expect(goReadiness().status).toBe("go");
    expect(decision.decision).toBe("blocked");
    expect(decision.waivedBlockers).toEqual([]);
    expect(decision.blockers).toEqual([
      "contract_intelligence: aggression_ceiling_missing: the client contract declares no aggression_ceiling.",
      "monetization_strategy: ev_floor: expected value does not clear the EV floor for this run.",
      "artifact_plan: artifact_unverified: hero image was never materialized for this request."
    ]);
    // And the publish gate refuses it, which is the whole point of the propagation rule.
    expect(readPublicationDecision(decision).authorized).toBe(false);
    expect(validateOutput(decision, storePublicationDecisionSchema).ok).toBe(true);
  });

  it("waives exactly the two exempt classes on own-property content, and records each waiver with its rule and source", () => {
    const decision = buildPublicationDecision({ readiness: goReadiness(), clientProjectId: "platform", contentClass: OWN_PROPERTY_CONTENT_CLASS, upstreamBlockers: collectSourcedBlockers(upstream) });

    expect(decision.waivedBlockers.map((entry) => entry.nodeId)).toEqual(["contract_intelligence", "monetization_strategy"]);
    for (const waived of decision.waivedBlockers) {
      expect(waived.rule).toBe(WAIVER_RULE_ID);
      expect(waived.reason).toMatch(/Wolf, 2026-08-12/);
      expect(waived.blocker.length).toBeGreaterThan(0);
    }
    // The third blocker is NOT exempt, so the decision still cannot be "go".
    expect(decision.decision).toBe("blocked");
    expect(decision.blockers).toEqual(["artifact_plan: artifact_unverified: hero image was never materialized for this request."]);
    expect(decision.notes.some((note) => note.includes(WAIVER_RULE_ID))).toBe(true);
  });

  it("reaches \"go\" on own-property content when the only blockers are the exempt classes — with the waiver still audited", () => {
    const exemptOnly = collectSourcedBlockers(upstream.slice(0, 3));
    const decision = buildPublicationDecision({ readiness: goReadiness(), clientProjectId: "platform", contentClass: OWN_PROPERTY_CONTENT_CLASS, upstreamBlockers: exemptOnly });

    expect(decision.decision).toBe("go");
    expect(decision.blockers).toEqual([]);
    expect(decision.waivedBlockers).toHaveLength(2);
    expect(decision.contentClass).toBe(OWN_PROPERTY_CONTENT_CLASS);
    expect(validateOutput(decision, storePublicationDecisionSchema).ok).toBe(true);
    expect(readPublicationDecision(decision).authorized).toBe(true);
  });

  it("waives nothing for content that is not own-property, whatever the blocker says", () => {
    const partition = partitionBlockers(collectSourcedBlockers(upstream), DEFAULT_CONTENT_CLASS);
    expect(partition.waived).toEqual([]);
    expect(partition.blocking).toHaveLength(3);
  });

  it("does not waive a blocker that merely mentions monetization or aggression in passing", () => {
    const partition = partitionBlockers(
      [
        { nodeId: "monetization_strategy", blocker: "monetizer_unreachable: the offers endpoint refused the read." },
        { nodeId: "draft_writer", blocker: "the resolved vector was never consumed by the draft." }
      ],
      OWN_PROPERTY_CONTENT_CLASS
    );
    expect(partition.waived).toEqual([]);
    expect(partition.blocking).toHaveLength(2);
  });
});

describe("W6.1 — the own-property signal is explicit", () => {
  it("reads the content class from the run's initial input, top level or under contentSource", () => {
    expect(readContentClass({ contentClass: "own_property" })).toBe(OWN_PROPERTY_CONTENT_CLASS);
    expect(readContentClass({ contentSource: { content_class: "OWN-PROPERTY" } })).toBe(OWN_PROPERTY_CONTENT_CLASS);
    expect(readContentClass({ ownProperty: true })).toBe(OWN_PROPERTY_CONTENT_CLASS);
    expect(readContentClass({ own_property: false })).toBe(DEFAULT_CONTENT_CLASS);
  });

  it("defaults to a non-exempt class when nothing declares one — an absent field never waives anything", () => {
    expect(readContentClass(undefined, "a string request", { summary: "no class here" })).toBe(DEFAULT_CONTENT_CLASS);
    expect(isOwnProperty(readContentClass({}))).toBe(false);
  });

  it("takes the first explicit declaration in carrier order (run input beats a downstream echo)", () => {
    expect(readContentClass({ contentClass: "client_property" }, { contentClass: "own_property" })).toBe("client_property");
    expect(readContentClass({ summary: "no class" }, { contentClass: "own_property" })).toBe(OWN_PROPERTY_CONTENT_CLASS);
  });
});

describe("wired into a real run: replaces the model call entirely", () => {
  // Enter late-stage at publish_payload so publication_controller is the only node this run
  // dispatches. "openai" mode with no provider configured anywhere: if the deterministic path did NOT
  // fire, the model runner would attempt a real call and this test would fail. Succeeding IS the proof.
  const startAtController = async (extra: { initialInput?: unknown; upstreamBlockers?: string[] } = {}) => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.updateNode("publication_controller", { metadata: { publicationControllerDeterministic: true } }, { actor: "w1-test" });

    const payload = {
      artifact: "dry_run_publish_payload.v1",
      summary: "Deterministic dry-run publish candidate.",
      clientProjectId: "platform",
      clientObjectType: "content_item",
      contractSource: { tool: "object_contract", fingerprint: "fp_sample" },
      dryRun: true,
      clientObject: sampleBody(),
      blockers: extra.upstreamBlockers ?? []
    };
    const started = await startDryRun({
      executionMode: "openai",
      projectId: "platform",
      input: extra.initialInput ?? "W1 e2e",
      budgetUsd: 100,
      entrypoint: { nodeId: "publish_payload", output: payload }
    }, store, workspace);
    const run = (await getRun(started.runId, store))!;
    // The readiness policy reads article_body's envelope; the entrypoint seeds publish_payload's
    // ancestors as completed with no output, so supply the body the controller's decision is about.
    run.stageOutputs.article_body = sampleArticleBody();
    await store.saveRun(run);
    return { runId: started.runId, store, workspace };
  };

  it("completes publication_controller with zero model calls and zero usage records", async () => {
    repositoryManager.getUsageRepository().clear();
    const { runId, store, workspace } = await startAtController();

    const run = await runNextNode(runId, { executionRepository: store, workspaceRepository: workspace, approved: true });
    const state = run!.nodes.find((node) => node.nodeId === "publication_controller")!;

    expect(state.status).toBe("completed");
    const output = state.output as { artifact: string; decision: string; blockers: string[]; summary: string; contentClass: string };
    expect(output.artifact).toBe("publication_decision.v1");
    expect(output.decision).toBe("go");
    expect(output.blockers).toEqual([]);
    expect(output.contentClass).toBe(DEFAULT_CONTENT_CLASS);
    expect(output.summary).toMatch(/No model call/);
    expect(await repositoryManager.getUsageRepository().list({ runId, nodeId: "publication_controller" })).toEqual([]);
  });

  it("carries an upstream blocker into the decision, and waives it only when the run declares own-property content", async () => {
    const blocked = await startAtController({ upstreamBlockers: ["ev_floor: expected value does not clear the EV floor."] });
    const blockedRun = await runNextNode(blocked.runId, { executionRepository: blocked.store, workspaceRepository: blocked.workspace, approved: true });
    const blockedOutput = blockedRun!.nodes.find((node) => node.nodeId === "publication_controller")!.output as { decision: string; blockers: string[]; waivedBlockers: unknown[] };
    expect(blockedOutput.decision).toBe("blocked");
    expect(blockedOutput.blockers).toEqual(["publish_payload: ev_floor: expected value does not clear the EV floor."]);
    expect(blockedOutput.waivedBlockers).toEqual([]);

    const waived = await startAtController({ upstreamBlockers: ["ev_floor: expected value does not clear the EV floor."], initialInput: { request: "own property docs page", contentClass: "own_property" } });
    const waivedRun = await runNextNode(waived.runId, { executionRepository: waived.store, workspaceRepository: waived.workspace, approved: true });
    const waivedOutput = waivedRun!.nodes.find((node) => node.nodeId === "publication_controller")!.output as { decision: string; blockers: string[]; waivedBlockers: Array<{ rule: string; nodeId: string }>; contentClass: string };
    expect(waivedOutput.decision).toBe("go");
    expect(waivedOutput.blockers).toEqual([]);
    expect(waivedOutput.contentClass).toBe(OWN_PROPERTY_CONTENT_CLASS);
    expect(waivedOutput.waivedBlockers).toEqual([expect.objectContaining({ rule: WAIVER_RULE_ID, nodeId: "publish_payload" })]);
  });
});
