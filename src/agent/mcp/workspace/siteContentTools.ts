import { z } from "zod";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import { runSiteContentDrafting, type SiteContentDraftingDeps, type SiteContentDraftingSupplement } from "../../operations/siteContentDraftingExecutor.js";
import { objectSchema, ok, tool, WorkspaceToolError, type WorkspaceTool } from "./toolKit.js";

// site_content.draft_page — THE ONE narrow, site-scoped door to the site-content specialist roster
// (siteContentSpecialistNodes.ts). Same shape as visual_identity.propose (visualIdentityTools.ts),
// and for the same reason (that file's own RULING R1, 2026-09-04): `node_execute` is
// workspace-PROGRAMMING scope and must never be widened to a site token, so a tenant-reachable
// capability gets its own narrow tool instead. This one has no `nodeId` on the wire at all — it
// dispatches through runSiteContentDrafting (operations/siteContentDraftingExecutor.ts), which
// resolves EVERY node it calls (site_content_planner, plus one specialist per section) from a
// fixed, in-source routing table keyed on the planner's own declared `job`, never from a
// caller-supplied id.
//
// NO WRITES TO THE CLIENT. Every node this reaches has allowedTools that are read-only by
// construction (siteContentSpecialistNodes.ts) and the executor itself calls none of
// object_create/object_patch/object_publish/project.call_tool (see that module's own header and its
// test's source-grep assertion). What comes back is drafts for an approval surface, never a write.
//
// DELIBERATELY NARROWER THAN visual_identity.propose. No sitePrefetch/voicePrefetch wiring and no
// modelConfigOverride lever — the C4 brief scopes this task to job-based routing, not site-context
// parity with the visual identity path. A caller who wants the planner or a writer grounded in real
// site content passes it explicitly via `existingContent`/`siteContext`/`voice`/`supplements`; there
// is no implicit fetch here. Left as a named gap for a follow-up rather than silently assumed.
//
// SHIP PATH (see visualIdentityTools.ts's own header for the full precedent): this file, wired into
// createWorkspaceTools (tools.ts) so it is reachable at all + adding its wire name to
// SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts) + `npm run scope:update` + a reconciler run with
// `--apply` to re-mint existing tenants. This change ships the first half only — see the C4 commit
// message.

export const SITE_CONTENT_DRAFT_PAGE_TOOL = "site_content_draft_page";

const supplementSchema = z.object({
  order: z.number().int().min(0),
  brief: z.record(z.string(), z.unknown()).optional(),
  facts: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  sourceMaterial: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  existingCopy: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  targetLocale: z.string().min(1).optional(),
  offeringKind: z.enum(["product", "service", "program", "event"]).optional(),
  referenceKind: z.enum(["faq", "process", "policy", "evidence_story"]).optional(),
  voice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  job: z.string().min(1).nullable().optional()
}).strict();

export const siteContentDraftPageInput = z.object({
  project_id: z.string().min(1).max(63),
  brief: z.record(z.string(), z.unknown()),
  existingContent: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
  siteContext: z.record(z.string(), z.unknown()).optional(),
  voice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  // Per-section content this tool has no way to originate itself (facts, source material, existing
  // copy to revise, a target locale, an explicit offeringKind/referenceKind/job override) — see
  // SiteContentDraftingSupplement in the executor. Keyed by `order` because that is the plan's only
  // stable per-section identifier.
  supplements: z.array(supplementSchema).max(60).optional(),
  // A named page-shape declaration (siteContentPageRecipes.ts) — see the JSON Schema description
  // below for the plain-language rules this parameter follows.
  pageRecipe: z.string().min(1).optional()
}).strict();

const siteContentDraftPageJsonSchema = objectSchema({
  project_id: { type: "string", minLength: 1, maxLength: 63, description: "The caller's own project. A scoped bearer may only name a project in its own policy." },
  brief: { type: "object", description: "The page's purpose, audience and any constraints — handed to site_content_planner verbatim, and folded (plus each section's own purpose/mustEstablish) into every writer's brief." },
  existingContent: { type: "array", maxItems: 200, items: { type: "object" }, description: "An inventory of content that already exists for this site/page — titles, section types, summaries. Read by the planner as evidence of what is already established." },
  siteContext: { type: "object", description: "Site-level facts (name, kind, voice) relevant to what this page should establish." },
  voice: { type: ["string", "object"], description: "The site's editorial voice, when known. Overridable per section via supplements[].voice." },
  supplements: {
    type: "array",
    maxItems: 60,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["order"],
      properties: {
        order: {
          type: "integer",
          minimum: 0,
          description:
            "Paired to a plan section once, for the whole call, and only by a reading that accounts for EVERY supplement you supplied: if every `order` here matches a returned section's own `order`, all are matched by `order` (use this on a re-draft, once you have seen the plan's real orders); otherwise, if every `order` here is a valid 0-based POSITION in the plan's returned section array, all are read as positions (use this on a first draft, before you know the planner's numbering — supply 0, 1, 2, ... for the sections in the order you expect them). If neither reading fits every supplement, the call is REFUSED as ambiguous before any section is drafted — no partial pairing, because a partial pairing would attach your content to the wrong section or drop it. The refusal still returns the plan, names the orders it actually returned, and reports every supplement as a `supplement_unmatched` outcome, so you can re-key on the real orders and call again."
        },
        brief: { type: "object" },
        facts: { type: "array", items: {} },
        sourceMaterial: { type: "array", items: {} },
        existingCopy: { type: ["string", "object"] },
        targetLocale: { type: "string", minLength: 1 },
        offeringKind: { type: "string", enum: ["product", "service", "program", "event"] },
        referenceKind: { type: "string", enum: ["faq", "process", "policy", "evidence_story"] },
        voice: { type: ["string", "object"] },
        job: { type: ["string", "null"], description: "Overrides the plan section's own contentRequirement.job for this dispatch." }
      }
    },
    description: "Per-section content this tool cannot originate itself, keyed by the plan section's `order`."
  },
  pageRecipe: {
    type: "string",
    minLength: 1,
    description:
      "Names a page kind's pre-declared shape (e.g. \"organization_page\", \"offering\", \"reference\") — see siteContentPageRecipes.ts for the full list. Optional: omitting it leaves routing exactly as it is without one. Recipe sections pair with the plan's returned sections BY POSITION — the recipe's 1st declared section with the plan's 1st returned section, its 2nd with the plan's 2nd, and so on — never against the planner's own `order` value, since the recipe is authored before any plan exists and cannot know that numbering. A recipe only ever SUPPLIES a section's job (and, for the jobs that need one, its discriminator) when neither this call's own `supplements` nor the plan's own section already said so — it never overrides what you or the plan stated. If the plan returns fewer sections than the recipe declares, the undelivered recipe entries are reported as their own outcome, never dropped. Naming an unrecognized recipe is refused by name, listing the known ones, never silently ignored."
  }
}, ["project_id", "brief"]);

export type SiteContentToolDeps = {
  projectRepository: ProjectRepository;
  /** Injection seam for tests only — see runSiteContentDrafting's own executeNodeImpl seam. */
  executeNodeImpl?: SiteContentDraftingDeps["executeNodeImpl"];
};

export function createSiteContentTools({ projectRepository, executeNodeImpl }: SiteContentToolDeps): WorkspaceTool[] {
  return [
    tool({
      name: "site_content.draft_page",
      description:
        "Plan one page's sections (site_content_planner) and draft each section's copy by dispatching the specialist its planned job names — organization/people narrative, product/service/program/event descriptions, FAQ/process/policy/evidence-story reference content, or a focused revision/localization. No nodeId on the wire; routing is a fixed, in-source table keyed on each section's job. `supplements[].order` is read either as the plan's own returned `order` values (a re-draft) or as 0-based positions in the plan's returned sections (a first draft) — whichever accounts for every supplement you supplied; if neither does, the call is refused as ambiguous before anything is drafted rather than pairing some and dropping the rest. The result reports which reading was used (`supplementMatching`) and reports any unmatched supplement as its own outcome, never silently dropping it. Optionally name a `pageRecipe` (e.g. \"organization_page\", \"offering\") whose sections pair with the plan's returned sections by position, to supply a section's job/discriminator when neither your `supplements` nor the plan itself already named one — a recipe never overrides what you or the plan stated, and an unrecognized name is refused, listing the known ones. Writes nothing to your site: every draft comes back for an approval surface, and a section whose job is ambiguous (product vs service, program vs event, faq vs process) with no discriminator supplied is refused by name rather than guessed. The result also carries the planner's own run/execution ids (`plannerRunId`/`plannerExecutionId`, present even when a supplement-pairing refusal returns early, since the planner has already run by then) and, on every drafted or dispatch-refused section outcome, that section's own dispatch's `runId`/`executionId` — so a caller can look a run up afterwards (workflow.get_run, node.list_executions) or check its cost (workflow.get_run_cost). A `null` id means the identifier was not available on that dispatch's result, not that no run happened; a section refused before any node was dispatched (an unknown job, a missing ambiguous discriminator) always reports `null` for both, since no dispatch ever occurred.",
      zodSchema: siteContentDraftPageInput,
      inputSchema: siteContentDraftPageJsonSchema,
      execute: async (input) => {
        const data = siteContentDraftPageInput.parse(input);

        const project = await projectRepository.get(data.project_id);
        if (!project) throw new WorkspaceToolError("unknown_project", `No registered project matches "${data.project_id}".`, { projectId: data.project_id });
        if (project.status === "provisioning") throw new WorkspaceToolError("project_provisioning", `Project "${data.project_id}" is still provisioning: its genesis did not complete. Re-run site.duplicate to finish the mint.`, { projectId: data.project_id });
        if (project.status !== "active") throw new WorkspaceToolError("project_disabled", `Project "${data.project_id}" is disabled.`, { projectId: data.project_id });

        try {
          const result = await runSiteContentDrafting(
            {
              projectId: data.project_id,
              brief: data.brief,
              existingContent: data.existingContent,
              siteContext: data.siteContext,
              voice: data.voice,
              supplements: data.supplements as SiteContentDraftingSupplement[] | undefined,
              pageRecipe: data.pageRecipe
            },
            { executeNodeImpl }
          );
          return ok({ result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new WorkspaceToolError("site_content_draft_failed", message, { projectId: data.project_id });
        }
      }
    })
  ];
}
