import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  runSiteContentDrafting,
  type PlanSection,
  type SiteContentDraftingDeps,
  type SiteContentDraftingSupplement
} from "../../../src/agent/operations/siteContentDraftingExecutor.js";
import { SITE_CONTENT_PAGE_RECIPES, SITE_CONTENT_PAGE_RECIPE_NAMES } from "../../../src/agent/operations/siteContentPageRecipes.js";

const PROJECT_ID = "acme-site";

// A minimal executeNode-shaped result carrying exactly one node's output, matching the
// state.output-defined path nodeRuntime.ts's executeNode returns on success — the same shape
// visualIdentityTools.ts's extractNodeProposal (and this module's own extractNodeOutput) read.
const executed = (nodeId: string, output: Record<string, unknown>) => ({
  execution: { nodes: [{ nodeId, output }] }
});

function section(overrides: Partial<PlanSection> & Pick<PlanSection, "order" | "sectionType">): PlanSection {
  return {
    purpose: "test purpose",
    mustEstablish: ["something"],
    ...overrides
  };
}

function plan(sections: PlanSection[]) {
  return { artifact: "site_content_plan.v1", summary: "a plan", sections };
}

// Builds an executeNodeImpl mock that answers the planner with `sections`, and every specialist
// dispatch with a canned draft (or throws, for nodeIds listed in `throwFor`) — recording every call
// so a test can assert exactly what was dispatched and with what candidateSkillIds.
function makeRunner(sections: PlanSection[], opts: { throwFor?: Set<string> } = {}) {
  const calls: Array<{ nodeId: string; input: Record<string, unknown>; candidateSkillIds?: string[] }> = [];
  const runNode = vi.fn(async (data: any) => {
    calls.push({ nodeId: data.nodeId, input: data.input, candidateSkillIds: data.candidateSkillIds });
    if (data.nodeId === "site_content_planner") return executed("site_content_planner", plan(sections));
    if (opts.throwFor?.has(data.nodeId)) throw new Error(`${data.nodeId} exploded`);
    return executed(data.nodeId, { artifact: `${data.nodeId}.v1`, summary: "drafted", ...data.input });
  }) as unknown as NonNullable<SiteContentDraftingDeps["executeNodeImpl"]>;
  return { runNode, calls };
}

describe("runSiteContentDrafting — job routing", () => {
  it("dispatches three different jobs to three different nodes, each with candidateSkillIds: [job]", async () => {
    const sections: PlanSection[] = [
      section({ order: 0, sectionType: "about", contentRequirement: { job: "about_organization" } }),
      section({ order: 1, sectionType: "offering", offeringKind: "product", contentRequirement: { job: "product_service_description" } }),
      section({ order: 2, sectionType: "faq", referenceKind: "faq", contentRequirement: { job: "faq_help_process" } })
    ];
    const { runNode, calls } = makeRunner(sections);

    const result = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNode });

    expect(result.outcomes.every((outcome) => outcome.outcome === "drafted")).toBe(true);
    const dispatchCalls = calls.filter((call) => call.nodeId !== "site_content_planner");
    expect(dispatchCalls.map((call) => call.nodeId)).toEqual([
      "organization_narrative_writer",
      "offering_description_writer",
      "reference_content_writer"
    ]);
    expect(dispatchCalls[0].candidateSkillIds).toEqual(["about_organization"]);
    expect(dispatchCalls[1].candidateSkillIds).toEqual(["product_service_description"]);
    expect(dispatchCalls[2].candidateSkillIds).toEqual(["faq_help_process"]);
  });

  it("about_organization vs people_profile produce different narrativeKind on the same node", async () => {
    const sections: PlanSection[] = [
      section({ order: 0, sectionType: "about", contentRequirement: { job: "about_organization" } }),
      section({ order: 1, sectionType: "leadership_bios", contentRequirement: { job: "people_profile" } })
    ];
    const { runNode, calls } = makeRunner(sections);

    await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNode });

    const dispatchCalls = calls.filter((call) => call.nodeId === "organization_narrative_writer");
    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls[0].input.narrativeKind).toBe("organization");
    expect(dispatchCalls[1].input.narrativeKind).toBe("people");
  });

  it("refuses an ambiguous job by name when the section carries no discriminator, and still drafts the other sections", async () => {
    const sections: PlanSection[] = [
      section({ order: 0, sectionType: "about", contentRequirement: { job: "about_organization" } }),
      // faq_help_process is ambiguous (faq vs process) and this section names no referenceKind.
      section({ order: 1, sectionType: "mystery_reference", contentRequirement: { job: "faq_help_process" } })
    ];
    const { runNode, calls } = makeRunner(sections);

    const result = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNode });

    const drafted = result.outcomes.find((outcome) => outcome.order === 0);
    const refused = result.outcomes.find((outcome) => outcome.order === 1);
    expect(drafted?.outcome).toBe("drafted");
    expect(refused?.outcome).toBe("refused");
    expect(refused && "reason" in refused ? refused.reason : "").toContain("section 1");
    expect(refused && "reason" in refused ? refused.reason : "").toContain("mystery_reference");
    expect(refused && "reason" in refused ? refused.reason : "").toContain("referenceKind");
    // The ambiguous section was never dispatched to a node at all — refused before any call.
    expect(calls.some((call) => call.nodeId === "reference_content_writer")).toBe(false);
  });

  it("skips (not refuses) a section whose job is null, and still returns outcomes for the rest", async () => {
    const sections: PlanSection[] = [
      section({ order: 0, sectionType: "contact_form", contentRequirement: { job: null, needs: "Deterministic — the compiler binds the contact form." } }),
      section({ order: 1, sectionType: "about", contentRequirement: { job: "about_organization" } })
    ];
    const { runNode, calls } = makeRunner(sections);

    const result = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNode });

    const skipped = result.outcomes.find((outcome) => outcome.order === 0);
    expect(skipped?.outcome).toBe("skipped");
    expect(skipped && "reason" in skipped ? skipped.reason : "").toBe("no_job");
    expect(result.outcomes.find((outcome) => outcome.order === 1)?.outcome).toBe("drafted");
    expect(calls.some((call) => call.nodeId === "organization_narrative_writer")).toBe(true);
  });

  it("one writer throwing does not discard the other sections' drafts", async () => {
    const sections: PlanSection[] = [
      section({ order: 0, sectionType: "about", contentRequirement: { job: "about_organization" } }),
      section({ order: 1, sectionType: "evidence", contentRequirement: { job: "evidence_story" } }),
      section({ order: 2, sectionType: "policy", contentRequirement: { job: "policy_explanation" } })
    ];
    const { runNode } = makeRunner(sections, { throwFor: new Set(["reference_content_writer"]) });

    const result = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNode });

    // evidence_story AND policy_explanation both route to reference_content_writer, so both throw —
    // but the unrelated about_organization section (a different node) must still have drafted.
    expect(result.outcomes.find((outcome) => outcome.order === 0)?.outcome).toBe("drafted");
    const evidence = result.outcomes.find((outcome) => outcome.order === 1);
    const policy = result.outcomes.find((outcome) => outcome.order === 2);
    expect(evidence?.outcome).toBe("refused");
    expect(policy?.outcome).toBe("refused");
    expect(evidence && "reason" in evidence ? evidence.reason : "").toContain("threw");
  });

  it("a caller-supplied per-section supplement carries facts/sourceMaterial/targetLocale through to the dispatched node", async () => {
    const sections: PlanSection[] = [section({ order: 0, sectionType: "policy", contentRequirement: { job: "policy_explanation" } })];
    const { runNode, calls } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [{ order: 0, sourceMaterial: ["The refund policy text."] }];

    await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" }, supplements }, { executeNodeImpl: runNode });

    const call = calls.find((entry) => entry.nodeId === "reference_content_writer");
    expect(call?.input.sourceMaterial).toEqual(["The refund policy text."]);
    expect(call?.input.referenceKind).toBe("policy");
  });
});

describe("no write tool reachable from this module", () => {
  it("the executor module's own source never invokes object_create/object_patch/object_publish/project.call_tool (comments describing what it never does are fine)", () => {
    const modulePath = fileURLToPath(new URL("../../../src/agent/operations/siteContentDraftingExecutor.ts", import.meta.url));
    const codeOnly = readFileSync(modulePath, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/object_create/);
    expect(codeOnly).not.toMatch(/object_patch/);
    expect(codeOnly).not.toMatch(/object_publish/);
    expect(codeOnly).not.toMatch(/release_to_production/);
    expect(codeOnly).not.toMatch(/project\.call_tool/);
  });

  it("SiteContentDraftingDeps' only injected seam is executeNodeImpl — a fully-populated deps object has exactly one key", () => {
    const deps: SiteContentDraftingDeps = { executeNodeImpl: (async () => ({})) as any };
    expect(Object.keys(deps)).toEqual(["executeNodeImpl"]);
  });
});

// -------------------------------------------------------------------------------------------------
// Page recipes (siteContentPageRecipes.ts) — optional named page-shape declarations that only ever
// SUPPLY a section's job/discriminator, and only when nothing else already named one.
describe("page recipes — routing", () => {
  // The node + candidateSkillIds every recipe's own section is expected to resolve to, given a plan
  // section that names no job at all (so the recipe is the only source). `reference` needs an
  // external referenceKind supplement to complete routing at all — see its own recipe's header on
  // why it deliberately declares none — so it is asserted separately below.
  const expected: Record<string, { nodeId: string; candidateSkillIds: string[] }> = {
    organization_page: { nodeId: "organization_narrative_writer", candidateSkillIds: ["about_organization"] },
    people_profiles: { nodeId: "organization_narrative_writer", candidateSkillIds: ["people_profile"] },
    documentation_page: { nodeId: "reference_content_writer", candidateSkillIds: ["faq_help_process"] },
    offering: { nodeId: "offering_description_writer", candidateSkillIds: ["product_service_description"] },
    program_event: { nodeId: "offering_description_writer", candidateSkillIds: ["program_event_description"] },
    evidence_story: { nodeId: "reference_content_writer", candidateSkillIds: ["evidence_story"] },
    revision: { nodeId: "site_content_reviewer", candidateSkillIds: ["focused_revision"] },
    localization: { nodeId: "site_content_reviewer", candidateSkillIds: ["localization"] }
  };

  for (const [recipeName, want] of Object.entries(expected)) {
    it(`recipe "${recipeName}" routes its section to ${want.nodeId} with candidateSkillIds ${JSON.stringify(want.candidateSkillIds)}`, async () => {
      const recipeSections = SITE_CONTENT_PAGE_RECIPES[recipeName].sections;
      const sections: PlanSection[] = recipeSections.map((entry) => section({ order: entry.order, sectionType: "recipe_test" }));
      const { runNode, calls } = makeRunner(sections);

      const result = await runSiteContentDrafting(
        { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: recipeName },
        { executeNodeImpl: runNode }
      );

      expect(result.outcomes.every((outcome) => outcome.outcome === "drafted")).toBe(true);
      const dispatchCalls = calls.filter((call) => call.nodeId !== "site_content_planner");
      expect(dispatchCalls.map((call) => call.nodeId)).toEqual([want.nodeId]);
      expect(dispatchCalls[0].candidateSkillIds).toEqual(want.candidateSkillIds);
      const drafted = result.outcomes[0] as any;
      expect(drafted.jobSource).toBe("recipe");
      expect(drafted.pageRecipe).toBe(recipeName);
      expect(drafted.candidateSkillIds).toEqual(want.candidateSkillIds);
    });
  }

  it('recipe "reference" routes to reference_content_writer once a referenceKind is supplied elsewhere (the recipe itself declares none)', async () => {
    const sections: PlanSection[] = [section({ order: 0, sectionType: "recipe_test" })];
    const { runNode, calls } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [{ order: 0, referenceKind: "faq" }];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "reference", supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.outcomes[0].outcome).toBe("drafted");
    const dispatchCalls = calls.filter((call) => call.nodeId !== "site_content_planner");
    expect(dispatchCalls.map((call) => call.nodeId)).toEqual(["reference_content_writer"]);
    expect(dispatchCalls[0].candidateSkillIds).toEqual(["faq_help_process"]);
  });

  it("every declared recipe name is exercised above (guards against a recipe silently added without a routing test)", () => {
    const covered = new Set([...Object.keys(expected), "reference"]);
    expect(new Set(SITE_CONTENT_PAGE_RECIPE_NAMES)).toEqual(covered);
  });
});

describe("page recipes — precedence (supplement > planner job > recipe)", () => {
  it("a caller supplement's job wins over both the planner's own job and the recipe", async () => {
    // organization_page's recipe says about_organization/organization_narrative_writer for order 0;
    // the plan itself says people_profile; the supplement overrides both with focused_revision.
    const sections: PlanSection[] = [section({ order: 0, sectionType: "s", contentRequirement: { job: "people_profile" } })];
    const { runNode, calls } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [{ order: 0, job: "focused_revision", existingCopy: "old copy" }];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "organization_page", supplements },
      { executeNodeImpl: runNode }
    );

    const outcome = result.outcomes[0] as any;
    expect(outcome.outcome).toBe("drafted");
    expect(outcome.job).toBe("focused_revision");
    expect(outcome.jobSource).toBe("supplement");
    const dispatchCalls = calls.filter((call) => call.nodeId !== "site_content_planner");
    expect(dispatchCalls.map((call) => call.nodeId)).toEqual(["site_content_reviewer"]);
  });

  it("the planner's own job wins over the recipe when no supplement names one", async () => {
    // organization_page's recipe says about_organization for order 0; the plan itself instead says
    // people_profile, and no supplement is given — the planner's job must win.
    const sections: PlanSection[] = [section({ order: 0, sectionType: "s", contentRequirement: { job: "people_profile" } })];
    const { runNode, calls } = makeRunner(sections);

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "organization_page" },
      { executeNodeImpl: runNode }
    );

    const outcome = result.outcomes[0] as any;
    expect(outcome.outcome).toBe("drafted");
    expect(outcome.job).toBe("people_profile");
    expect(outcome.jobSource).toBe("planner");
    const dispatchCalls = calls.filter((call) => call.nodeId !== "site_content_planner");
    expect(dispatchCalls[0].candidateSkillIds).toEqual(["people_profile"]);
  });

  it("the recipe supplies the job only when neither a supplement nor the planner's section named one", async () => {
    const sections: PlanSection[] = [section({ order: 0, sectionType: "s" })];
    const { runNode, calls } = makeRunner(sections);

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "organization_page" },
      { executeNodeImpl: runNode }
    );

    const outcome = result.outcomes[0] as any;
    expect(outcome.outcome).toBe("drafted");
    expect(outcome.job).toBe("about_organization");
    expect(outcome.jobSource).toBe("recipe");
    expect(outcome.pageRecipe).toBe("organization_page");
    const dispatchCalls = calls.filter((call) => call.nodeId !== "site_content_planner");
    expect(dispatchCalls.map((call) => call.nodeId)).toEqual(["organization_narrative_writer"]);
  });
});

describe("page recipes — optional, byte-identical when omitted", () => {
  it("omitting pageRecipe produces the exact same outcome as today's behaviour on a plan the recipe would otherwise have supplied a job for", async () => {
    const sections: PlanSection[] = [section({ order: 0, sectionType: "about", contentRequirement: { job: "about_organization" } })];

    const withoutRecipe = makeRunner(sections);
    const resultWithout = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: withoutRecipe.runNode });

    const withRecipe = makeRunner(sections);
    const resultWith = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "organization_page" },
      { executeNodeImpl: withRecipe.runNode }
    );

    // Both dispatch identically: the plan already named the job, so the recipe (present or absent)
    // never gets consulted, and jobSource is "planner" either way.
    expect((resultWithout.outcomes[0] as any).nodeId).toEqual((resultWith.outcomes[0] as any).nodeId);
    expect((resultWithout.outcomes[0] as any).job).toEqual((resultWith.outcomes[0] as any).job);
    expect((resultWith.outcomes[0] as any).jobSource).toBe("planner");
    expect(resultWithout.outcomes).toHaveLength(1);
    expect(resultWith.outcomes).toHaveLength(1);
  });
});

describe("page recipes — unknown name refused", () => {
  it("an unrecognized pageRecipe name throws, listing the known recipe names", async () => {
    const { runNode } = makeRunner([]);

    await expect(
      runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "not_a_real_recipe" }, { executeNodeImpl: runNode })
    ).rejects.toThrow(/not_a_real_recipe/);

    for (const name of SITE_CONTENT_PAGE_RECIPE_NAMES) {
      await expect(
        runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "not_a_real_recipe" }, { executeNodeImpl: runNode })
      ).rejects.toThrow(new RegExp(name));
    }
  });
});

describe("page recipes — no discriminator declared, refusal preserved verbatim", () => {
  it('recipe "reference" declares no referenceKind, so a section with no other source still gets the exact ambiguous-discriminator refusal message', async () => {
    const sections: PlanSection[] = [section({ order: 0, sectionType: "mystery_reference" })];
    const { runNode: runWithout } = makeRunner(sections);
    const { runNode: runWith } = makeRunner(sections);

    const withoutRecipe = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runWithout });
    // The plan alone names no job here, so without a recipe this section is merely "skipped" — the
    // real apples-to-apples comparison is: give BOTH runs the same job (via the plan) but only the
    // recipe run withholds the discriminator, matching the no-recipe-and-no-discriminator refusal
    // the existing "faq_help_process ambiguous" test already covers verbatim.
    expect(withoutRecipe.outcomes[0].outcome).toBe("skipped");

    const sectionsWithJob: PlanSection[] = [section({ order: 0, sectionType: "mystery_reference", contentRequirement: { job: "faq_help_process" } })];
    const { runNode: runNoRecipeWithJob } = makeRunner(sectionsWithJob);
    const { runNode: runRecipeWithJob } = makeRunner(sectionsWithJob);

    const noRecipeResult = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNoRecipeWithJob });
    const recipeResult = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "reference" },
      { executeNodeImpl: runRecipeWithJob }
    );

    const noRecipeRefusal = noRecipeResult.outcomes[0] as any;
    const recipeRefusal = recipeResult.outcomes[0] as any;
    expect(noRecipeRefusal.outcome).toBe("refused");
    expect(recipeRefusal.outcome).toBe("refused");
    // Verbatim: the recipe's presence changes nothing about the refusal message itself.
    expect(recipeRefusal.reason).toBe(noRecipeRefusal.reason);
    expect(recipeRefusal.reason).toContain("referenceKind");
  });
});

describe("page recipes — planner/recipe order reconciliation", () => {
  it("more planner sections than the recipe declares: the extra section falls through to today's behaviour (planner job, or skip)", async () => {
    const sections: PlanSection[] = [
      section({ order: 0, sectionType: "about" }), // recipe supplies about_organization
      section({ order: 1, sectionType: "extra", contentRequirement: { job: "evidence_story" } }) // recipe has no order 1 at all
    ];
    const { runNode, calls } = makeRunner(sections);

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "organization_page" },
      { executeNodeImpl: runNode }
    );

    expect(result.outcomes).toHaveLength(2);
    const first = result.outcomes.find((o) => o.order === 0) as any;
    const second = result.outcomes.find((o) => o.order === 1) as any;
    expect(first.jobSource).toBe("recipe");
    expect(first.job).toBe("about_organization");
    expect(second.jobSource).toBe("planner");
    expect(second.job).toBe("evidence_story");
    const dispatchCalls = calls.filter((call) => call.nodeId !== "site_content_planner");
    expect(dispatchCalls.map((call) => call.nodeId).sort()).toEqual(["organization_narrative_writer", "reference_content_writer"].sort());
  });

  it("fewer planner sections than the recipe declares: the undelivered recipe entry is reported, never silently dropped", async () => {
    // offering's recipe names only order 0; the planner here returns nothing at all — a maximal
    // "fewer" case.
    const { runNode } = makeRunner([]);

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "offering" },
      { executeNodeImpl: runNode }
    );

    expect(result.outcomes).toHaveLength(1);
    const undelivered = result.outcomes[0] as any;
    expect(undelivered.outcome).toBe("recipe_undelivered");
    expect(undelivered.order).toBe(0);
    expect(undelivered.job).toBe("product_service_description");
    expect(undelivered.pageRecipe).toBe("offering");
    expect(undelivered.reason).toContain("offering");
  });
});

// Coordinator review (2026-09-17): the recipe layer's mustEstablish default must not change what a
// no-recipe call sends. An empty array the planner actually wrote is a statement ("this section
// establishes nothing new"), not an absence, so it must survive as [] rather than becoming
// undefined — the byte-for-byte guarantee of rule 3 at field level.
describe("runSiteContentDrafting — recipe defaults never rewrite what the planner wrote", () => {
  it("preserves an empty mustEstablish array from the planner when no pageRecipe is supplied", async () => {
    const sections: PlanSection[] = [
      section({ order: 0, sectionType: "about", mustEstablish: [], contentRequirement: { job: "about_organization" } })
    ];
    const { runNode, calls } = makeRunner(sections);

    await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNode });

    const dispatch = calls.find((call) => call.nodeId === "organization_narrative_writer");
    expect((dispatch!.input as any).brief.mustEstablish).toEqual([]);
  });

  it("uses the recipe's mustEstablish only when the planner's section left it empty AND a recipe entry exists", async () => {
    const sections: PlanSection[] = [section({ order: 0, sectionType: "about", mustEstablish: [] })];
    const { runNode, calls } = makeRunner(sections);

    await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "organization_page" },
      { executeNodeImpl: runNode }
    );

    const dispatch = calls.find((call) => call.nodeId === "organization_narrative_writer");
    expect((dispatch!.input as any).brief.mustEstablish).toEqual(SITE_CONTENT_PAGE_RECIPES.organization_page.sections[0]!.mustEstablish);
  });
});

// -------------------------------------------------------------------------------------------------
// THE LIVE DEFECT (2026-09-17, dr-lurie): a real planner numbered its one-section plan `order: 1`. A
// supplement keyed `order: 0` (the only sane first-draft choice — the caller cannot know the
// planner's real numbering yet) never matched, the section skipped as "no_job", and the tool reported
// `ok: true` with zero drafts. These tests reproduce that exact shape and assert it is now fixed, for
// both the supplements channel and the pageRecipe channel (identical defect, `order: 0` in every
// recipe).
describe("runSiteContentDrafting — supplement/recipe matching on a 1-based (non-zero) planner order", () => {
  it("a supplement keyed order:0 drafts a section the planner numbered order:1 (positional fallback — the live dr-lurie defect, supplements channel)", async () => {
    const sections: PlanSection[] = [section({ order: 1, sectionType: "about_overview" })];
    const { runNode, calls } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [
      { order: 0, job: "about_organization", facts: ["Founded 2010.", "Family-owned."] }
    ];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0] as any;
    expect(outcome.outcome).toBe("drafted");
    expect(outcome.job).toBe("about_organization");
    expect(outcome.jobSource).toBe("supplement");
    expect(result.supplementMatching).toBe("position");
    const dispatchCall = calls.find((call) => call.nodeId === "organization_narrative_writer");
    expect(dispatchCall?.input.facts).toEqual(["Founded 2010.", "Family-owned."]);
  });

  it("pageRecipe drafts a section the planner numbered order:1 (positional pairing — the live dr-lurie defect, recipe channel)", async () => {
    const sections: PlanSection[] = [section({ order: 1, sectionType: "about_overview" })];
    const { runNode, calls } = makeRunner(sections);

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, pageRecipe: "organization_page" },
      { executeNodeImpl: runNode }
    );

    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0] as any;
    expect(outcome.outcome).toBe("drafted");
    expect(outcome.job).toBe("about_organization");
    expect(outcome.jobSource).toBe("recipe");
    expect(outcome.pageRecipe).toBe("organization_page");
    const dispatchCall = calls.find((call) => call.nodeId === "organization_narrative_writer");
    expect(dispatchCall).toBeTruthy();
  });
});

describe("runSiteContentDrafting — supplement matching precedence (order wins when it matches, positional fallback only when it never does)", () => {
  it("order-matching wins on a re-draft: a plan returning orders 2 and 5, with supplements keyed 2 and 5, drafts both by order", async () => {
    const sections: PlanSection[] = [
      section({ order: 2, sectionType: "about" }),
      section({ order: 5, sectionType: "policy" })
    ];
    const { runNode } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [
      { order: 2, job: "about_organization" },
      { order: 5, job: "policy_explanation" }
    ];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.supplementMatching).toBe("order");
    const byOrder = new Map(result.outcomes.map((o: any) => [o.order, o]));
    expect((byOrder.get(2) as any).outcome).toBe("drafted");
    expect((byOrder.get(2) as any).job).toBe("about_organization");
    expect((byOrder.get(5) as any).outcome).toBe("drafted");
    expect((byOrder.get(5) as any).job).toBe("policy_explanation");
  });

  it("positional fallback is chosen only when NO supplement matched by order at all", async () => {
    // Neither supplied supplement's order (0, 1) equals either returned section's own order (3, 7),
    // so the whole call falls back to position: supplement order 0 -> position 0 (order 3), order 1
    // -> position 1 (order 7).
    const sections: PlanSection[] = [
      section({ order: 3, sectionType: "about" }),
      section({ order: 7, sectionType: "policy" })
    ];
    const { runNode } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [
      { order: 0, job: "about_organization" },
      { order: 1, job: "policy_explanation" }
    ];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.supplementMatching).toBe("position");
    const byOrder = new Map(result.outcomes.map((o: any) => [o.order, o]));
    expect((byOrder.get(3) as any).outcome).toBe("drafted");
    expect((byOrder.get(3) as any).job).toBe("about_organization");
    expect((byOrder.get(7) as any).outcome).toBe("drafted");
    expect((byOrder.get(7) as any).job).toBe("policy_explanation");
  });

  // Coordinator review (2026-09-17): a PARTIAL match is the one case where a guess misattributes
  // content instead of merely losing it, so each mode is chosen only when it accounts for EVERY
  // supplied supplement, and a call satisfying neither is refused before any writer is dispatched.
  it("a partial match (some supplements match by order, not all, and not all are valid positions) is refused as ambiguous with no writer dispatched", async () => {
    const sections: PlanSection[] = [
      section({ order: 2, sectionType: "about" }),
      section({ order: 5, sectionType: "policy" })
    ];
    const { runNode, calls } = makeRunner(sections);
    // order:2 matches a returned order, order:9 matches neither a returned order nor a valid
    // position (the plan has 2 sections, positions 0..1). Resolving this on the majority would apply
    // order 2's facts correctly and silently strip order 9's — or, worse under an ANY rule, pair the
    // wrong section. Refuse instead.
    const supplements: SiteContentDraftingSupplement[] = [
      { order: 2, job: "about_organization" },
      { order: 9, job: "policy_explanation" }
    ];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.supplementMatching).toBe("ambiguous");
    expect(result.supplementMatchingReason).toContain("[2, 5]");
    // The plan is still returned, so the caller can re-key on the real orders without replanning.
    expect(result.plan.sections).toHaveLength(2);
    // Every supplement is reported, and NOTHING was drafted — only the planner ran.
    expect(result.outcomes.map((outcome: any) => outcome.outcome)).toEqual(["supplement_unmatched", "supplement_unmatched"]);
    expect(calls.filter((call) => call.nodeId !== "site_content_planner")).toHaveLength(0);
  });

  it("a first-draft caller keying 0..N-1 against a 1-based plan reads positionally, never order-wise on the one order that happens to collide", async () => {
    // The misattribution hazard in its exact shape: plan returns orders [1, 2]; the caller supplied
    // positions [0, 1]. Supplement order 1 collides with the section the planner numbered 1 (which is
    // POSITION 0), so an ANY-match rule would apply position 1's facts to position 0's section — the
    // wrong section, with a plausible-looking result. Both supplements are valid positions, so the
    // call reads positionally and each section gets its own facts.
    const sections: PlanSection[] = [
      section({ order: 1, sectionType: "about" }),
      section({ order: 2, sectionType: "policy" })
    ];
    const { runNode, calls } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [
      { order: 0, job: "about_organization", facts: ["about-facts"] },
      { order: 1, job: "policy_explanation", sourceMaterial: ["policy-source"] }
    ];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.supplementMatching).toBe("position");
    expect(result.outcomes.every((outcome: any) => outcome.outcome === "drafted")).toBe(true);
    // Position 0's facts reached the about writer, not the policy one.
    const aboutCall = calls.find((call) => call.nodeId === "organization_narrative_writer");
    expect((aboutCall!.input as any).facts).toEqual(["about-facts"]);
    const policyCall = calls.find((call) => call.nodeId === "reference_content_writer");
    expect((policyCall!.input as any).sourceMaterial).toEqual(["policy-source"]);
  });

  it("a supplement with no valid position either (order 4 against a one-section plan) is refused as ambiguous, naming the section count", async () => {
    const sections: PlanSection[] = [section({ order: 1, sectionType: "about_overview" })];
    const { runNode } = makeRunner(sections);
    // order:0 would pair with position 0, but order:4 pairs with nothing under either reading — the
    // plan has one section (order 1, position 0). Pairing what fits and dropping order:4 would lose
    // caller-supplied content silently, so the whole call refuses.
    const supplements: SiteContentDraftingSupplement[] = [
      { order: 0, job: "about_organization" },
      { order: 4, job: "policy_explanation" }
    ];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.supplementMatching).toBe("ambiguous");
    expect(result.outcomes.map((outcome: any) => outcome.order)).toEqual([0, 4]);
    expect(result.outcomes.every((outcome: any) => outcome.outcome === "supplement_unmatched")).toBe(true);
    expect(result.supplementMatchingReason).toMatch(/1 section/);
  });

  it("non-contiguous, out-of-sequence planner orders (array position and order value disagree) still match correctly by order", async () => {
    // Position 0 carries order 9, position 1 carries order 4 — position and order value deliberately
    // disagree. Order-mode must match by `order`, not by array position.
    const sections: PlanSection[] = [
      section({ order: 9, sectionType: "second_logically" }),
      section({ order: 4, sectionType: "first_logically" })
    ];
    const { runNode, calls } = makeRunner(sections);
    const supplements: SiteContentDraftingSupplement[] = [
      { order: 4, job: "about_organization", facts: ["for order 4"] },
      { order: 9, job: "policy_explanation" }
    ];

    const result = await runSiteContentDrafting(
      { projectId: PROJECT_ID, brief: { purpose: "test" }, supplements },
      { executeNodeImpl: runNode }
    );

    expect(result.supplementMatching).toBe("order");
    const order9 = result.outcomes.find((o: any) => o.order === 9) as any;
    const order4 = result.outcomes.find((o: any) => o.order === 4) as any;
    expect(order9.job).toBe("policy_explanation");
    expect(order4.job).toBe("about_organization");
    const narrativeCall = calls.find((call) => call.nodeId === "organization_narrative_writer");
    expect(narrativeCall?.input.facts).toEqual(["for order 4"]);
  });

  it("no supplements at all reports supplementMatching: \"none\"", async () => {
    const sections: PlanSection[] = [section({ order: 0, sectionType: "about", contentRequirement: { job: "about_organization" } })];
    const { runNode } = makeRunner(sections);

    const result = await runSiteContentDrafting({ projectId: PROJECT_ID, brief: { purpose: "test" } }, { executeNodeImpl: runNode });

    expect(result.supplementMatching).toBe("none");
    expect(result.supplementMatchingReason).toMatch(/no supplements/i);
  });
});
