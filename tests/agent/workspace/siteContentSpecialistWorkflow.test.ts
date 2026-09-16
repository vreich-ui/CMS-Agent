import { describe, expect, it } from "vitest";
import { getWorkflowDefinition, listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import { SITE_CONTENT_SPECIALISTS_WORKFLOW_ID } from "../../../src/agent/workspace/siteContentSpecialistWorkflow.js";
import {
  listSiteContentSpecialistNodes,
  siteContentSpecialistNodes,
  SITE_CONTENT_SPECIALIST_AI_NODE_IDS
} from "../../../src/agent/workspace/siteContentSpecialistNodes.js";
import { workspaceStoreSeedNodes } from "../../../src/agent/workspace/workspaceStoreNodes.js";
import { workspaceRiskLevels } from "../../../src/agent/workspace/nodeTypes.js";
import { validateAgainstNodeSchema } from "../../../src/agent/workspace/nodeRuntime.js";
import { seededSkillDefinitions } from "../../../src/agent/skills/seededSkills.js";

// C3 — site_content_specialists: five model-driven writer/planner nodes, registered as their own
// workflow (siteContentSpecialistWorkflow.ts's own REVIEW comment explains why), ahead of the C4
// conductor that will dispatch them individually.

const EXPECTED_NODE_IDS = [
  "site_content_planner",
  "organization_narrative_writer",
  "offering_description_writer",
  "reference_content_writer",
  "site_content_reviewer"
];

const EXPECTED_SKILLS: Record<string, string[]> = {
  site_content_planner: ["page_composition"],
  organization_narrative_writer: ["about_organization", "people_profile"],
  offering_description_writer: ["product_service_description", "program_event_description"],
  reference_content_writer: ["faq_help_process", "policy_explanation", "evidence_story"],
  site_content_reviewer: ["focused_revision", "localization"]
};

describe("site_content_specialists — registered in the workflow registry", () => {
  it("is registered under its own id, and its canonical nodes are exactly the five specialist ids", () => {
    expect(listRegisteredWorkflowIds()).toContain(SITE_CONTENT_SPECIALISTS_WORKFLOW_ID);
    expect(SITE_CONTENT_SPECIALISTS_WORKFLOW_ID).toBe("site_content_specialists");
    const definition = getWorkflowDefinition(SITE_CONTENT_SPECIALISTS_WORKFLOW_ID);
    expect(definition).toBeDefined();
    const nodeIds = definition?.canonicalNodes().map((node) => node.id);
    expect(nodeIds).toEqual(EXPECTED_NODE_IDS);
  });

  it("carries all five as AI-judgment nodes (SITE_CONTENT_SPECIALIST_AI_NODE_IDS) — there is no deterministic route in this graph", () => {
    expect([...SITE_CONTENT_SPECIALIST_AI_NODE_IDS].sort()).toEqual([...EXPECTED_NODE_IDS].sort());
  });
});

describe("site_content_specialists' nodes are governance-visible through the shared workspace store union", () => {
  it("all five appear in workspaceStoreSeedNodes with no id collision against the existing set", () => {
    const seed = workspaceStoreSeedNodes();
    const seedIds = seed.map((node) => node.id);
    // No collisions: every specialist id appears in the union exactly once.
    for (const id of EXPECTED_NODE_IDS) {
      expect(seedIds.filter((candidate) => candidate === id)).toHaveLength(1);
    }
    // The union's own de-dup keeps first-seen only, so the store row it dedupes down to must be the
    // specialist's own definition, not any pre-existing same-named row from another source.
    const bySpecialist = new Map(siteContentSpecialistNodes.map((node) => [node.id, node]));
    for (const id of EXPECTED_NODE_IDS) {
      const storeNode = seed.find((node) => node.id === id);
      expect(storeNode?.assignedSkills).toEqual(bySpecialist.get(id)!.assignedSkills);
    }
    // Overall size is additive: every existing source's own count, unchanged, plus these five.
    expect(new Set(seedIds).size).toBe(seedIds.length);
  });
});

describe("assignedSkills pins the roster's crosswalk exactly — this is the test the decision cannot silently drift out from under", () => {
  it.each(EXPECTED_NODE_IDS)("%s carries exactly its crosswalk skills, in order", (nodeId) => {
    const node = siteContentSpecialistNodes.find((candidate) => candidate.id === nodeId)!;
    expect(node).toBeDefined();
    expect(node.assignedSkills).toEqual(EXPECTED_SKILLS[nodeId]);
  });
});

describe("listSiteContentSpecialistNodes — fresh, independently-mutable copies", () => {
  it("mutating a returned node's arrays never corrupts the module-level constant", () => {
    const first = listSiteContentSpecialistNodes();
    const planner = first.find((node) => node.id === "site_content_planner")!;
    planner.dependsOn.push("mutated");
    planner.allowedTools.push("mutated.tool");
    planner.assignedSkills!.push("mutated_skill");
    planner.produces.push("mutated.v1");

    const second = listSiteContentSpecialistNodes();
    const plannerAgain = second.find((node) => node.id === "site_content_planner")!;
    expect(plannerAgain.dependsOn).not.toContain("mutated");
    expect(plannerAgain.allowedTools).not.toContain("mutated.tool");
    expect(plannerAgain.assignedSkills).not.toContain("mutated_skill");
    expect(plannerAgain.produces).not.toContain("mutated.v1");

    // And the raw module-level array itself is untouched too.
    const rawPlanner = siteContentSpecialistNodes.find((node) => node.id === "site_content_planner")!;
    expect(rawPlanner.dependsOn).not.toContain("mutated");
  });

  it("returns a new array reference on every call", () => {
    expect(listSiteContentSpecialistNodes()).not.toBe(listSiteContentSpecialistNodes());
  });
});

describe("every specialist node is independent (dependsOn: []) with a real prompt", () => {
  it.each(EXPECTED_NODE_IDS)("%s has dependsOn: [] and a non-empty prompt", (nodeId) => {
    const node = siteContentSpecialistNodes.find((candidate) => candidate.id === nodeId)!;
    expect(node.dependsOn).toEqual([]);
    expect(typeof node.prompt).toBe("string");
    expect(node.prompt.length).toBeGreaterThan(0);
  });
});

describe("riskLevel — these nodes compose content, they do not publish", () => {
  it.each(EXPECTED_NODE_IDS)("%s's riskLevel ranks below publish", (nodeId) => {
    const node = siteContentSpecialistNodes.find((candidate) => candidate.id === nodeId)!;
    const rank = workspaceRiskLevels.indexOf(node.riskLevel);
    const publishRank = workspaceRiskLevels.indexOf("publish");
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(publishRank);
  });
});

// C3 follow-up (item 4) — the two conditional (if/then) requirements below are not decorative: the
// real dispatch path (nodeRuntime.ts's executeNode) calls this exact function, validateAgainstNodeSchema,
// on data.input before the node ever runs, and rejects the call with input_validation_failed when it
// fails. validateAgainstNodeSchema is a thin wrapper over outputValidator.ts's validateOutput — the same
// function that already validates output schemas — and that function implements if/then/else directly
// (see outputValidator.ts). These tests exercise inputSchema through that same function, not a copy of it.
describe("input-schema if/then conditionals are enforced by the real dispatch-path validator (validateAgainstNodeSchema)", () => {
  it("reference_content_writer: referenceKind 'policy' or 'evidence_story' requires sourceMaterial — a payload without it is rejected, and the non-triggering branch is not over-constrained", () => {
    const node = siteContentSpecialistNodes.find((candidate) => candidate.id === "reference_content_writer")!;

    const missingSourceMaterial = validateAgainstNodeSchema(
      { referenceKind: "policy", brief: { ask: "explain the refund policy" } },
      node.inputSchema
    );
    expect(missingSourceMaterial.valid).toBe(false);
    expect(missingSourceMaterial.issues.join(" ")).toContain("sourceMaterial");

    const missingForEvidenceStory = validateAgainstNodeSchema(
      { referenceKind: "evidence_story", brief: { ask: "a customer result" } },
      node.inputSchema
    );
    expect(missingForEvidenceStory.valid).toBe(false);
    expect(missingForEvidenceStory.issues.join(" ")).toContain("sourceMaterial");

    const satisfied = validateAgainstNodeSchema(
      { referenceKind: "policy", brief: { ask: "explain the refund policy" }, sourceMaterial: ["the policy text"] },
      node.inputSchema
    );
    expect(satisfied.valid).toBe(true);

    // The non-triggering branch (referenceKind: "faq") must NOT require sourceMaterial — proves the
    // conditional is scoped to policy/evidence_story, not a blanket requirement.
    const faqWithoutSourceMaterial = validateAgainstNodeSchema(
      { referenceKind: "faq", brief: { ask: "answer common questions" } },
      node.inputSchema
    );
    expect(faqWithoutSourceMaterial.valid).toBe(true);
  });

  it("site_content_reviewer: mode 'localize' requires targetLocale — a payload without it is rejected, and mode 'revise' is not over-constrained", () => {
    const node = siteContentSpecialistNodes.find((candidate) => candidate.id === "site_content_reviewer")!;

    const missingTargetLocale = validateAgainstNodeSchema(
      { mode: "localize", existingCopy: "hello", brief: { ask: "translate for a new market" } },
      node.inputSchema
    );
    expect(missingTargetLocale.valid).toBe(false);
    expect(missingTargetLocale.issues.join(" ")).toContain("targetLocale");

    const satisfied = validateAgainstNodeSchema(
      { mode: "localize", existingCopy: "hello", brief: { ask: "translate for a new market" }, targetLocale: "es-MX" },
      node.inputSchema
    );
    expect(satisfied.valid).toBe(true);

    // The non-triggering branch (mode: "revise") must NOT require targetLocale.
    const reviseWithoutTargetLocale = validateAgainstNodeSchema(
      { mode: "revise", existingCopy: "hello", brief: { ask: "tighten this paragraph" } },
      node.inputSchema
    );
    expect(reviseWithoutTargetLocale.valid).toBe(true);
  });
});

// Coordinator follow-up (round 2) — the ten crosswalk skill ids now exist as seeded canonical
// definitions (status: "draft", generated by seedNodesFromWorkspace.ts --from-canonical --skills;
// see seededSkills.ts's own generated-file header for how they were produced and why draft is
// deliberate). Before that
// re-seed, every one of these ids was entirely absent from seededSkillDefinitions, which
// skillResolver.ts treats as a BLOCKER-severity conflict, not the warning a draft status gets — see
// tests/agent/mcp/constellationTools.test.ts's own "Nothing blocker-severity" assertion, which this
// exact gap used to fail. THIS test pins the reason seededSkills.ts changed: every skill id these
// five nodes assign must resolve against the seeded set, so a future re-seed that silently drops one
// of the crosswalk skills (or is re-generated from a --skills payload missing one) fails loudly HERE,
// with the offending node/skill named, rather than surfacing only as an opaque attention-item diff
// several files away.
describe("assignedSkills resolve against the seeded canonical set (the fix for the blocker this file's tests used to expose)", () => {
  it("every skill id every specialist node assigns is present in seededSkillDefinitions", () => {
    const seededIds = new Set(seededSkillDefinitions.map((skill) => skill.skillId));
    const missingBySpecialist: Record<string, string[]> = {};
    for (const node of siteContentSpecialistNodes) {
      const missing = (node.assignedSkills ?? []).filter((skillId) => !seededIds.has(skillId));
      if (missing.length) missingBySpecialist[node.id] = missing;
    }
    expect(missingBySpecialist).toEqual({});
  });
});

// C4 follow-up — site_content_planner's own outputSchema must REQUIRE contentRequirement.job on
// every section, not merely allow it via additionalProperties. The C4 conductor
// (siteContentDraftingExecutor.ts) routes purely on this field, by job, never by sectionType; a
// planner whose outputSchema stops requiring it would ship a routable-looking plan that is
// actually unroutable end to end (every section reads as "no job" and is silently skipped) — this
// pins the requirement at the schema the real dispatch path validates against
// (validateAgainstNodeSchema, the same function nodeRuntime.ts's executeNode calls on a completed
// run's output), so a future edit that drops it fails loudly here.
describe("site_content_planner's outputSchema requires contentRequirement.job on every section (the C4 conductor routes on nothing else)", () => {
  const node = siteContentSpecialistNodes.find((candidate) => candidate.id === "site_content_planner")!;
  const basePlan = (sectionOverrides: Record<string, unknown>) => ({
    artifact: "site_content_plan.v1",
    summary: "a plan",
    sections: [{ order: 0, sectionType: "about", purpose: "intro", mustEstablish: ["x"], ...sectionOverrides }]
  });

  it("a section with no contentRequirement at all is rejected, naming contentRequirement", () => {
    const result = validateAgainstNodeSchema(basePlan({}), node.outputSchema);
    expect(result.valid).toBe(false);
    expect(result.issues.join(" ")).toContain("contentRequirement");
  });

  it("a section with contentRequirement but no job is rejected, naming job", () => {
    const result = validateAgainstNodeSchema(basePlan({ contentRequirement: {} }), node.outputSchema);
    expect(result.valid).toBe(false);
    expect(result.issues.join(" ")).toContain("job");
  });

  it("a named job satisfies the schema", () => {
    const result = validateAgainstNodeSchema(basePlan({ contentRequirement: { job: "about_organization" } }), node.outputSchema);
    expect(result.valid).toBe(true);
  });

  it("an explicit null job (a deterministically-built section) satisfies the schema — null is a value, not an absence", () => {
    const result = validateAgainstNodeSchema(
      basePlan({ sectionType: "contact_form", contentRequirement: { job: null } }),
      node.outputSchema
    );
    expect(result.valid).toBe(true);
  });
});
