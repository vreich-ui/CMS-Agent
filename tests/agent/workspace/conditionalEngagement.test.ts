import { describe, expect, it } from "vitest";
import { evaluateNodeSkip } from "../../../src/agent/workspace/skipPredicates.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { buildContentHaltDecision, collectSourcedBlockers, readContentHalt } from "../../../src/agent/workspace/publicationController.js";

// The exact shape draft_writer returned on proof run run_1789303857536_obd2fd: blocked, four reasons,
// and (before B4) four reviewers, the aggregator, contract_intelligence and artifact_plan dispatched
// after it anyway.
const BLOCKED_DRAFT = {
  artifact: "draft.v1",
  summary: "Draft blocked pending evidence.",
  draftStatus: "blocked",
  blockers: [
    "No usable source for the stair-hesitation prevalence claim.",
    "Evidence for the analgesia guidance is a single manufacturer page.",
    "The brief asks for a veterinary escalation threshold that no cited source states.",
    "Two of the three requested sources returned no readable text."
  ],
  advisories: []
};
const READY_DRAFT = { artifact: "draft.v1", summary: "Draft ready.", draftStatus: "ready", blockers: [], advisories: [] };
const UNAVAILABLE_RESEARCH = { artifact: "research_brief.v1", summary: "Evidence unobtainable.", evidenceStatus: "unavailable", blockers: ["Every candidate source was paywalled or unreadable."], sources: [], findings: [] };
const SUPPORTED_RESEARCH = { artifact: "research_brief.v1", summary: "Three sources.", evidenceStatus: "supported", blockers: [], sources: [{ sourceId: "s1" }], findings: [{ claimId: "c1" }] };

const node = (id: string) => { const found = listWorkspaceNodes().find((entry) => entry.id === id)!; return { id: found.id, dependsOn: found.dependsOn, metadata: found.metadata }; };
const skipped = (ids: readonly string[], stageOutputs: Record<string, unknown>) => ids.filter((id) => evaluateNodeSkip(node(id), { stageOutputs })?.skip === true);

// Everything the proof run paid for after the writer refused.
const WASTED_ON_A_BLOCKED_DRAFT = ["human_texture", "trust_factual", "emotional_resonance", "reader_simulation", "review_aggregator", "artifact_plan", "artifact_materializer", "article_body", "publish_payload"] as const;

describe("conditional engagement — draft_blocked (B4)", () => {
  it("skips every stage that would work on a draft that does not exist", () => {
    expect(skipped(WASTED_ON_A_BLOCKED_DRAFT, { draft_writer: BLOCKED_DRAFT })).toEqual([...WASTED_ON_A_BLOCKED_DRAFT]);
  });

  it("changes nothing on a normal run", () => {
    expect(skipped(WASTED_ON_A_BLOCKED_DRAFT, { draft_writer: READY_DRAFT, research: SUPPORTED_RESEARCH })).toEqual([]);
  });

  it("fires on blockers alone when the status field did not survive — a refusal must not be lost to a missing field", () => {
    const { draftStatus: _dropped, ...noStatus } = BLOCKED_DRAFT;
    expect(evaluateNodeSkip(node("review_aggregator"), { stageOutputs: { draft_writer: noStatus } })?.skip).toBe(true);
  });

  it('does NOT fire on the contradiction "ready with blockers" — a contradiction is uncertainty, and uncertainty runs', () => {
    // The writer's schema forbids that pairing, so seeing it means something upstream is wrong, not
    // that the draft is definitely blocked. Those blockers still reach publication_controller through
    // collectSourcedBlockers and still refuse the publish; they just do not cancel the pipeline.
    const contradictory = { ...READY_DRAFT, blockers: ["trust_factual: unresolved factual refusal"] };
    expect(evaluateNodeSkip(node("review_aggregator"), { stageOutputs: { draft_writer: contradictory } })?.skip).toBe(false);
    expect(readContentHalt({ draft_writer: contradictory })).toBeUndefined();
  });

  it("never fires on an absent, unreadable or mock draft — every uncertainty resolves toward running", () => {
    for (const draft of [undefined, "not an object", { ...BLOCKED_DRAFT, dryRun: true }]) {
      expect(evaluateNodeSkip(node("review_aggregator"), { stageOutputs: { draft_writer: draft } })?.skip).toBe(false);
    }
  });

  it("leaves publication_controller and contract_intelligence to run", () => {
    // The controller has to record the halt; the contract read is not a content stage.
    expect(skipped(["publication_controller", "contract_intelligence"], { draft_writer: BLOCKED_DRAFT })).toEqual([]);
  });

  it("carries the writer's reasons into the skip reason, so the record says why", () => {
    const verdict = evaluateNodeSkip(node("trust_factual"), { stageOutputs: { draft_writer: BLOCKED_DRAFT } })!;
    expect(verdict.reason).toContain("No usable source for the stair-hesitation prevalence claim.");
    expect(verdict.basis).toContain("contentHalt: draft_blocked (draft_writer)");
  });
});

describe("conditional engagement — research_unavailable (B4)", () => {
  const AFTER_RESEARCH = ["objection_mapping", "narrative_movement", "angle_strategy", "brief_architect", "draft_writer", ...WASTED_ON_A_BLOCKED_DRAFT] as const;

  it("skips everything after research when the evidence cannot be obtained", () => {
    expect(skipped(AFTER_RESEARCH, { research: UNAVAILABLE_RESEARCH })).toEqual([...AFTER_RESEARCH]);
  });

  it("does not fire for partial, not_needed or supported evidence", () => {
    for (const evidenceStatus of ["partial", "not_needed", "supported"]) {
      expect(skipped(AFTER_RESEARCH, { research: { ...SUPPORTED_RESEARCH, evidenceStatus } })).toEqual([]);
    }
  });

  it("does not fire when research itself was skipped — that is a decision it was not needed", () => {
    expect(skipped(AFTER_RESEARCH, {})).toEqual([]);
  });
});

describe("the halt reaches the publication decision (B4)", () => {
  const stageOutputs = [
    { nodeId: "research", output: SUPPORTED_RESEARCH },
    { nodeId: "draft_writer", output: BLOCKED_DRAFT }
  ];

  it("decides blocked, with the writer's blockers, without a readiness checklist or a model call", () => {
    const halt = readContentHalt(Object.fromEntries(stageOutputs.map((entry) => [entry.nodeId, entry.output])))!;
    expect(halt.cause).toBe("draft_blocked");

    const decision = buildContentHaltDecision({ halt, clientProjectId: "seniorpets", contentClass: "client_property", upstreamBlockers: collectSourcedBlockers(stageOutputs) });

    expect(decision.decision).toBe("blocked");
    expect(decision.state).toBe("blocked_for_publish_execution");
    expect(decision.artifact).toBe("publication_decision.v1");
    // Every one of the writer's four reasons is on the decision, once.
    for (const blocker of BLOCKED_DRAFT.blockers) expect(decision.blockers.join(" | ")).toContain(blocker);
    expect(decision.blockers.filter((line) => line.includes(BLOCKED_DRAFT.blockers[0]))).toHaveLength(1);
    expect(decision.nextAction).toContain("retry from draft_writer");
    expect(decision.notes.join(" ")).toContain("No model call");
  });

  it("names research as the cause when both fired — the earlier one is the actionable one", () => {
    const halt = readContentHalt({ research: UNAVAILABLE_RESEARCH, draft_writer: BLOCKED_DRAFT })!;
    expect(halt.cause).toBe("research_unavailable");
    expect(buildContentHaltDecision({ halt, clientProjectId: "seniorpets", contentClass: "client_property", upstreamBlockers: [] }).nextAction).toContain("retry from research");
  });

  it("reads no halt from a healthy run", () => {
    expect(readContentHalt({ research: SUPPORTED_RESEARCH, draft_writer: READY_DRAFT })).toBeUndefined();
    expect(readContentHalt(undefined)).toBeUndefined();
  });

  it("can only ever refuse — there is no input to this path that yields a publishable decision", () => {
    for (const contentClass of ["own_property", "client_property", "docs", "money"]) {
      const halt = readContentHalt({ draft_writer: BLOCKED_DRAFT })!;
      expect(buildContentHaltDecision({ halt, clientProjectId: "p", contentClass, upstreamBlockers: [] }).decision).toBe("blocked");
    }
  });
});
