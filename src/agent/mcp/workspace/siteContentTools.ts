import { z } from "zod";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import { runSiteContentDrafting, type SiteContentDraftingDeps, type SiteContentDraftingSupplement } from "../../operations/siteContentDraftingExecutor.js";
import { objectSchema, ok, tool, WorkspaceToolError, type WorkspaceTool } from "./toolKit.js";
import { compileSiteContentObjects, type DraftedSectionInput } from "../../operations/siteContentObjectCompiler.js";
import { applySiteContentPlan, type ApplyJournal, type SiteObjectWriter } from "../../operations/siteContentObjectApplier.js";
import { getSiteSnapshot, type SiteContextSource } from "../../operations/siteContext.js";
import { createSiteContextSourceAdapter } from "../../operations/siteContextSourceAdapter.js";
import { createPlatformSiteObjectWriter } from "../../projects/platformSiteObjectWriter.js";
import { invokeTenantTool } from "../../tools/tenantInvoke.js";
import { BlobApplyJournalRepository } from "../../repository/blobs/BlobApplyJournalRepository.js";

// site_content.draft_page -- THE ONE narrow, site-scoped door to the site-content specialist roster
// (siteContentSpecialistNodes.ts). Same shape as visual_identity.propose (visualIdentityTools.ts),
// and for the same reason (that file's own RULING R1, 2026-09-04): `node_execute` is
// workspace-PROGRAMMING scope and must never be widened to a site token, so a tenant-reachable
// capability gets its own narrow tool instead. This one has no `nodeId` on the wire at all -- it
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
// modelConfigOverride lever -- the C4 brief scopes this task to job-based routing, not site-context
// parity with the visual identity path. A caller who wants the planner or a writer grounded in real
// site content passes it explicitly via `existingContent`/`siteContext`/`voice`/`supplements`; there
// is no implicit fetch here. Left as a named gap for a follow-up rather than silently assumed.
//
// SHIP PATH (see visualIdentityTools.ts's own header for the full precedent): this file, wired into
// createWorkspaceTools (tools.ts) so it is reachable at all + adding its wire name to
// SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts) + `npm run scope:update` + a reconciler run with
// `--apply` to re-mint existing tenants. This change ships the first half only -- see the C4 commit
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
  // copy to revise, a target locale, an explicit offeringKind/referenceKind/job override) -- see
  // SiteContentDraftingSupplement in the executor. Keyed by `order` because that is the plan's only
  // stable per-section identifier.
  supplements: z.array(supplementSchema).max(60).optional(),
  // A named page-shape declaration (siteContentPageRecipes.ts) -- see the JSON Schema description
  // below for the plain-language rules this parameter follows.
  pageRecipe: z.string().min(1).optional()
}).strict();

const siteContentDraftPageJsonSchema = objectSchema({
  project_id: { type: "string", minLength: 1, maxLength: 63, description: "The caller's own project. A scoped bearer may only name a project in its own policy." },
  brief: { type: "object", description: "The page's purpose, audience and any constraints -- handed to site_content_planner verbatim, and folded (plus each section's own purpose/mustEstablish) into every writer's brief." },
  existingContent: { type: "array", maxItems: 200, items: { type: "object" }, description: "An inventory of content that already exists for this site/page -- titles, section types, summaries. Read by the planner as evidence of what is already established." },
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
            "Paired to a plan section once, for the whole call, and only by a reading that accounts for EVERY supplement you supplied: if every `order` here matches a returned section's own `order`, all are matched by `order` (use this on a re-draft, once you have seen the plan's real orders); otherwise, if every `order` here is a valid 0-based POSITION in the plan's returned section array, all are read as positions (use this on a first draft, before you know the planner's numbering -- supply 0, 1, 2, ... for the sections in the order you expect them). If neither reading fits every supplement, the call is REFUSED as ambiguous before any section is drafted -- no partial pairing, because a partial pairing would attach your content to the wrong section or drop it. The refusal still returns the plan, names the orders it actually returned, and reports every supplement as a `supplement_unmatched` outcome, so you can re-key on the real orders and call again."
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
      "Names a page kind's pre-declared shape (e.g. \"organization_page\", \"offering\", \"reference\") -- see siteContentPageRecipes.ts for the full list. Optional: omitting it leaves routing exactly as it is without one. Recipe sections pair with the plan's returned sections BY POSITION -- the recipe's 1st declared section with the plan's 1st returned section, its 2nd with the plan's 2nd, and so on -- never against the planner's own `order` value, since the recipe is authored before any plan exists and cannot know that numbering. A recipe only ever SUPPLIES a section's job (and, for the jobs that need one, its discriminator) when neither this call's own `supplements` nor the plan's own section already said so -- it never overrides what you or the plan stated. If the plan returns fewer sections than the recipe declares, the undelivered recipe entries are reported as their own outcome, never dropped. Naming an unrecognized recipe is refused by name, listing the known ones, never silently ignored."
  }
}, ["project_id", "brief"]);

export type SiteContentToolDeps = {
  projectRepository: ProjectRepository;
  /** Injection seam for tests only -- see runSiteContentDrafting's own executeNodeImpl seam. */
  executeNodeImpl?: SiteContentDraftingDeps["executeNodeImpl"];
  /** Injection seam for tests only. Production builds the read-only tenant adapter below. */
  siteContextSource?: SiteContextSource;
  /**
   * Injection seam for tests ONLY -- see site_content.apply_page_objects's own header for why
   * production never gets to construct a writer any other way than through the tenant's own
   * objectDialect + the audited tenant-call door. A test that supplies this bypasses BOTH.
   */
  siteObjectWriter?: SiteObjectWriter;
  /** Injection seam for tests only. Production uses BlobApplyJournalRepository. */
  applyJournal?: ApplyJournal;
};

const compileDraftedSectionSchema = z.object({
  order: z.number().int().min(0),
  sectionType: z.string().min(1),
  draft: z.record(z.string(), z.unknown()),
  runId: z.string().min(1).nullable().optional(),
  executionId: z.string().min(1).nullable().optional()
}).strict();

const siteContentCompilePageObjectsInput = z.object({
  project_id: z.string().min(1),
  drafted: z.array(compileDraftedSectionSchema).min(1),
  page: z.object({
    objectId: z.string().min(1).nullable().optional(),
    fields: z.record(z.string(), z.unknown()),
    // Existing INLINE section ids on the target page to revise, keyed by planner order -- never a
    // standalone `section` object id. See PageMaterializationPlan's own header for why sections are
    // no longer separate objects.
    sectionTargets: z.record(z.string(), z.string().min(1)).optional(),
    expectedPageContentRevision: z.number().int().min(0).optional()
  }).strict()
}).strict();

const siteContentCompilePageObjectsJsonSchema = objectSchema({
  project_id: { type: "string", minLength: 1 },
  drafted: {
    type: "array",
    minItems: 1,
    description: "The `drafted` outcomes from a site_content.draft_page result -- order, sectionType, draft, and that dispatch's runId/executionId.",
    items: objectSchema({
      order: { type: "integer", minimum: 0 },
      sectionType: { type: "string", minLength: 1 },
      draft: { type: "object", description: "The specialist's own output for this section, unmodified." },
      runId: { type: ["string", "null"] },
      executionId: { type: ["string", "null"] }
    }, ["order", "sectionType", "draft"])
  },
  page: objectSchema({
    objectId: { type: ["string", "null"], description: "The page to revise; omit or null to compile a new page." },
    fields: { type: "object", description: "The page object's own top-level fields (pageType, slug, title, …) -- NEVER `sections`, which is derived from `drafted` and `sectionTargets`. Validated against this tenant's page contract. Never defaulted here." },
    sectionTargets: { type: "object", description: "Existing INLINE section ids (from the target page's own current `sections` array) to revise, keyed by the planner order they correspond to. An order absent from this map compiles a new inline section." },
    expectedPageContentRevision: { type: "integer", minimum: 0, description: "What you believe the page's contentRevision is. A page's content_revision covers its whole body, sections included, so one guard here is the whole check. A mismatch is refused as stale_target rather than applied." }
  }, ["fields"])
}, ["project_id", "drafted", "page"]);

// site_content.apply_page_objects -- the writer half of P2, and DELIBERATELY NOT YET REACHABLE by any
// tenant. It takes the identical (project_id, drafted, page) shape compile_page_objects takes,
// recompiles the plan against a FRESH snapshot (never a client-supplied plan object -- a plan is a
// point-in-time claim, and applying one a caller held onto past its own snapshot is exactly the
// staleness compileSiteContentObjects's `stale_target` check exists to catch, which only means
// anything if the compile happens NOW, not whenever the caller last compiled), and applies it through
// applySiteContentPlan (siteContentObjectApplier.ts) against the REAL tenant, via
// platformSiteObjectWriter.ts over the audited "one door" every other engine tenant call already
// goes through (tools/tenantInvoke.ts's invokeTenantTool) -- never a second, hand-rolled transport.
//
// SAME SHIP-PATH PRECEDENT AS site_content.draft_page (see that tool's own header): being wired into
// createWorkspaceTools (tools.ts) makes this tool reachable on a FULL bearer only. It is NOT added to
// SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts): granting a tenant's own scoped chat bearer the power to
// create/patch its own pages is a reviewed operator decision with its own credential consequences
// (AGENTS.md rule 5) -- `npm run scope:update` plus a reconciler `--apply` run -- and is not taken here.
// Until that decision is made, this tool exists so the capability is exercisable (by an operator, a
// test, or a future workflow node) without every caller hand-assembling compile + apply themselves.
function createApplyPageObjectsTool(projectRepository: ProjectRepository, deps: { siteContextSource?: SiteContextSource; siteObjectWriter?: SiteObjectWriter; applyJournal?: ApplyJournal }): WorkspaceTool {
  return tool({
    name: "site_content.apply_page_objects",
    description:
      "Compile a site_content.draft_page result against the CURRENT tenant state and apply the resulting page materialization plan -- the write that site_content.compile_page_objects only previews. Same ALL-OR-NOTHING refusal set as compile_page_objects (see that tool's description), plus `unsupported_shared_section_mutation` for a patch target that names a shared/standalone section rather than one of the page's own inline sections. On success this makes exactly ONE tenant write: a page create (sections inline in the body) or a page patch (one object_patch call carrying the named ops set_page_meta/upsert_section/update_section_data -- never N separate writes). Every write is journalled before it is attempted and read back afterward; replaying the identical request finds a complete journal and writes nothing (`outcome: \"already_applied\"`). `outcome: \"blocked_indeterminate\"` means a previous attempt's create outcome is unknown and a human must check the tenant (object_inventory) before retrying. A retry that reuses a materializationKey but carries a DIFFERENT payload is refused (`outcome: \"not_applied\"`, failure code `plan_payload_changed`) rather than answered \"already_applied\": the key names the operation, not its content, and silently dropping a changed payload would report success for a write that never happened. This tool is not exposed to any tenant's scoped chat bearer -- see this file's own comment above for why.",
    zodSchema: siteContentCompilePageObjectsInput,
    inputSchema: siteContentCompilePageObjectsJsonSchema,
    execute: async (input) => {
      const data = siteContentCompilePageObjectsInput.parse(input);

      const project = await projectRepository.get(data.project_id);
      if (!project) throw new WorkspaceToolError("unknown_project", `No registered project matches "${data.project_id}".`, { projectId: data.project_id });
      if (project.status === "provisioning") throw new WorkspaceToolError("project_provisioning", `Project "${data.project_id}" is still provisioning: its genesis did not complete. Re-run site.duplicate to finish the mint.`, { projectId: data.project_id });
      if (project.status !== "active") throw new WorkspaceToolError("project_disabled", `Project "${data.project_id}" is disabled.`, { projectId: data.project_id });

      const source = deps.siteContextSource ?? createSiteContextSourceAdapter({ projectRepository });
      let snapshot;
      try {
        snapshot = await getSiteSnapshot(source, { tenantId: data.project_id, objectTypes: ["page", "section"] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkspaceToolError("site_snapshot_unavailable", `Could not read "${data.project_id}"'s current pages and sections, so no compilation was attempted: ${message}`, { projectId: data.project_id });
      }

      const sectionTargets: Record<number, string> = {};
      for (const [order, objectId] of Object.entries(data.page.sectionTargets ?? {})) {
        const parsed = Number(order);
        if (!/^\d+$/.test(order) || !Number.isInteger(parsed) || String(parsed) !== order) {
          throw new WorkspaceToolError("invalid_section_target_key", `sectionTargets key "${order}" is not a section order. Keys are the planner's own order values.`, { projectId: data.project_id, key: order });
        }
        sectionTargets[parsed] = objectId;
      }

      const compileResult = compileSiteContentObjects({
        projectId: data.project_id,
        drafted: data.drafted as DraftedSectionInput[],
        snapshot,
        target: {
          pageObjectId: data.page.objectId ?? null,
          pageFields: data.page.fields,
          sectionTargets,
          ...(data.page.expectedPageContentRevision !== undefined ? { expectedPageContentRevision: data.page.expectedPageContentRevision } : {})
        }
      });
      if (!compileResult.ok) return ok({ compiled: false, applied: false, blockers: compileResult.blockers, snapshotDigest: snapshot.digest, revisionId: snapshot.revisionId });

      const writer =
        deps.siteObjectWriter ??
        (() => {
          const siteObjectId = project.objectDialect?.siteObjectId;
          if (!siteObjectId) {
            throw new WorkspaceToolError(
              "missing_object_dialect",
              `Project "${data.project_id}" declares no objectDialect.siteObjectId, which object_create's required \`site\` argument needs. Refusing to guess it.`,
              { projectId: data.project_id }
            );
          }
          const call = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
            const invoked = await invokeTenantTool({ projectId: data.project_id, toolId: toolName, caller: "engine", args, project });
            if (invoked.ok) return invoked.result;
            // A held-for-approval verb or any other adapter-level refusal is surfaced as a plain
            // error, which platformSiteObjectWriter.ts's own callers already treat as a hard stop --
            // never as an MCP isError result (isMcpErrorResult would look at the WRONG envelope
            // here; invoked.error is this door's own refusal, not the tenant's).
            throw new Error(invoked.error ?? `${toolName}_call_failed`);
          };
          return createPlatformSiteObjectWriter({ call, siteObjectId });
        })();
      const journal = deps.applyJournal ?? new BlobApplyJournalRepository();

      const applyResult = await applySiteContentPlan(compileResult.plan, { writer, journal });
      return ok({ compiled: true, applied: applyResult.outcome === "applied" || applyResult.outcome === "already_applied", plan: compileResult.plan, result: applyResult, snapshotDigest: snapshot.digest, revisionId: snapshot.revisionId });
    }
  });
}

export function createSiteContentTools({ projectRepository, executeNodeImpl, siteContextSource, siteObjectWriter, applyJournal }: SiteContentToolDeps): WorkspaceTool[] {
  return [
    tool({
      name: "site_content.draft_page",
      description:
        "Plan one page's sections (site_content_planner) and draft each section's copy by dispatching the specialist its planned job names -- organization/people narrative, product/service/program/event descriptions, FAQ/process/policy/evidence-story reference content, or a focused revision/localization. No nodeId on the wire; routing is a fixed, in-source table keyed on each section's job. `supplements[].order` is read either as the plan's own returned `order` values (a re-draft) or as 0-based positions in the plan's returned sections (a first draft) -- whichever accounts for every supplement you supplied; if neither does, the call is refused as ambiguous before anything is drafted rather than pairing some and dropping the rest. The result reports which reading was used (`supplementMatching`) and reports any unmatched supplement as its own outcome, never silently dropping it. Optionally name a `pageRecipe` (e.g. \"organization_page\", \"offering\") whose sections pair with the plan's returned sections by position, to supply a section's job/discriminator when neither your `supplements` nor the plan itself already named one -- a recipe never overrides what you or the plan stated, and an unrecognized name is refused, listing the known ones. Writes nothing to your site: every draft comes back for an approval surface, and a section whose job is ambiguous (product vs service, program vs event, faq vs process) with no discriminator supplied is refused by name rather than guessed. The result also carries the planner's own run/execution ids (`plannerRunId`/`plannerExecutionId`, present even when a supplement-pairing refusal returns early, since the planner has already run by then) and, on every drafted or dispatch-refused section outcome, that section's own dispatch's `runId`/`executionId` -- so a caller can look a run up afterwards (workflow.get_run, node.list_executions) or check its cost (workflow.get_run_cost). A `null` id means the identifier was not available on that dispatch's result, not that no run happened; a section refused before any node was dispatched (an unknown job, a missing ambiguous discriminator) always reports `null` for both, since no dispatch ever occurred.",
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
    }),
    // P2 -- the review surface between a drafted page and a site that has one. READ-ONLY: it captures
    // a snapshot through the read-only tenant adapter (siteContextSourceAdapter.ts, whose transport
    // physically cannot reach a write verb) and compiles. It writes nothing, applies nothing, and
    // grants nothing -- what comes back is a change set an operator can read BEFORE anything exists.
    //
    // DELIBERATELY NOT in SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts). This is an operator review
    // surface on the workspace plane, so it needs no tenant re-mint and no reconciler --apply to be
    // useful; exposing it to every tenant's client_manager is a separate decision with its own
    // credential consequences, and is not taken here.
    tool({
      name: "site_content.compile_page_objects",
      description:
        "Compile a site_content.draft_page result into the ONE page-level write it would become -- read-only, and the step BEFORE anything is written. Platform's real page contract stores sections INLINE in the page body (never as separate section objects, except a rare shared_ref this tool refuses to touch by name), so the returned plan carries exactly one write: a page create with sections inline in the body, or a page patch carrying an ops array (set_page_meta / upsert_section / update_section_data -- the exact named ops Platform's own object_patch(page) accepts). Per-section provenance (which drafted section became which op, its component type, its source run/execution id) travels alongside for the operator record, separate from the write itself. Also returns a `materializationKey` and a `schemaVersion` (\"site-page-materialization.v2\"): replaying the same drafts against the same target produces the identical key, so a duplicate request is recognisable rather than a second page. ALL OR NOTHING: if any section cannot be compiled -- an FAQ draft with no question/answer items, a process draft with no ordered steps, a section type the tenant's page contract does not register, a section type registered with `component_bound: false` (unplaceable -- it has no bound component and no region), a section the declared pageType's own `allowedSections` law forbids or a `requiredSections` entry the page would lack, any of the five required page fields (route, pageType, title, seo, sections) left unsupplied, a `tracking` or `sections` key smuggled in through pageFields, a preallocated section id that does not match `^s_[a-z0-9]+$` or is supplied for only some units, a change naming an object beyond this one page, a patch target whose page contentRevision has moved since the request was prepared, a patch target that names a shared/standalone section rather than one of the page's own inline sections, drafts belonging to another tenant -- the whole call is refused with named blockers and no partial plan, because a half-built page is the damage an operator cannot see. REVISING an existing page's sections is refused by name (`page_revise_path_unsupported`), as is a patch whose page row carries no body (`page_body_unavailable_for_patch`) -- the production snapshot base is object_inventory's summary listing, which carries no sections, so a revise compiled against it would append a duplicate of every section the page already holds; giving the compiler a real patch base is tracked as its own task. Compiling is not applying: nothing here saves, applies, publishes or releases, and the returned plan authorizes none of those.",
      zodSchema: siteContentCompilePageObjectsInput,
      inputSchema: siteContentCompilePageObjectsJsonSchema,
      execute: async (input) => {
        const data = siteContentCompilePageObjectsInput.parse(input);

        const project = await projectRepository.get(data.project_id);
        if (!project) throw new WorkspaceToolError("unknown_project", `No registered project matches "${data.project_id}".`, { projectId: data.project_id });
        if (project.status === "provisioning") throw new WorkspaceToolError("project_provisioning", `Project "${data.project_id}" is still provisioning: its genesis did not complete. Re-run site.duplicate to finish the mint.`, { projectId: data.project_id });
        if (project.status !== "active") throw new WorkspaceToolError("project_disabled", `Project "${data.project_id}" is disabled.`, { projectId: data.project_id });

        const source = siteContextSource ?? createSiteContextSourceAdapter({ projectRepository });
        let snapshot;
        try {
          snapshot = await getSiteSnapshot(source, { tenantId: data.project_id, objectTypes: ["page", "section"] });
        } catch (error) {
          // A snapshot that could not be read is reported as exactly that. It is never compiled
          // against an empty one -- an absent contract would read as "this tenant supports nothing",
          // and an absent object list would turn every patch target into a create.
          const message = error instanceof Error ? error.message : String(error);
          throw new WorkspaceToolError("site_snapshot_unavailable", `Could not read "${data.project_id}"'s current pages and sections, so no compilation was attempted: ${message}`, { projectId: data.project_id });
        }

        // Section targets arrive keyed by order as JSON object keys (strings); the compiler keys
        // them by the planner's numeric order.
        const sectionTargets: Record<number, string> = {};
        for (const [order, objectId] of Object.entries(data.page.sectionTargets ?? {})) {
          // Canonical decimal only. `Number(\"04\")` and `Number(\"4\")` are the same number, so a
          // caller sending both would have one target silently overwrite the other; a key that is
          // not the plain decimal spelling of its own order is refused instead.
          const parsed = Number(order);
          if (!/^\d+$/.test(order) || !Number.isInteger(parsed) || String(parsed) !== order) {
            throw new WorkspaceToolError("invalid_section_target_key", `sectionTargets key "${order}" is not a section order. Keys are the planner's own order values.`, { projectId: data.project_id, key: order });
          }
          sectionTargets[parsed] = objectId;
        }

        const result = compileSiteContentObjects({
          projectId: data.project_id,
          drafted: data.drafted as DraftedSectionInput[],
          snapshot,
          target: {
            pageObjectId: data.page.objectId ?? null,
            pageFields: data.page.fields,
            sectionTargets,
            ...(data.page.expectedPageContentRevision !== undefined ? { expectedPageContentRevision: data.page.expectedPageContentRevision } : {})
          }
        });

        // A refusal is a RESULT, not a thrown error: the blockers are the useful part, each naming
        // what is wrong and what would fix it, and a caller should read them rather than a message.
        if (!result.ok) return ok({ compiled: false, blockers: result.blockers, snapshotDigest: snapshot.digest, revisionId: snapshot.revisionId });
        return ok({ compiled: true, plan: result.plan, snapshotDigest: snapshot.digest, revisionId: snapshot.revisionId });
      }
    }),
    createApplyPageObjectsTool(projectRepository, { siteContextSource, siteObjectWriter, applyJournal })
  ];
}
