import { describe, expect, it } from "vitest";
import { buildDtcPublishingNodeCorrection } from "../../../scripts/dtcPublishingNodeCorrections.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { buildPublicationDecision, collectSourcedBlockers, partitionBlockers } from "../../../src/agent/workspace/publicationController.js";

const byId = (id: string) => structuredClone(listWorkspaceNodes().find(n => n.id === id)!);
const corrected = (id: string) => { const node = byId(id); return { ...node, ...buildDtcPublishingNodeCorrection(node) }; };
const envelope = (id: string) => ({ artifact: (byId(id).outputSchema as any).properties.artifact.const, summary: "CMS-Agent offline test." });
const refusal = (id: string) => ({ ...envelope(id), blockers: ["trust_factual: Required evidence is unavailable."], advisories: [], ...(id === "research" ? { evidenceStatus: "unavailable", sources: [], findings: [] } : id === "draft_writer" ? { draftStatus: "blocked", proposedTitle: "Pending evidence", draftSections: [], sourceClaimNotes: [], nextStep: { action: "Await evidence", destination: null, rationale: "Source unavailable" } } : id === "trust_factual" ? { verdict: "blocked", coverageNote: "Draft cannot be verified without required evidence.", claimReviews: [] } : { reviewStatus: "blocked", revisions: [], unresolvedConflicts: [], buildInstructions: [] }) });

describe("CMS-Agent DTC additive node corrections", () => {
  it.each(["research", "draft_writer", "trust_factual", "review_aggregator"])("%s rejects a summary-only handoff but permits an explicit blocked result", (id) => {
    const schema = corrected(id).outputSchema;
    expect(validateOutput({ ...envelope(id), notes: ["BLOCKER: missing evidence"] }, schema).ok).toBe(false);
    expect(validateOutput(refusal(id), schema).ok).toBe(true);
    expect(validateOutput({ ...refusal(id), blockers: [] }, schema).ok).toBe(false);
  });

  it("requires actual reader copy before a draft may report ready", () => {
    const schema = corrected("draft_writer").outputSchema;
    const ready = { ...refusal("draft_writer"), draftStatus: "ready", blockers: [] };
    expect(validateOutput(ready, schema).ok).toBe(false);
    expect(validateOutput({ ...ready, draftSections: [{ sectionId: "opening", heading: "A useful next step", readerVisibleCopy: "" }] }, schema).ok).toBe(false);
    expect(validateOutput({ ...ready, draftSections: [{ sectionId: "opening", heading: "A useful next step", readerVisibleCopy: "Compare your current routine with the supplied checklist." }] }, schema).ok).toBe(true);
  });

  it("does not accept a pass verdict with an unverified or removed factual claim", () => {
    const schema = corrected("trust_factual").outputSchema;
    const claim = { claimId: "c1", claim: "Material claim", decision: "unverified", evidenceReferences: [], reason: "No source", revision: null };
    const review = { ...refusal("trust_factual"), verdict: "pass", blockers: [], claimReviews: [claim] };
    expect(validateOutput(review, schema).ok).toBe(false);
    expect(validateOutput({ ...review, claimReviews: [{ ...claim, decision: "remove" }] }, schema).ok).toBe(false);
    expect(validateOutput({ ...review, claimReviews: [{ ...claim, decision: "keep", evidenceReferences: ["supplied-input:c1"], reason: "Attributed to supplied input" }] }, schema).ok).toBe(true);
  });

  it("requires usable source and finding records when research claims evidence exists", () => {
    const schema = corrected("research").outputSchema;
    const output = { ...refusal("research"), evidenceStatus: "supported", blockers: [] };
    expect(validateOutput(output, schema).ok).toBe(false);
    expect(validateOutput({ ...output, sources: [{ sourceId: "s1", reference: "supplied-input:brief", sourceType: "supplied", relevance: "Operator-provided facts" }], findings: [{ claimId: "c1", claim: "Supplied statement", status: "supported", sourceIds: ["s1"], limitations: "Attributed; not independently verified." }] }, schema).ok).toBe(true);
  });

  it.each(["research", "draft_writer", "trust_factual", "review_aggregator", "article_body", "topic_opportunity"])("%s preserves existing node policy and is idempotent", (id) => {
    const node = byId(id); node.prompt += "\nPreserve CMS-Agent operator-specific instructions.";
    node.metadata = { ...node.metadata, operatorNote: "preserve" };
    const before = structuredClone(node); const patch = buildDtcPublishingNodeCorrection(node)!;
    const after = { ...node, ...patch };
    expect(node).toEqual(before);
    for (const key of Object.keys(node).filter(key => !["prompt", "schema", "outputSchema"].includes(key))) expect((after as any)[key]).toEqual((before as any)[key]);
    expect(after.prompt).toContain("Preserve CMS-Agent operator-specific instructions.");
    expect(buildDtcPublishingNodeCorrection(after)).toBeUndefined();
  });

  it("refuses to replace an existing conflicting field contract", () => {
    const node = byId("research"); (node.outputSchema as any).properties.evidenceStatus = { const: "operator-specific" };
    expect(() => buildDtcPublishingNodeCorrection(node)).toThrow(/live field evidenceStatus/);
    expect(buildDtcPublishingNodeCorrection(byId("release_executor"))).toBeUndefined();
  });

  it("points article_body at verified materialized media and describes topic routing honestly", () => {
    expect(corrected("article_body").prompt).not.toMatch(/\bartifact_plan\b/);
    expect(corrected("article_body").prompt).toContain("artifact_materializer");
    expect(corrected("topic_opportunity").prompt).toContain("does not change the conductor graph or stop a run");
  });
});

describe("CMS-Agent blocker provenance survives deduplication", () => {
  const block = "Unsupported material claim";
  const entries = (ids: string[]) => ids.map(nodeId => ({ nodeId, output: { blockers: [block] } }));
  it.each([["draft_writer", "trust_factual"], ["trust_factual", "draft_writer"]])("retains the factual hard source when %s precedes %s", (...ids) => {
    const collected = collectSourcedBlockers(entries(ids));
    expect(collected).toHaveLength(1);
    const part = partitionBlockers(collected, "client_property");
    expect(part.blocking).toEqual([expect.objectContaining({ nodeId: "trust_factual", sourceNodeIds: ids })]);
    expect(part.advisory).toEqual([]);
    const decision = buildPublicationDecision({ clientProjectId: "cms-agent-test", contentClass: "client_property", readiness: { status: "go", blockers: [], checklist: [] } as any, upstreamBlockers: collected });
    expect(decision.decision).toBe("blocked"); expect(decision.blockers).toHaveLength(1);
    expect(decision.notes.join("\n")).toContain(`Deduplicated blocker sources: ${ids.join(", ")}`);
  });
  it("honors project promotion and unknown-source integrity after deduplication", () => {
    const collected = collectSourcedBlockers(entries(["draft_writer", "review_aggregator"]));
    expect(partitionBlockers(collected, "client_property").advisory).toHaveLength(1);
    expect(partitionBlockers(collected, "client_property", ["review_aggregator"]).blocking[0].nodeId).toBe("review_aggregator");
    expect(partitionBlockers(collectSourcedBlockers(entries(["draft_writer", "new_integrity_source"])), "client_property").blocking[0].nodeId).toBe("new_integrity_source");
  });
  it("retains sources from prefixed echoes without increasing count or duplicating the same source", () => {
    const collected = collectSourcedBlockers([
      { nodeId: "draft_writer", output: { blockers: [block, block] } },
      { nodeId: "trust_factual", output: { blockers: [`trust_factual: ${block}`] } },
      { nodeId: "review_aggregator", output: { blockers: [`trust_factual: ${block}`] } }
    ]);
    expect(collected).toEqual([{ nodeId: "draft_writer", blocker: block, sourceNodeIds: ["draft_writer", "trust_factual", "review_aggregator"] }]);
    expect(partitionBlockers(collected, "client_property").blocking).toHaveLength(1);
  });
  it("preserves the existing own-property waiver and its full source trail", () => {
    const collected = collectSourcedBlockers(entries(["draft_writer", "trust_factual"]).map(e => ({ ...e, output: { blockers: ["ev_floor: unmet"] } })));
    const part = partitionBlockers(collected, "own_property");
    expect(part.blocking).toEqual([]);
    expect(part.waived[0]).toMatchObject({ sourceNodeIds: ["draft_writer", "trust_factual"], rule: "own_property_ev_and_aggression_exemption" });
  });
});
