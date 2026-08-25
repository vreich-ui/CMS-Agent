import { describe, expect, it } from "vitest";
import {
  BLOCKER_SOURCE_CLASSES,
  DEFAULT_BLOCKER_CLASS,
  classifyBlockerSource,
  editorialBlockerSources,
  integrityBlockerSources
} from "../../../src/agent/workspace/blockerClassification.js";
import {
  buildPublicationDecision,
  collectSourcedBlockers,
  DEFAULT_CONTENT_CLASS,
  OWN_PROPERTY_CONTENT_CLASS,
  partitionBlockers,
  runDeterministicPublicationController,
  WAIVER_RULE_ID
} from "../../../src/agent/workspace/publicationController.js";
import { evaluatePlatformPublishReadiness } from "../../../src/agent/projects/platform/publishReadiness.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { readPublicationDecision } from "../../../src/agent/workspace/publishDecision.js";
import { buildGateEvents } from "../../../src/agent/workspace/learningRecord.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// W7 (2026-08-25, run_1787655709652_4k1z56) — editorial blockers are advisory, integrity blockers are
// not. This suite pins the split with the run that motivated it:
//
//   topic_opportunity: No viable public reader value for a real article.                     <- taste
//   brief_architect:   ...should be reframed as a real dermatology topic with evidence.      <- taste
//   publish_readiness: article_has_content (body.nodes is empty — nothing would render)      <- integrity
//   article_body:      article_body_validation_unavailable:MCP request failed with HTTP 401. <- integrity
//
// The controller treated all four as hard blocks ("no blocker class is exempt; every upstream blocker
// hard-blocks"), so a model's opinion about editorial quality stopped a publish exactly as hard as a
// broken integrity fact — and a fixture article could never publish however many approvals were given.
// What must hold now: taste advises, integrity blocks, nothing is dropped, unrecognised sources fail
// closed, and no existing gate is weakened.

const sampleBody = () => ({ slug: "governed-content-lifecycle", title: "Governed content lifecycle", nodes: [{ id: "n1", type: "paragraph", text: "Body. This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today. It is long enough to clear the readiness content floor." }] });

const sampleArticleBody = () => ({
  artifact: "client_object.v1",
  summary: "Client object built to the fetched contract.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-25T08:00:00.000Z", fingerprint: "fp_sample" },
  body: sampleBody(),
  blockers: []
});

const goReadiness = () => evaluatePlatformPublishReadiness({ articleBody: sampleArticleBody() });

// The two EDITORIAL blockers exactly as run_1787655709652_4k1z56 recorded them.
const RUN_EDITORIAL_BLOCKERS = [
  { nodeId: "topic_opportunity", output: { blockers: ["No viable public reader value for a real article."] } },
  { nodeId: "brief_architect", output: { blockers: ["The requested subject is a placeholder and should be reframed as a real dermatology topic with evidence."] } }
];

// The INTEGRITY blocker from the same run that came through an upstream stage output (the other,
// `publish_readiness: article_has_content`, arrives on the readiness checklist, exercised separately
// below).
const RUN_INTEGRITY_BLOCKER = { nodeId: "article_body", output: { blockers: ["article_body_validation_unavailable:MCP request failed with HTTP 401."] } };

const decide = (stageOutputs: Array<{ nodeId: string; output: unknown }>, extra: Partial<Parameters<typeof buildPublicationDecision>[0]> = {}) =>
  buildPublicationDecision({
    readiness: goReadiness(),
    clientProjectId: "platform",
    contentClass: DEFAULT_CONTENT_CLASS,
    upstreamBlockers: collectSourcedBlockers(stageOutputs),
    ...extra
  });

describe("W7 — run_1787655709652_4k1z56: taste advises, integrity blocks", () => {
  it("an editorial-only blocker set yields \"go\", with every advisory recorded and none in blockers", () => {
    const decision = decide(RUN_EDITORIAL_BLOCKERS);

    expect(decision.decision).toBe("go");
    expect(decision.blockers).toEqual([]);
    expect(decision.state).toBe("ready_for_publish_execution");
    // Nothing was silently dropped: both objections survive in the record, named with the node that
    // raised them and the rationale that demoted them.
    expect(decision.advisories.map((entry) => entry.nodeId)).toEqual(["topic_opportunity", "brief_architect"]);
    expect(decision.advisories[0]!.blocker).toBe("No viable public reader value for a real article.");
    expect(decision.advisories[1]!.blocker).toContain("reframed as a real dermatology topic with evidence");
    for (const advisory of decision.advisories) {
      expect(advisory.class).toBe("editorial");
      expect(advisory.rationale.length).toBeGreaterThan(0);
    }
    // The record still satisfies the publish gate's own reader — a "go" with an empty blockers array.
    expect(readPublicationDecision(decision)).toEqual({ authorized: true, decision: "go" });
  });

  it("an integrity blocker from the same run still blocks, while the editorial ones beside it only advise", () => {
    const decision = decide([...RUN_EDITORIAL_BLOCKERS, RUN_INTEGRITY_BLOCKER]);

    expect(decision.decision).toBe("blocked");
    expect(decision.blockers).toEqual(["article_body: article_body_validation_unavailable:MCP request failed with HTTP 401."]);
    expect(decision.advisories).toHaveLength(2);
    expect(readPublicationDecision(decision).authorized).toBe(false);
  });

  it("the readiness checklist is untouched by the split: an empty body is still no_go, advisories or not", () => {
    // `article_has_content` — "body.nodes is empty — nothing would render" — is the readiness policy's
    // own verdict, not an upstream blocker, and the split must not be able to reach it.
    const emptyBodyReadiness = evaluatePlatformPublishReadiness({ articleBody: { ...sampleArticleBody(), body: { ...sampleBody(), nodes: [] } } });
    expect(emptyBodyReadiness.status).toBe("no_go");
    expect(emptyBodyReadiness.blockers).toContain("article_has_content");

    const decision = decide(RUN_EDITORIAL_BLOCKERS, { readiness: emptyBodyReadiness });

    expect(decision.decision).toBe("no_go");
    expect(decision.blockers).toContain("publish_readiness: article_has_content");
    expect(decision.advisories).toHaveLength(2);
    expect(readPublicationDecision(decision).authorized).toBe(false);
  });

  it("counts hard blockers and advisories separately in the summary, so the totals stay honest", () => {
    const decision = decide([...RUN_EDITORIAL_BLOCKERS, RUN_INTEGRITY_BLOCKER]);

    expect(decision.summary).toContain("1 hard blocker(s)");
    expect(decision.summary).toContain("2 advisory blocker(s)");
    expect(decision.summary).toContain("0 waived under standing rule");
    // And the notes say which advisories those were, so a reader of the artifact alone can audit it.
    expect(decision.notes.some((note) => note.startsWith("Advisory (editorial, non-gating"))).toBe(true);
    expect(decision.notes.some((note) => note.includes("No viable public reader value"))).toBe(true);
    // The old note that stated the defect out loud is gone.
    expect(decision.notes.some((note) => note.includes("every upstream blocker hard-blocks"))).toBe(false);
  });
});

describe("W7 — the classification is fail-closed", () => {
  it("treats an unrecognised source as INTEGRITY, so a node nobody classified still hard-blocks", () => {
    const classified = classifyBlockerSource("some_node_invented_next_tuesday");
    expect(classified.class).toBe("integrity");
    expect(classified.basis).toBe("unclassified_default");
    expect(DEFAULT_BLOCKER_CLASS).toBe("integrity");

    const decision = decide([{ nodeId: "some_node_invented_next_tuesday", output: { blockers: ["this node has an opinion nobody has classified yet."] } }]);
    expect(decision.decision).toBe("blocked");
    expect(decision.blockers).toEqual(["some_node_invented_next_tuesday: this node has an opinion nobody has classified yet."]);
    expect(decision.advisories).toEqual([]);
  });

  it("keeps trust_factual on the INTEGRITY side deliberately — it is fact-check and reader safety, not taste", () => {
    expect(BLOCKER_SOURCE_CLASSES.trust_factual!.class).toBe("integrity");
    expect(BLOCKER_SOURCE_CLASSES.trust_factual!.why).toMatch(/consumer-health|safety/i);

    const decision = decide([
      ...RUN_EDITORIAL_BLOCKERS,
      { nodeId: "trust_factual", output: { blockers: ["unsupported_claim: the piece states a treatment outcome no cited source supports."] } }
    ]);
    expect(decision.decision).toBe("blocked");
    expect(decision.blockers).toEqual(["trust_factual: unsupported_claim: the piece states a treatment outcome no cited source supports."]);
  });

  it("classifies every node the workspace actually has, so a new node is a reviewable diff and never a silent gap", () => {
    // The runtime default already makes a miss SAFE (unrecognised ⇒ integrity ⇒ blocks). This pins that
    // it is also DELIBERATE: adding a node without a line in the table fails here, where the fix is one
    // line and a rationale, rather than quietly inheriting the fail-closed default forever.
    const unclassified = listWorkspaceNodes().map((node) => node.id).filter((id) => !(id in BLOCKER_SOURCE_CLASSES));
    expect(unclassified).toEqual([]);
  });

  it("names the split it claims to make: the editorial list is exactly the taste nodes, integrity holds the rest", () => {
    expect(editorialBlockerSources()).toEqual([
      "angle_strategy",
      "brief_architect",
      "draft_writer",
      "emotional_resonance",
      "human_texture",
      "monetization_strategy",
      "narrative_movement",
      "objection_mapping",
      "reader_insight",
      "reader_simulation",
      "research",
      "review_aggregator",
      "topic_opportunity"
    ]);
    // publish_readiness is a pseudo-source (the prefix the controller puts on readiness-checklist
    // failures) and belongs on the integrity side of the table for exactly the same reason it can never
    // be demoted in code.
    expect(integrityBlockerSources()).toContain("publish_readiness");
    expect(integrityBlockerSources()).toContain("trust_factual");
  });
});

describe("W7 — the project-level override is promotion only", () => {
  it("promotes an editorial source back to hard when the project asks for it", () => {
    const classified = classifyBlockerSource("brief_architect", ["brief_architect"]);
    expect(classified.class).toBe("integrity");
    expect(classified.basis).toBe("project_override");
    expect(classified.why).toContain("publishingPolicy.hardBlockerSources");

    const decision = decide(RUN_EDITORIAL_BLOCKERS, { hardBlockerSources: ["brief_architect"] });
    expect(decision.decision).toBe("blocked");
    expect(decision.blockers).toEqual(["brief_architect: The requested subject is a placeholder and should be reframed as a real dermatology topic with evidence."]);
    // topic_opportunity was not promoted, so it still only advises.
    expect(decision.advisories.map((entry) => entry.nodeId)).toEqual(["topic_opportunity"]);
    expect(decision.notes.some((note) => note.includes("promotes brief_architect back to hard"))).toBe(true);
  });

  it("cannot demote an INTEGRITY source, whatever a project lists", () => {
    // The list is consulted ONLY for sources already classified editorial, so naming an integrity source
    // is a harmless no-op that still reports the engine — not the tenant — as the reason it is hard.
    expect(classifyBlockerSource("article_body", ["article_body"])).toMatchObject({ class: "integrity", basis: "table" });
    expect(classifyBlockerSource("trust_factual", ["trust_factual"])).toMatchObject({ class: "integrity", basis: "table" });
    const partition = partitionBlockers([{ nodeId: "article_body", blocker: "article_body_validation_unavailable:MCP request failed with HTTP 401." }], DEFAULT_CONTENT_CLASS, ["article_body"]);
    expect(partition.advisory).toEqual([]);
    expect(partition.blocking).toHaveLength(1);
  });

  it("reads the promotion list off the project's own publishingPolicy through the registry", async () => {
    const withPolicy = (hardBlockerSources?: string[]): ProjectRepository => ({
      list: async () => [],
      get: async () => ({
        projectId: "platform",
        name: "Platform",
        mcpEndpointEnvVar: "PLATFORM_MCP_ENDPOINT",
        authMode: "none",
        allowedTools: [],
        contentContract: { contentContract: "content_source.v1" },
        publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test", ...(hardBlockerSources ? { hardBlockerSources } : {}) },
        status: "active"
      } as ProjectConnectionConfig),
      save: async (config) => config,
      delete: async () => false,
      health: async () => ({ backend: "memory", healthy: true }) as never
    });
    const sources = {
      projectId: "platform",
      clientProjectId: "platform",
      articleBody: sampleArticleBody(),
      stageOutputs: RUN_EDITORIAL_BLOCKERS,
      contentClassCarriers: []
    };

    const withoutOverride = await runDeterministicPublicationController(sources, { projectRepository: withPolicy() });
    expect(withoutOverride.ok && withoutOverride.decision.decision).toBe("go");
    expect(withoutOverride.ok && withoutOverride.decision.advisories).toHaveLength(2);

    const withOverride = await runDeterministicPublicationController(sources, { projectRepository: withPolicy(["topic_opportunity"]) });
    expect(withOverride.ok && withOverride.decision.decision).toBe("blocked");
    expect(withOverride.ok && withOverride.decision.blockers).toEqual(["topic_opportunity: No viable public reader value for a real article."]);
  });

  it("records an unreadable project policy in the notes instead of pretending it applied one", async () => {
    const throwing: ProjectRepository = {
      list: async () => [],
      get: async () => { throw new Error("registry unreachable"); },
      save: async (config) => config,
      delete: async () => false,
      health: async () => ({ backend: "memory", healthy: true }) as never
    };
    const result = await runDeterministicPublicationController({
      projectId: "platform",
      clientProjectId: "platform",
      articleBody: sampleArticleBody(),
      stageOutputs: RUN_EDITORIAL_BLOCKERS,
      contentClassCarriers: []
    }, { projectRepository: throwing });

    expect(result.ok).toBe(true);
    expect(result.ok && result.decision.notes.some((note) => note.includes("registry unreachable"))).toBe(true);
    // An override can only ADD hardness, so failing to read one never opened a gate that was closed.
    expect(result.ok && result.decision.decision).toBe("go");
  });
});

describe("W7 — the run record shows what was demoted", () => {
  it("records advisories as their own gate event, so \"advisory\" is never indistinguishable from \"dropped\"", () => {
    const decision = decide(RUN_EDITORIAL_BLOCKERS);
    const events = buildGateEvents({ stageOutputs: { publication_controller: decision } } as never);
    const advisoryEvent = events.find((event) => event.event === "blockers_advisory");

    expect(advisoryEvent).toBeDefined();
    expect(advisoryEvent!.detail).toContain("2 editorial blocker(s) recorded as advisory");
    expect(advisoryEvent!.detail).toContain("topic_opportunity: No viable public reader value for a real article.");
    // The decision event beside it reports the HARD count, which is zero on this run.
    expect(events.find((event) => event.event === "publication_decision")!.detail).toContain("with 0 blocker(s)");
  });

  it("emits no advisory event when nothing was demoted", () => {
    const events = buildGateEvents({ stageOutputs: { publication_controller: decide([]) } } as never);
    expect(events.some((event) => event.event === "blockers_advisory")).toBe(false);
  });
});

describe("W7 — nothing else about the decision moved", () => {
  it("leaves the own-property waiver first in line, still audited under its own rule id", () => {
    // monetization_strategy is EDITORIAL, but on own-property content its EV-floor blocker is excused by
    // a STANDING OPERATOR RULING, and the audit trail must say so — "waived under
    // own_property_ev_and_aggression_exemption", not a generic editorial advisory.
    const partition = partitionBlockers(
      [{ nodeId: "monetization_strategy", blocker: "ev_floor: expected value does not clear the EV floor for this run." }],
      OWN_PROPERTY_CONTENT_CLASS
    );
    expect(partition.waived).toEqual([expect.objectContaining({ rule: WAIVER_RULE_ID, nodeId: "monetization_strategy" })]);
    expect(partition.advisory).toEqual([]);
    expect(partition.blocking).toEqual([]);
  });

  it("still emits a schema-valid record the publish gate reads, with advisories present and blockers empty", () => {
    const decision = decide(RUN_EDITORIAL_BLOCKERS);
    // `go` requires an EMPTY blockers array — the store schema's if/then and readPublicationDecision
    // both enforce it, and an advisory must never leak into that array.
    expect(validateOutput(decision, {
      type: "object",
      additionalProperties: true,
      required: ["artifact", "summary", "decision", "blockers"],
      properties: { artifact: { const: "publication_decision.v1" }, summary: { type: "string", minLength: 1 }, decision: { enum: ["go", "no_go", "blocked"] }, blockers: { type: "array", items: { type: "string" } } },
      if: { required: ["decision"], properties: { decision: { const: "go" } } },
      then: { properties: { blockers: { maxItems: 0 } } }
    }).ok).toBe(true);
    expect(decision.advisories).toHaveLength(2);
  });
});
