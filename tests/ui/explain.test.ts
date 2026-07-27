import { describe, expect, it } from "vitest";
import { toolDenialReasons } from "../../src/agent/tools/toolTypes.js";
import { executionStatuses } from "../../src/agent/workspace/executionTypes.js";
import { workspaceActorKinds } from "../../src/agent/workspace/changeTypes.js";
import {
  defineTerm,
  explainDenialReason,
  explainDenialReasons,
  UNKNOWN_TOOL_REASON,
  vocabularies,
  vocabulary,
  vocabularyList
} from "../../ui/src/explain.js";

// The registry's whole value is that it cannot fall behind the vocabularies the backend actually
// emits. These are the tests that enforce that, in both directions — a definition with no code is
// just as much a defect as a code with no definition, because it means the UI is explaining something
// the engine no longer does.
describe("vocabulary registry — correspondence with the backend", () => {
  it("defines every tool denial reason the resolver can emit, and no others", () => {
    const defined = vocabulary("denial").terms.map((term) => term.term).sort();
    expect(defined).toEqual([...toolDenialReasons].sort());
  });

  it("defines every execution status", () => {
    const defined = vocabulary("execution").terms.map((term) => term.term).sort();
    expect(defined).toEqual([...executionStatuses].sort());
  });

  it("defines every workspace actor kind", () => {
    const defined = vocabulary("actor").terms.map((term) => term.term).sort();
    expect(defined).toEqual([...workspaceActorKinds].sort());
  });

  it("defines the four risk rungs in ladder order", () => {
    // Order is meaningful here: it is the ceiling comparison in evaluateToolPolicy's riskRank.
    expect(vocabulary("risk").terms.map((term) => term.term)).toEqual(["read", "write", "publish", "admin"]);
  });

  it("defines the three permission states", () => {
    expect(vocabulary("permission").terms.map((term) => term.term).sort()).toEqual(["allowed", "blocked", "needs_approval"]);
  });
});

describe("vocabulary registry — content quality", () => {
  it("gives every term a raw code, a human label, and a real sentence", () => {
    for (const vocab of vocabularyList()) {
      expect(vocab.title.length, `${vocab.id} title`).toBeGreaterThan(0);
      expect(vocab.blurb.length, `${vocab.id} blurb`).toBeGreaterThan(0);
      expect(vocab.terms.length, `${vocab.id} terms`).toBeGreaterThan(0);
      for (const term of vocab.terms) {
        expect(term.term, `${vocab.id}.${term.term} code`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(term.label.length, `${vocab.id}.${term.term} label`).toBeGreaterThan(0);
        // A one-word "definition" is the failure mode this registry exists to prevent.
        expect(term.summary.split(/\s+/).length, `${vocab.id}.${term.term} summary`).toBeGreaterThan(5);
        expect(term.summary.trim().endsWith("."), `${vocab.id}.${term.term} summary punctuation`).toBe(true);
      }
    }
  });

  // Deliberately NOT tested: "the label must differ from the de-underscored code". That rule was
  // written first and caught exactly one real defect (`tool_disabled`, whose label was the circular
  // "Tool disabled" and is now "Switched off in the registry"). But it then flagged
  // `approval_required` and `needs_approval`, where the de-underscored form IS the product's
  // established term — it appears verbatim in the Access page copy and in permissionMeta, so
  // diverging would have been the inconsistency. Label informativeness is a judgement, not a
  // predicate; a rule that needs a growing exemption list teaches people to add exemptions instead
  // of thinking. The fix it found was kept and the rule was dropped.
  it("gives every term in a vocabulary a distinct label", () => {
    // Mechanical and meaningful: duplicate labels mean a copy-paste that leaves two codes
    // indistinguishable to the reader, which is the actual failure this file guards against.
    for (const vocab of vocabularyList()) {
      const labels = vocab.terms.map((term) => term.label);
      expect(new Set(labels).size, `${vocab.id} labels`).toBe(labels.length);
    }
  });

  it("every failure or refusal a human can act on carries a remedy", () => {
    // Denial reasons that name a config the operator controls, and the two recoverable run states.
    const mustHaveRemedy = [
      ["denial", "node_tool_not_allowed"],
      ["denial", "skill_tool_not_allowed"],
      ["denial", "risk_level_exceeds_authorization"],
      ["denial", "approval_required"],
      ["denial", "project_has_no_allowed_tools"],
      ["execution", "blocked"],
      ["execution", "failed"]
    ] as const;
    for (const [vocabId, term] of mustHaveRemedy) {
      expect(defineTerm(vocabId, term)?.remedy, `${vocabId}.${term}`).toBeTruthy();
    }
  });

  it("explains that a resolved view always reports approval_required, so it is not read as a fault", () => {
    // Wave 2's Tier-2 finding: effective resolution carries no approval context, so every
    // approval-gated tool reads denied there. Operators chased this before it was written down.
    expect(defineTerm("denial", "approval_required")?.summary).toMatch(/resolved view carries no approval context/i);
  });

  it("states the risk ceiling relationship, which appears nowhere else in the product", () => {
    expect(vocabulary("risk").blurb).toMatch(/ceiling/i);
  });

  it("distinguishes blocked from failed as a safety hold rather than an error", () => {
    expect(defineTerm("execution", "blocked")?.summary).toMatch(/safety hold, not an error/i);
  });
});

describe("denial reason lookup", () => {
  it("translates a known code", () => {
    expect(explainDenialReason("risk_level_exceeds_authorization")?.label).toBe("Above the node's risk ceiling");
  });

  it("translates the UI-synthesized unknown-tool reason, which the resolver never emits", () => {
    expect(explainDenialReason("tool_not_in_registry")).toBe(UNKNOWN_TOOL_REASON);
    // Deliberately absent from the denial vocabulary so the backend correspondence test stays exact.
    expect(defineTerm("denial", "tool_not_in_registry")).toBeNull();
  });

  it("returns null for an unrecognized code rather than inventing a definition", () => {
    expect(explainDenialReason("some_new_reason_from_the_future")).toBeNull();
  });

  it("preserves resolver order, so the first reason is the one to act on", () => {
    const explained = explainDenialReasons(["node_tool_not_allowed", "approval_required"]);
    expect(explained.map((entry) => entry.code)).toEqual(["node_tool_not_allowed", "approval_required"]);
    expect(explained[0].term?.label).toBe("Not granted to this node");
  });

  it("pairs an unknown code with a null term so the caller can fall back to the raw string", () => {
    const explained = explainDenialReasons(["mystery_code"]);
    expect(explained).toEqual([{ code: "mystery_code", term: null }]);
  });

  it("has no duplicate codes within a vocabulary", () => {
    for (const vocab of Object.values(vocabularies)) {
      const codes = vocab.terms.map((term) => term.term);
      expect(new Set(codes).size, vocab.id).toBe(codes.length);
    }
  });
});
