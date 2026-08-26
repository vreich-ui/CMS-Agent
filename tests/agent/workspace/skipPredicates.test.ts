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
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
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
  // T8 (Wave 3, 2026-08-13, run_1786557897658_elj34j): artifact_plan's dependsOn moved from
  // [article_body] to [brief_architect, contract_intelligence] — the topology fix that lets
  // artifact_plan generate and verify media BEFORE article_body builds the body that would reference
  // it (run_1786557897658_elj34j published with zero media because artifact_plan used to run AFTER
  // article_body and had nothing left to plan against). carriersFor reads context.dependsOn, so once
  // brief_architect is a declared dependency it becomes a carrier automatically — nothing in
  // carriersFor itself needed to change. brief_architect's mediaSlots is now the primary signal.
  const node = () => nodeFor("artifact_plan");

  it("brief_architect is a carrier this predicate consults (declared via artifact_plan's own dependsOn, not a special case in carriersFor)", () => {
    expect(node().dependsOn).toContain("brief_architect");
  });

  it("skips when brief_architect declares mediaSlots: [] — the envelope asked for no media", () => {
    const verdict = evaluateNodeSkip(node(), { stageOutputs: { brief_architect: { artifact: "article_brief.v1", mediaSlots: [] } } })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toContain("mediaSlots: empty");
  });

  it("runs when brief_architect declares a populated mediaSlots array — there is media to plan", () => {
    const verdict = evaluateNodeSkip(node(), { stageOutputs: { brief_architect: { artifact: "article_brief.v1", mediaSlots: [{ slotId: "hero", purpose: "hero image", desiredKind: "photo", placement: "top" }] } } })!;
    expect(verdict.skip).toBe(false);
    expect(verdict.basis).toContain("mediaSlots: non-empty");
  });

  it("honours an explicit media declaration on the run's own initial input ahead of brief_architect's", () => {
    expect(evaluateNodeSkip(node(), { initialInput: { mediaSlots: [] } })!.skip).toBe(true);
    expect(evaluateNodeSkip(node(), { initialInput: { mediaSlots: ["hero"] }, stageOutputs: { brief_architect: { mediaSlots: [] } } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { initialInput: { noMedia: true } })!.skip).toBe(true);
  });

  it("falls back to a structural scan of a client-object-shaped carrier when nothing declares presence — the generic fallback the predicate function still supports for any future carrier", () => {
    const clientObjectCarrier = { artifact: "client_object.v1", body: { nodes: [{ public: { text: "a" } }, { public: {} }] } };
    const verdict = evaluateNodeSkip(node(), { stageOutputs: { contract_intelligence: clientObjectCarrier } })!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toContain("client object: 2 node(s), 0 carrying media");
  });

  it("runs when there is nothing scannable, and never treats a mock placeholder as proof of absence", () => {
    expect(evaluateNodeSkip(node(), {})!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { stageOutputs: { brief_architect: { dryRun: true, mediaSlots: [] } } })!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), { stageOutputs: { brief_architect: { artifact: "article_brief.v1", summary: "no mediaSlots key" } } })!.skip).toBe(false);
  });
});

describe("clone_no_actionable_mismatches — recipe_designer's gate (T13.2 Defect C)", () => {
  // The live clone run (run_1787508397978_8fyyst) warned
  // `skip_predicate_unrecognized:clone_no_actionable_mismatches` and ran recipe_designer anyway —
  // safe degradation, correct default, dangling reference. The node as clone_conductor declares it,
  // so the test reads the SAME metadata the executor gates on rather than a hand-built stand-in.
  const node = () => {
    const designer = listCloneConductorNodes().find((candidate) => candidate.id === "recipe_designer")!;
    return { id: designer.id, dependsOn: designer.dependsOn, metadata: designer.metadata };
  };

  const analysis = (...kinds: string[]) => ({
    stageOutputs: {
      layout_analyst: {
        artifact: "clone_layout_analysis.v1",
        mismatches: kinds.map((missingRecipeKind, index) => ({ pageRef: `page-${index}`, missingRecipeKind, rationale: "x" }))
      }
    }
  });

  it("declares the predicate the engine now recognizes — no unrecognized-rule warning", () => {
    expect(node().metadata?.skipWhen).toEqual([{ when: "clone_no_actionable_mismatches" }]);
    expect(readSkipPredicates(node().metadata).warnings).toEqual([]);
    expect(node().dependsOn).toContain("layout_analyst");
  });

  it("skips when every mismatch is \"none\": the analyst's honest answer that NO recipe closes them is evidence against the designer, not for it", () => {
    const verdict = evaluateNodeSkip(node(), analysis("none", "none", "none"))!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toEqual(["mismatches: 3", "actionable (section_template|template): 0"]);
    expect(verdict.reason).toMatch(/no recipe to design/);
  });

  it("skips when the mismatch ledger is empty — the emitted structure already tracks the source", () => {
    const verdict = evaluateNodeSkip(node(), analysis())!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toEqual(["mismatches: 0", "actionable (section_template|template): 0"]);
  });

  it("RUNS when at least one mismatch is section_template or template, however many \"none\" surround it", () => {
    const sectionTemplate = evaluateNodeSkip(node(), analysis("none", "section_template", "none"))!;
    expect(sectionTemplate.skip).toBe(false);
    expect(sectionTemplate.basis).toEqual(["mismatches: 3", "actionable (section_template|template): 1"]);
    expect(evaluateNodeSkip(node(), analysis("template"))!.skip).toBe(false);
    expect(evaluateNodeSkip(node(), analysis("section_template", "template"))!.basis).toContain("actionable (section_template|template): 2");
  });

  it("RUNS when the analyst envelope is absent or unreadable, and never reads a mock placeholder as proof there is nothing to design", () => {
    const absent = evaluateNodeSkip(node(), {})!;
    expect(absent.skip).toBe(false);
    expect(absent.basis).toContain("no layout-analysis mismatch ledger declared on any upstream envelope");
    expect(evaluateNodeSkip(node(), { stageOutputs: { layout_analyst: { artifact: "clone_layout_analysis.v1", summary: "no mismatches key" } } })!.skip).toBe(false);
    const placeholder = evaluateNodeSkip(node(), { stageOutputs: { layout_analyst: { dryRun: true, mismatches: [] } } })!;
    expect(placeholder.skip).toBe(false);
    expect(placeholder.basis).toContain("carrier: mock placeholder (dryRun) — not evidence");
  });
});

describe("clone_demand_driven_entry — layout_analyst's gate (T15.30/#206; ADR-2026-08-25-structure-studio §3)", () => {
  // The node as clone_conductor declares it, so the test reads the SAME metadata the executor gates
  // on — the same discipline the clone_no_actionable_mismatches suite above uses for recipe_designer.
  const node = () => {
    const analyst = listCloneConductorNodes().find((candidate) => candidate.id === "layout_analyst")!;
    return { id: analyst.id, dependsOn: analyst.dependsOn, metadata: analyst.metadata };
  };

  const intake = (entryMode?: string) => ({
    stageOutputs: {
      clone_intake: { artifact: "clone_intake.v1", ...(entryMode !== undefined ? { entryMode } : {}) }
    }
  });

  it("declares the predicate the engine now recognizes — no unrecognized-rule warning", () => {
    expect(node().metadata?.skipWhen).toEqual([{ when: "clone_demand_driven_entry" }]);
    expect(readSkipPredicates(node().metadata).warnings).toEqual([]);
    expect(node().dependsOn).toContain("clone_intake");
  });

  it("skips when clone_intake declares entryMode \"demand\" — no capture snapshot exists to diff", () => {
    const verdict = evaluateNodeSkip(node(), intake("demand"))!;
    expect(verdict.skip).toBe(true);
    expect(verdict.basis).toEqual(["entryMode: demand"]);
    expect(verdict.reason).toMatch(/no capture snapshot/);
  });

  it("RUNS when clone_intake declares entryMode \"clone\" — the ordinary capture-derived path", () => {
    const verdict = evaluateNodeSkip(node(), intake("clone"))!;
    expect(verdict.skip).toBe(false);
    expect(verdict.basis).toEqual(["entryMode: clone"]);
  });

  it("RUNS when entryMode is absent or unreadable (an older envelope shape), and never reads a mock placeholder as proof", () => {
    const absent = evaluateNodeSkip(node(), {})!;
    expect(absent.skip).toBe(false);
    expect(absent.basis).toContain("no entryMode declared on any upstream envelope");
    expect(evaluateNodeSkip(node(), intake(undefined))!.skip).toBe(false);
    const placeholder = evaluateNodeSkip(node(), { stageOutputs: { clone_intake: { dryRun: true, entryMode: "demand" } } })!;
    expect(placeholder.skip).toBe(false);
    expect(placeholder.basis).toContain("carrier: mock placeholder (dryRun) — not evidence");
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
