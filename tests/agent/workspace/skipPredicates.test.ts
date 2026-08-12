import { describe, expect, it } from "vitest";
import {
  DOCS_CONTENT_CLASSES,
  MONEY_CONTENT_CLASSES,
  REVIEW_QUARTET,
  REVIEW_TIER_MEMBERS,
  evaluateNodeSkip,
  readSkipPredicates,
  renderSkippedDependencyPolicy,
  resolveReviewTier
} from "../../../src/agent/workspace/skipPredicates.js";
import { NODE_GATING_SEED, declaresContractPrefetch, gatedMetadata } from "../../../src/agent/workspace/nodeGatingSeed.js";
import { getWorkspaceNode, listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { readContentClass, readDeclaredContentClass } from "../../../src/agent/workspace/publicationController.js";

// W4 (determinism program, 2026-08-12). Skip predicates are DATA in node metadata whose meaning lives
// in engine code. Two properties are load-bearing and are tested first because everything else
// depends on them: an unrecognized or malformed predicate is INERT (it never skips), and an
// uncertain predicate RUNS the node. The cost of a wrong run is $0.06; the cost of a wrong skip is an
// article no reviewer saw.

// The node as the conductor gates it: its own metadata, with the seeded policy filled in where it
// declares none (nodeGatingSeed.ts). Tests read the same merge the executor does.
const nodeFor = (id: string) => {
  const node = getWorkspaceNode(id)!;
  return { id: node.id, dependsOn: node.dependsOn, metadata: node.metadata };
};

describe("predicate parsing — the store says WHICH rule, never what a rule means", () => {
  it("accepts a single predicate or an array of them", () => {
    expect(readSkipPredicates({ skipWhen: { when: "no_media_slots" } }).predicates).toEqual([{ when: "no_media_slots" }]);
    expect(readSkipPredicates({ skipWhen: [{ when: "no_media_slots" }, { when: "no_external_claims" }] }).predicates).toHaveLength(2);
    expect(readSkipPredicates({ approvalRequired: false }).predicates).toEqual([]);
    expect(readSkipPredicates(undefined).warnings).toEqual([]);
  });

  it("treats an unrecognized rule name as inert, and says so", () => {
    const parsed = readSkipPredicates({ skipWhen: [{ when: "rm_minus_rf" }, { when: "no_media_slots" }] });
    expect(parsed.predicates).toEqual([{ when: "no_media_slots" }]);
    expect(parsed.warnings).toEqual(["skip_predicate_unrecognized:rm_minus_rf"]);
  });

  it("rejects a malformed predicate rather than guessing what it meant", () => {
    const parsed = readSkipPredicates({ skipWhen: ["no_media_slots", { when: "content_class_in" }, { when: "content_class_in", classes: [] }] });
    expect(parsed.predicates).toEqual([]);
    expect(parsed.warnings).toEqual([
      "skip_predicate_malformed:not_a_predicate_object",
      "skip_predicate_malformed:content_class_in_requires_classes",
      "skip_predicate_malformed:content_class_in_requires_classes"
    ]);
  });

  it("returns undefined for a node with no skip policy at all, so 'no policy' is distinguishable from 'policy said run'", () => {
    expect(evaluateNodeSkip({ id: "draft_writer", metadata: { approvalRequired: false } }, {})).toBeUndefined();
    expect(evaluateNodeSkip({ id: "x", metadata: { skipWhen: [{ when: "nope" }] } }, {})?.skip).toBe(false);
  });
});

describe("content_class_in — monetization_strategy's exemption, on the waiver's own signal", () => {
  const node = () => nodeFor("monetization_strategy");

  it("skips own-property content: the EV floor it would compute is waived by standing ruling", () => {
    const verdict = evaluateNodeSkip(node(), { initialInput: { contentClass: "own_property", topic: "x" } })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.predicate).toMatchObject({ when: "content_class_in" });
    expect(verdict.basis).toContain("contentClass: own_property");
  });

  it("accepts the same spellings the waiver accepts — one signal, not two", () => {
    expect(evaluateNodeSkip(node(), { initialInput: { ownProperty: true } })!.skip).toBe(true);
    expect(evaluateNodeSkip(node(), { initialInput: { content_class: "own-property" } })!.skip).toBe(true);
    expect(evaluateNodeSkip(node(), { initialInput: { contentSource: { contentClass: "runbook" } } })!.skip).toBe(true);
    // ...and the identical reading is what the EV/aggression waiver itself does.
    expect(readContentClass({ ownProperty: true })).toBe("own_property");
    expect(readDeclaredContentClass({ ownProperty: true })).toBe("own_property");
  });

  it("runs for client-property content, and for a run that declares no class at all", () => {
    expect(evaluateNodeSkip(node(), { initialInput: { contentClass: "client_property" } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { initialInput: { topic: "no class here" } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), {})!.basis).toContain("contentClass: not declared");
  });

  it("keys on DECLARED class only: readContentClass's client_property default must never satisfy a skip", () => {
    // readContentClass answers "which class is in force" (defaulted); readDeclaredContentClass answers
    // "did anyone say". A predicate reading the first would gate on a default nobody declared.
    expect(readContentClass({})).toBe("client_property");
    expect(readDeclaredContentClass({})).toBeUndefined();
  });
});

describe("no_external_claims — research's trigger ($0.06 to conclude there was nothing to do)", () => {
  const node = () => nodeFor("research");

  it("runs when anything declares external claims", () => {
    expect(evaluateNodeSkip(node(), { initialInput: { externalClaims: true } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { initialInput: { externalClaims: ["FDA approval date"] } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { initialInput: { requiresResearch: true, contentClass: "docs" } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { stageOutputs: { input_triage: { external_claims: 2 } } })!.skip).toBe(false);
  });

  it("skips on an explicit claim-free declaration, whatever the content class", () => {
    const verdict = evaluateNodeSkip(node(), { initialInput: { externalClaims: false } })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toContain("externalClaims: false");
    expect(evaluateNodeSkip(node(), { initialInput: { externalClaims: [] } })!.skip).toBe(true);
  });

  it("falls back to content class — docs-class content skips research — and documents it in the basis", () => {
    const verdict = evaluateNodeSkip(node(), { initialInput: { contentClass: "runbook" } })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toContain("contentClass: runbook");
    expect(verdict.reason).toMatch(/docs\/runbook class/);
  });

  it("RUNS an unclassified run: an unanswered question is answered by researching", () => {
    expect(evaluateNodeSkip(node(), { initialInput: { topic: "semaglutide side effects" } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { initialInput: { contentClass: "money" } })!.skip).toBe(false);
  });

  it("never reads a mock placeholder as evidence that nothing is claimed", () => {
    expect(evaluateNodeSkip(node(), { stageOutputs: { input_triage: { dryRun: true, externalClaims: false } } })!.skip).toBe(false);
  });
});

describe("no_media_slots — artifact_plan's own zero-media rule, moved pre-dispatch", () => {
  const node = () => nodeFor("artifact_plan");
  const body = (nodes: unknown[]) => ({ artifact: "client_object.v1", body: { nodes } });

  it("skips when the client object it would plan for carries no media reference at all", () => {
    const verdict = evaluateNodeSkip(node(), { stageOutputs: { article_body: body([{ public: { text: "a" } }, { public: {} }]) } })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toContain("client object: 2 node(s), 0 carrying media");
  });

  it("runs when any node carries media — the artifacts are what it plans", () => {
    const verdict = evaluateNodeSkip(node(), { stageOutputs: { article_body: body([{ public: { media: { src: "images/x/y.png" } } }]) } })!;
    expect(verdict.skip).toBe(false);
  });

  it("honours an explicit media declaration ahead of the structural scan", () => {
    expect(evaluateNodeSkip(node(), { initialInput: { mediaSlots: [] } })!.skip).toBe(true);
    expect(evaluateNodeSkip(node(), { initialInput: { mediaSlots: ["hero"] }, stageOutputs: { article_body: body([]) } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { initialInput: { noMedia: true } })!.skip).toBe(true);
  });

  it("runs when there is nothing scannable, and never treats a mock placeholder as proof of absence", () => {
    expect(evaluateNodeSkip(node(), {})!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { stageOutputs: { article_body: { dryRun: true, body: { nodes: [] } } } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { stageOutputs: { article_body: { artifact: "client_object.v1", summary: "no body key" } } })!.skip).toBe(false);
  });
});

describe("review quartet tiering — operator policy (Wolf, 2026-08-12), three tiers", () => {
  it("resolves the tier from the run's declared content class", () => {
    expect(resolveReviewTier("docs").tier).toBe("docs");
    expect(resolveReviewTier("runbook").reviewers).toEqual(["trust_factual"]);
    expect(resolveReviewTier("standard").reviewers).toEqual(["trust_factual", "human_texture", "reader_simulation"]);
    expect(resolveReviewTier("client_property").tier).toBe("standard");
    expect(resolveReviewTier("money").reviewers).toEqual([...REVIEW_QUARTET]);
    expect(resolveReviewTier("affiliate").tier).toBe("full");
  });

  it("FAIL-SAFE: an absent or unrecognized class runs all four", () => {
    expect(resolveReviewTier(undefined).reviewers).toEqual([...REVIEW_QUARTET]);
    expect(resolveReviewTier(undefined).basis).toMatch(/fail-safe/);
    expect(resolveReviewTier("own_property").reviewers).toEqual([...REVIEW_QUARTET]);
    expect(resolveReviewTier("some_new_class_nobody_taught_this").tier).toBe("full");
  });

  // The matrix, stated once: for every content class, exactly which of the four nodes the conductor
  // dispatches. This is the operator policy in executable form.
  const matrix: Array<{ contentClass: string | undefined; runs: string[] }> = [
    { contentClass: "docs", runs: ["trust_factual"] },
    { contentClass: "runbook", runs: ["trust_factual"] },
    { contentClass: "standard", runs: ["trust_factual", "human_texture", "reader_simulation"] },
    { contentClass: "client_property", runs: ["trust_factual", "human_texture", "reader_simulation"] },
    { contentClass: "money", runs: [...REVIEW_QUARTET] },
    { contentClass: "affiliate", runs: [...REVIEW_QUARTET] },
    { contentClass: undefined, runs: [...REVIEW_QUARTET] },
    { contentClass: "not_a_class", runs: [...REVIEW_QUARTET] }
  ];

  for (const row of matrix) {
    it(`${row.contentClass ?? "(no class declared)"} → ${row.runs.length} reviewer(s): ${row.runs.join(", ")}`, () => {
      const initialInput = row.contentClass === undefined ? { topic: "x" } : { contentClass: row.contentClass };
      const ran = REVIEW_QUARTET.filter((reviewer) => {
        const verdict = evaluateNodeSkip(nodeFor(reviewer), { initialInput });
        // trust_factual declares no skip policy at all — it runs on every tier by construction.
        return verdict === undefined || !verdict.skip;
      });
      expect([...ran].sort()).toEqual([...row.runs].sort());
    });
  }

  it("trust_factual carries no skip predicate at all: the one reviewer that can never be tiered out", () => {
    expect(NODE_GATING_SEED.trust_factual).toBeUndefined();
    expect(gatedMetadata({ id: "trust_factual", metadata: { approvalRequired: false } })?.skipWhen).toBeUndefined();
    expect(REVIEW_TIER_MEMBERS.docs).toEqual(["trust_factual"]);
  });

  it("names the reviewer explicitly when the predicate does, so a clone keeps the policy it was cloned with", () => {
    const verdict = evaluateNodeSkip({ id: "human_texture_v2", metadata: { skipWhen: [{ when: "review_tier_excludes", reviewer: "human_texture" }] } }, { initialInput: { contentClass: "docs" } })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toMatch(/^human_texture skipped/);
  });
});

describe("the gating seed carries the policy, and the store outranks it", () => {
  it("gates exactly the nodes W4 names, and nothing else", () => {
    const gated = listWorkspaceNodes().filter((node) => gatedMetadata(node)?.skipWhen !== undefined).map((node) => node.id).sort();
    expect(gated).toEqual(["artifact_plan", "emotional_resonance", "human_texture", "monetization_strategy", "reader_simulation", "research"]);
    // Every seeded node is a real conductor node — a typo in an id would seed a policy onto nothing.
    const ids = new Set(listWorkspaceNodes().map((node) => node.id));
    for (const seededId of Object.keys(NODE_GATING_SEED)) expect(ids.has(seededId), `${seededId} is not a conductor node`).toBe(true);
  });

  it("every seeded predicate parses — a typo here would silently disable gating", () => {
    for (const node of listWorkspaceNodes()) {
      const parsed = readSkipPredicates(gatedMetadata(node));
      expect(parsed.warnings, `${node.id} has an unparseable skip predicate`).toEqual([]);
    }
    for (const entry of Object.values(NODE_GATING_SEED)) expect(entry.rationale.length).toBeGreaterThan(20);
  });

  it("a node's OWN metadata always wins — including an empty skipWhen, which is how an operator turns a policy off from the store", () => {
    const off = evaluateNodeSkip({ id: "research", metadata: { skipWhen: [] } }, { initialInput: { contentClass: "docs" } });
    expect(off).toBeUndefined();
    const replaced = evaluateNodeSkip({ id: "research", metadata: { skipWhen: [{ when: "content_class_in", classes: ["money"] }] } }, { initialInput: { contentClass: "docs" } })!;
    expect(replaced.skip).toBe(false);
    // ...and with no metadata of its own, the seeded policy applies.
    expect(evaluateNodeSkip({ id: "research" }, { initialInput: { contentClass: "docs" } })!.skip).toBe(true);
  });

  it("monetization_strategy's exempt classes are the waiver's own vocabulary plus docs class", () => {
    const predicate = (gatedMetadata({ id: "monetization_strategy" })!.skipWhen as Array<{ classes: string[] }>)[0];
    expect(predicate.classes).toContain("own_property");
    for (const docsClass of ["docs", "runbook"]) expect(predicate.classes).toContain(docsClass);
    expect(DOCS_CONTENT_CLASSES).toContain("runbook");
    expect(MONEY_CONTENT_CLASSES).not.toContain("own_property");
  });

  it("brief_architect's contract prefetch is declared, so the ceiling exists before the brief is written", () => {
    expect(declaresContractPrefetch(getWorkspaceNode("brief_architect")!)).toBe(true);
    expect(getWorkspaceNode("brief_architect")!.dependsOn).toContain("placement_resolver");
    // contract_intelligence keeps its own prefetch and its place in the DAG: the tail's declared
    // edges are a hard invariant (publishingTail.ts), so no node was reordered.
    expect(declaresContractPrefetch(getWorkspaceNode("contract_intelligence")!)).toBe(true);
    expect(getWorkspaceNode("contract_intelligence")!.dependsOn).toEqual(["brief_architect"]);
  });
});

describe("the ledger a dependant is handed", () => {
  it("states which inputs are absent, why, and that they are never to be waited for or invented", () => {
    const text = renderSkippedDependencyPolicy([{ nodeId: "human_texture", reason: "docs tier runs trust_factual only" }])!;
    expect(text).toMatch(/deliberately SKIPPED 1/);
    expect(text).toMatch(/human_texture \(docs tier runs trust_factual only\)/);
    expect(text).toMatch(/never wait for, re-request, guess at, or invent/);
    expect(renderSkippedDependencyPolicy([])).toBeUndefined();
  });
});
