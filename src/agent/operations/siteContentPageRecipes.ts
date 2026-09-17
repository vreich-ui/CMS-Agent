// site_content page recipes (C4/C5 follow-up) — a named, in-source declaration of a page kind's
// planned shape: which sections it expects, in what order, each section's `job`, and (only where the
// job is genuinely ambiguous) the discriminator that job needs. This exists to close the defect the
// Sep 16 session named as one of the two that mattered: siteContentDraftingExecutor.ts routes on
// `section.contentRequirement.job`, a field site_content_planner's own outputSchema neither requires
// nor declares, and `page_composition` (the skill whose examples use that field) is still a DRAFT
// skill nobody has instructed the planner to emit it. A recipe lets the CALLER declare the page's
// shape up front instead of hoping the planner emits the right field — see
// siteContentDraftingExecutor.ts's header for the full routing-by-job background.
//
// WHAT A RECIPE IS NOT. It never turns an ambiguous job into a guess, and it never overrides anything
// the caller or the planner already stated. Precedence for a section's `job`, highest first: the
// caller's `supplements[order].job` (including an explicit `null`, which still means "skip" — the
// existing rule that a supplement OMITTING `job` must fall through, never null it out, is untouched),
// then the planner's own `section.contentRequirement.job` (ditto: present-and-null still means
// "skip"), then — only when neither said anything at all — this recipe's entry for that section's
// `order`. The same precedence applies to the ambiguous-job discriminators (`offeringKind` /
// `referenceKind`): a recipe may SUPPLY one, never override a caller- or planner-supplied one. Where a
// recipe declares no discriminator for an ambiguous job and none is supplied elsewhere, the section is
// refused by name exactly as it always was — see `reference` below, which deliberately leaves
// `referenceKind` undeclared because a generic reference page cannot know FAQ vs. process without more
// than a page kind.
//
// A recipe is OPTIONAL and reconciled against the planner's actual output BY ORDER, never by count: a
// planner returning more sections than the recipe names lets the extra sections fall through to
// today's behaviour untouched (planner job, or skip); a planner returning fewer than the recipe names
// means the recipe's undelivered entries are reported — never silently dropped — as a
// `recipe_undelivered` outcome (see siteContentDraftingExecutor.ts).
//
// SKILL NARROWING. Every job in SITE_CONTENT_JOBS is already a 1:1 `skillId` in seededSkills.ts (the
// C4/C5 `executionOwner` metadata confirms the pairing: `about_organization` -> "C4 organization_page",
// `people_profile` -> "C4 people_profiles", `evidence_story`/`focused_revision`/`localization` ->
// their own "C5 …" owners, `faq_help_process`/`policy_explanation` -> "C5 reference_content",
// `product_service_description` -> "C5 offering_content", `program_event_description` -> "C5
// program_event_content"). siteContentDraftingExecutor.ts's `dispatchSection` ALREADY passes
// `candidateSkillIds: [job]` on every specialist dispatch (see its own comment citing #374) — a
// recipe does not need its own separate skill list; naming the job (whether the caller, the planner,
// or this recipe supplied it) is what narrows the dispatch, and a recipe's routing table below exists
// so a reviewer can see, per named page kind, exactly which node and skill a section resolves to
// without re-deriving it from the executor's dispatch table.

import type { SiteContentJob } from "./siteContentDraftingExecutor.js";

export type SiteContentRecipeSection = {
  order: number;
  job: SiteContentJob;
  // Only meaningful for the two jobs whose specialist node needs a discriminator its own inputSchema
  // requires (offering_description_writer's `offeringKind`, reference_content_writer's
  // `referenceKind` for faq_help_process specifically — policy_explanation/evidence_story already
  // resolve to a fixed referenceKind in siteContentDraftingExecutor.ts's routing table and need none
  // here). Declaring one for any other job is inert — resolveDispatch never reads it.
  offeringKind?: "product" | "service" | "program" | "event";
  referenceKind?: "faq" | "process" | "policy" | "evidence_story";
  // Defaults folded into the section's writer brief only where the planner's own section did not
  // already say so (buildSectionBrief in the executor prefers the planner's `purpose`/`mustEstablish`
  // when present).
  purpose?: string;
  mustEstablish?: string[];
};

export type SiteContentPageRecipe = {
  name: string;
  description: string;
  sections: SiteContentRecipeSection[];
};

const recipe = (name: string, description: string, sections: SiteContentRecipeSection[]): SiteContentPageRecipe => ({
  name,
  description,
  sections
});

// ---------------------------------------------------------------------------------------------
// C4 pair — the two page kinds seededSkills.ts's own `executionOwner` metadata names directly:
// `about_organization` -> "C4 organization_page", `people_profile` -> "C4 people_profiles".
const organizationPage = recipe(
  "organization_page",
  "A single-section About/organization page: what the organization is, does and stands for.",
  [
    {
      order: 0,
      job: "about_organization",
      purpose: "Establish what the organization is, what it does, and what it stands for.",
      mustEstablish: ["organization identity", "purpose"]
    }
  ]
);

const peopleProfiles = recipe(
  "people_profiles",
  "A single-section people/leadership page introducing who leads or represents the organization.",
  [
    {
      order: 0,
      job: "people_profile",
      purpose: "Introduce the people who lead or represent the organization.",
      mustEstablish: ["names and roles"]
    }
  ]
);

// Wolf's standing decision: platform documentation is a recipe on THIS path, reusing the shared
// specialists and deterministic builders — shown as "Documentation" in /workbench. There is no
// separate conductor and no fourth scope dimension; fleet defaults stay neutral across
// commercial/foundation/documentation/lab. A documentation page routes through the same
// reference_content_writer as any other reference_kind, narrowed to "process" (how to use or
// configure something, step by step) rather than "faq" — this is a genuine choice this recipe makes
// on the caller's behalf, unlike `reference` below, which deliberately leaves this undeclared.
const documentationPage = recipe(
  "documentation_page",
  "A single-section platform documentation page — reuses the shared reference_content_writer specialist, narrowed to process (how-to) rather than FAQ.",
  [
    {
      order: 0,
      job: "faq_help_process",
      referenceKind: "process",
      purpose: "Walk through how to use or configure this, step by step.",
      mustEstablish: ["prerequisites", "steps", "expected result"]
    }
  ]
);

// ---------------------------------------------------------------------------------------------
// The C5 set: offering, program_event, reference, evidence_story, revision, localization.
const offering = recipe(
  "offering",
  "A single-section product/service description page. Declares offeringKind: \"product\" (the first-listed alternative for product_service_description) — a caller or the planner's own section may still override it, per precedence.",
  [
    {
      order: 0,
      job: "product_service_description",
      offeringKind: "product",
      purpose: "Describe what this product is, who it is for, and what it does.",
      mustEstablish: ["what it is", "who it's for"]
    }
  ]
);

const programEvent = recipe(
  "program_event",
  "A single-section program/event description page. Declares offeringKind: \"program\" (the first-listed alternative for program_event_description, mirroring `offering`'s convention) — a caller or the planner's own section may still override it, per precedence.",
  [
    {
      order: 0,
      job: "program_event_description",
      offeringKind: "program",
      purpose: "Describe what this program offers, to whom, and its shape (duration or cadence).",
      mustEstablish: ["what it offers", "who it's for"]
    }
  ]
);

// Deliberately declares NO referenceKind: a generic "reference" page cannot know FAQ vs. process from
// its name alone, so this recipe supplies only the job and leaves the existing ambiguous-discriminator
// refusal to fire exactly as it does with no recipe at all, unless the caller or the planner names
// referenceKind. See this module's header and the mutation-checked test covering this behaviour.
const reference = recipe(
  "reference",
  "A single-section FAQ/help/process reference page. Declares only the job (faq_help_process) — referenceKind (faq vs process) is left to the caller or the planner; a section with neither still refuses by name.",
  [
    {
      order: 0,
      job: "faq_help_process",
      purpose: "Answer the questions or walk through the process visitors most often need.",
      mustEstablish: ["what the visitor needs to know"]
    }
  ]
);

const evidenceStory = recipe(
  "evidence_story",
  "A single-section evidence/story page — evidence_story is not ambiguous (siteContentDraftingExecutor.ts routes it to a fixed referenceKind), so this recipe declares no discriminator.",
  [
    {
      order: 0,
      job: "evidence_story",
      purpose: "Tell a concrete, sourced story of impact or outcome.",
      mustEstablish: ["what happened", "the outcome"]
    }
  ]
);

const revision = recipe(
  "revision",
  "A single-section focused revision of existing copy against a supplied brief.",
  [
    {
      order: 0,
      job: "focused_revision",
      purpose: "Revise the existing copy against the supplied brief.",
      mustEstablish: []
    }
  ]
);

const localization = recipe(
  "localization",
  "A single-section localization of existing copy for a target locale (targetLocale is supplied via supplements, not this recipe).",
  [
    {
      order: 0,
      job: "localization",
      purpose: "Localize the existing copy for the target locale.",
      mustEstablish: []
    }
  ]
);

// ---------------------------------------------------------------------------------------------
export const SITE_CONTENT_PAGE_RECIPES: Readonly<Record<string, SiteContentPageRecipe>> = Object.freeze({
  organization_page: organizationPage,
  people_profiles: peopleProfiles,
  documentation_page: documentationPage,
  offering,
  program_event: programEvent,
  reference,
  evidence_story: evidenceStory,
  revision,
  localization
});

export const SITE_CONTENT_PAGE_RECIPE_NAMES: readonly string[] = Object.freeze(Object.keys(SITE_CONTENT_PAGE_RECIPES));

/** Looks up a recipe by name. Returns `undefined` for an unknown name — callers refuse by name, listing SITE_CONTENT_PAGE_RECIPE_NAMES; this module never silently ignores an unknown name itself. */
export function getPageRecipe(name: string): SiteContentPageRecipe | undefined {
  return SITE_CONTENT_PAGE_RECIPES[name];
}
