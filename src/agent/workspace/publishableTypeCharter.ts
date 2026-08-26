// T15.11 (2026-08-25, #190; ADR-2026-08-25-publish-autonomy §6.3) — the publishable-type CHARTER:
// which governed object types each workflow may push through the shared publish segment's
// object-scoped self-check (objectPublishExecution.ts buildObjectPublishPlan).
//
// THE THREE PLACES THIS LIVES, per the ADR's own framing:
//   1. DECLARED here, on the composition — one row per registered workflowId, code-defined exactly
//      like workflowRegistry.ts's own per-workflow table, never a project-patchable field (a tenant
//      does not get to widen what a workflow may author).
//   2. SNAPSHOTTED onto the run at creation (executor.ts capturePublishingPolicySnapshot) into
//      run.publishingPolicySnapshot.publishableTypes — never re-resolved live. A mid-run charter edit
//      (a code change landing while a run is in flight, or a redeploy between two ticks of the same
//      run) must not change what an ALREADY-CREATED run is permitted to publish — the same
//      determinism argument §2.5 makes for autonomyMode (invariant 7: two runs of the same URL resolve
//      identically). buildObjectPublishPlan therefore never imports this module — it only accepts a
//      `publishableTypes` set handed to it by the caller, which is the run's own snapshot.
//   3. ENFORCED in publish_payload (objectPublishExecution.buildObjectPublishPlan) — an object whose
//      type is outside the resolved set is WITHHELD, named, with a reason that states the boundary.
//      Reject, never coerce, never a silent drop — the same posture buildObjectPublishPlan already
//      takes for a validation failure or a quarantine.
//
// PUBLISHING_CONDUCTOR'S EXCLUSION IS DELIBERATE AND LOAD-BEARING. It is NOT an oversight this task
// widens away: ADR-2026-08-25-structure-studio §2.2 names this publish-time allowlist as one of THREE
// independent enforcement points for "copy workflows never author structure" (alongside the
// tool-permission audit and the runtime write guard, both T15.29/#205's job, not this file's). A
// change that widens publishing_conductor's set to include a recipe type defeats a load-bearing
// invariant and must not be made here without its own ADR.
//
// WHAT publish.mjs ARGUED, AND WHERE THAT ARGUMENT NOW LIVES. `src/agent/capture/engine/publish.mjs`
// (deleted T15.7/#187) hardcoded PUBLISHABLE_TYPES = {page, navigation} with the reasoning that a
// theme or section_template is a recipe and "publishing a recipe is a deliberate studio act, not a
// side effect of cloning a page." ADR-2026-08-25-publish-autonomy §6.3 UPHOLDS that reasoning and
// RELOCATES it, rather than overturning it: clone_conductor IS the studio (structure-studio ADR §1),
// so a recipe publish is a deliberate act OF THAT WORKFLOW — chartered below for clone_conductor. And
// capture_conductor's own emit_live stage is itself the deliberate act of MINTING the theme/site/
// section_template objects a capture run binds — publishing what that stage minted is not a side
// effect of a page-scoped publish loop, it is that same deliberate act completed, which is why T15.11
// widens capture's charter rather than adding a third workflow that reaches these types.

// The object types data the site reads at build time, shared across pages (structure-studio ADR
// §2.1's "recipe" line) — never authored by a copy workflow, per that ADR's boundary.
//
// T15.10 (#189) — "page template" (ADR prose, two words) is `"template"` on the wire, not
// `"page_template"`: the object model's own INVENTORY_TYPES (cloneEngine.ts) and every create op
// engine/clone.mjs emits use `objectType: "template"` for a page recipe (`"section_template"` is the
// only compound name that is real). This constant originally said `"page_template"`, a string that
// exists nowhere else in this codebase or platform's — a page-template mint would have minted
// correctly and then been withheld at publish_payload forever, `type_not_publishable` against a type
// nothing ever creates. Fixed here because #189 is what first drives an object of this type through
// buildObjectPublishPlan; declaring a charter for a type that cannot occur is not "inert until wired",
// it is silently wrong the moment it is wired.
import type { WorkspaceNode } from "./nodeTypes.js";

export const RECIPE_OBJECT_TYPES = ["theme", "site", "section_template", "template"] as const;
export type RecipeObjectType = (typeof RECIPE_OBJECT_TYPES)[number];

export type PublishableTypeCharter = {
  workflowId: string;
  // The object types this workflow may publish through buildObjectPublishPlan. Order is not
  // significant; callers that need a stable rendering sort it themselves.
  publishableTypes: readonly string[];
  // Quotable in a refusal's detail / a receipt's notes — states the boundary, not just the set.
  rationale: string;
};

// T15.32 (#208; ADR-2026-08-25-structure-studio §5.2) — THE COPY-WORKFLOW CONTRACT for discovering
// structure, stated once so it is not re-derived per call site: publishing_conductor (and any future
// copy workflow) never authors a structure, per the boundary this charter enforces below — it
// SELECTS one that already exists. "Which ones exist" has exactly two sources, never a guess:
//   - client_memory.list_templates (toolRegistry.ts) — what THIS tenant already owns: the studio's own
//     terminal-stage write (cloneConductorRoutes.ts "report") for a clone-driven mint, or a prior
//     cross-tenant instantiation (library.instantiate_template's own memory write) for one borrowed
//     from the library. Per-project (ClientMemoryStore), never cross-tenant.
//   - library.list_templates (toolRegistry.ts) — the cross-tenant library discovery surface (T15.31/
//     #207), for a structure this tenant does not yet own but another tenant's studio run already
//     minted, followed by library.instantiate_template to acquire it (still CONSUMPTION, never
//     authorship — ADR §2.1).
// A copy workflow's own conversation/prompt materials should point here rather than inventing a
// third way to answer "what structures are there" — the whole point of ADR §5 is that this question
// has one answer, read from the ledger, never guessed by a model turn.
const PUBLISHING_CONDUCTOR_CHARTER: PublishableTypeCharter = {
  workflowId: "publishing_conductor",
  // The project dialect's article/page object types. publishing_conductor's actual publish path
  // (publishPayload.ts / publisher.ts publishRun) publishes a single client object under the
  // project's OWN dialect type (e.g. "content_item"), which this set does not attempt to enumerate —
  // "page" and "navigation" are named here only as the object-native equivalents so this charter is
  // directly comparable to capture's and clone's. What matters is the EXCLUSION: no entry here is a
  // recipe type, and none may become one without amending ADR-2026-08-25-structure-studio §2.2.
  publishableTypes: ["page", "navigation"],
  rationale:
    "publishing_conductor may publish the project dialect's article/page object types only — never a theme, page template, or section_template. That exclusion is deliberate and load-bearing (ADR-2026-08-25-structure-studio §2.2): copy workflows never author or publish structure; only the studio (clone_conductor) does."
};

const CAPTURE_CONDUCTOR_CHARTER: PublishableTypeCharter = {
  workflowId: "capture_conductor",
  // T15.11 (#190): widened from {page, navigation} — publish.mjs's original PUBLISHABLE_TYPES,
  // carried into the canonical path verbatim by T15.6/T15.7 — to also cover theme, the site
  // singleton, and section_template. Before this widening, site_apply_theme's bound brandTokens had
  // no sanctioned way to go live: a captured palette sat published:false forever (issue #190's
  // motivating case, thm_capture_2da15087afc79cd29a on zilberman).
  publishableTypes: ["page", "navigation", "theme", "site", "section_template"],
  rationale:
    "capture_conductor may publish page, navigation, theme, the site singleton, and section_template (T15.11/#190, ADR-2026-08-25-publish-autonomy §6.3). Widened from {page, navigation} because capture's own emit_live stage is the deliberate act of minting these objects; publishing what it minted is that same act completed, not a side effect of a page-scoped publish loop."
};

const CLONE_CONDUCTOR_CHARTER: PublishableTypeCharter = {
  workflowId: "clone_conductor",
  // Declared for #189 (composing clone_conductor onto the shared publish segment) to consume.
  // clone_conductor does NOT compose composeWorkflowNodes today (cloneConductorWorkflow.ts says so
  // explicitly), so this entry is inert until #189 lands — declaring it here now is charter work, not
  // tail composition, and stays inside T15.11's scope.
  //
  // T15.10 (#189): "template" here, not "page_template" — see RECIPE_OBJECT_TYPES' own comment above.
  publishableTypes: ["section_template", "template", "theme", "site"],
  rationale:
    "clone_conductor (the structure studio) may publish section_template, page template (objectType \"template\"), theme, and the site singleton — it is the sole author of structure (ADR-2026-08-25-structure-studio §2)."
};

const CHARTERS: Record<string, PublishableTypeCharter> = {
  publishing_conductor: PUBLISHING_CONDUCTOR_CHARTER,
  capture_conductor: CAPTURE_CONDUCTOR_CHARTER,
  clone_conductor: CLONE_CONDUCTOR_CHARTER
};

// Fail-closed to the NARROWEST charter, mirroring workflowRegistry.ts's own precedent ("an unknown
// workflowId falls back to the publishing_conductor canonical set"): an unregistered or absent
// workflowId must never resolve to a WIDER set than the most restrictive workflow this system knows,
// because that would let a mis-stamped or foreign workflowId publish something no chartered workflow
// authorized it to.
const DEFAULT_CHARTER = PUBLISHING_CONDUCTOR_CHARTER;

export function resolvePublishableTypeCharter(workflowId: string | undefined): PublishableTypeCharter {
  const id = workflowId?.trim();
  if (id && CHARTERS[id]) return CHARTERS[id];
  return { ...DEFAULT_CHARTER, workflowId: id || DEFAULT_CHARTER.workflowId };
}

export function listPublishableTypeCharters(): PublishableTypeCharter[] {
  return Object.values(CHARTERS);
}

// ---------------------------------------------------------------------------------------------
// T15.29 (2026-08-25, #205; ADR-2026-08-25-structure-studio §2.2) — enforcement points 1 and 3 of
// the copy/structure authority boundary. Point 2 (this file's charter table above, enforced in
// objectPublishExecution.buildObjectPublishPlan) already existed and governs PUBLICATION of an
// object that was somehow already created. These two govern AUTHORSHIP — object_create / object_patch
// / site_apply_theme against a recipe type — which point 2 never touched at all.
//
// A workflow may author a recipe if and only if its OWN charter above names at least one recipe type
// as publishable. This reuses the same table §2.2 asks the two enforcement points to stay consistent
// with, rather than declaring a second "who may author structure" list that could drift from the
// first: clone_conductor's charter carries every recipe type (the studio), capture_conductor's carries
// three of four (it mints what its own emit_live stage publishes, ADR-2026-08-25-publish-autonomy
// §6.3), and publishing_conductor's carries none — the load-bearing exclusion this task enforces.
export function mayAuthorRecipes(workflowId: string | undefined): boolean {
  const charter = resolvePublishableTypeCharter(workflowId);
  return charter.publishableTypes.some((type) => (RECIPE_OBJECT_TYPES as readonly string[]).includes(type));
}

// The MCP verbs that can MINT or MUTATE a recipe object: object_create (when its objectType is a
// recipe type), object_patch (ditto, though publisher.ts's own DTC dialect never carries objectType on
// a patch call — see assertRecipeAuthorshipAllowed's own comment on why create-time coverage suffices
// there), and site_apply_theme (unconditionally a recipe write — its target is always the theme/site
// singleton, never an argument-selectable type). Deliberately DOES NOT include object_instantiate_template
// or object_instantiate_section_template: ADR §2.1 is explicit that instantiation is CONSUMPTION — it
// creates a PAGE from a template without mutating the template — and banning it here would be exactly
// the mistake the ADR calls out by name as "the single most likely way to get this task wrong."
export const RECIPE_AUTHORING_VERBS = new Set(["object_create", "object_patch", "site_apply_theme"]);

// ---- Enforcement point 1: the static tool-permission audit -----------------------------------
//
// A conformance check over a node array (in the vein of publishingTail.ts's
// publishingTailConformanceIssues): no node belonging to a workflow whose charter grants it no
// recipe type may declare a recipe-AUTHORING verb in its allowedTools. Static, and the CI test built
// on it (publishableTypeCharter.test.ts) fails the build on a violation.
//
// THE STATED LIMITATION, in the same spirit as publishingTail.test.ts's own riskLevel-conformance
// comment ("reach" means literal allowedTools string membership; it cannot see a verb reached through
// a generic gateway grant). IT APPLIES HERE, MORE SHARPLY THAN THERE: publishing_conductor's real
// canonical nodes (and the shared publish segment's) never list object_create / object_patch /
// site_apply_theme literally at all — every mutating call they can reach goes through the single
// generic verb project.call_tool, whose actual target tool name is a RUNTIME ARGUMENT
// (projectCallToolInput.tool), not a static field on the node. So on the real, current node arrays
// this audit is loaded with an empty gun: it has nothing to find, because nothing here is declared
// that way. It is not therefore inert — it is a floor against a DIFFERENT mistake (a future custom
// node, or a node whose tool wrapper is later given one of these verbs directly instead of through
// the generic gateway), and its "does it actually fire" test below proves it is wired correctly for
// the day that mistake is made. The verb reached THROUGH project.call_tool is exactly what this static
// check cannot see and exactly what enforcement point 3 (assertRecipeAuthorshipAllowed, below) exists
// to catch instead — the two points are deliberately redundant along the axis where one is blind.
//
// GRANULARITY, stated once so it is not mistaken for the same test twice: this check is per WORKFLOW
// (mayAuthorRecipes — does the charter grant ANY recipe type at all), never per specific recipe type,
// because a node's static allowedTools declares a TOOL NAME, never the objectType a runtime call will
// carry — there is no value here to check per-type against. assertRecipeAuthorshipAllowed, below,
// DOES see the actual objectType at its call site and checks per-type precisely; the two points are
// therefore consistent at the workflow granularity where both can be, and point 3 is strictly more
// precise where the data exists to be precise.
export function recipeAuthorityConformanceIssues(nodes: readonly WorkspaceNode[], workflowId: string | undefined): string[] {
  if (mayAuthorRecipes(workflowId)) return [];
  const issues: string[] = [];
  for (const node of nodes) {
    const reached = node.allowedTools.filter((toolName) => RECIPE_AUTHORING_VERBS.has(toolName));
    if (reached.length) {
      issues.push(`${node.id}: workflow "${workflowId ?? "(unknown)"}" is not chartered to author any recipe type but allowedTools reaches ${reached.join(", ")}`);
    }
  }
  return issues;
}

// ---- Enforcement point 3: the runtime write guard ----------------------------------------------
//
// The emission transport's own refusal, at the moment a recipe-authoring verb is about to go over
// the wire — the backstop for exactly what point 1 cannot see (a verb reached through
// project.call_tool / a project's own executePublish hook, never declared literally on any node).
// Reject, never coerce, never a silent drop: the same posture buildObjectPublishPlan already takes
// for a validation failure or a quarantine (publishableTypeCharter.ts's own header, point 2 above).
export class RecipeAuthorshipRefusedError extends Error {
  readonly code = "recipe_authorship_refused";
  constructor(
    readonly workflowId: string,
    readonly tool: string,
    readonly objectType: string,
    readonly objectId: string | null
  ) {
    super(
      `recipe_authorship_refused: workflow "${workflowId}" attempted ${tool} on ${objectType} object ${objectId ?? "(new)"}, but only a workflow chartered for a recipe type (RECIPE_OBJECT_TYPES: ${RECIPE_OBJECT_TYPES.join(", ")}) may author one — ADR-2026-08-25-structure-studio §2: "only the studio authors structure; copy workflows consume it and may never mint or mutate it."`
    );
    this.name = "RecipeAuthorshipRefusedError";
  }
}

// site_apply_theme carries no objectType argument — its target IS the theme/site singleton by
// construction — so it resolves to "theme" unconditionally. object_create / object_patch carry their
// target type as an argument, but the two dialects this codebase actually drives write it under
// different keys (publisher.ts's DTC hooks use wire snake_case object_type; cloneEngine.ts's
// mcpBoundary-translated calls use camelCase objectType) — both are read here rather than assuming one.
function recipeAuthoringObjectType(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "site_apply_theme") return "theme";
  const raw = args.object_type ?? args.objectType;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

const recipeAuthoringObjectId = (args: Record<string, unknown>): string | null => {
  const raw = args.object_id ?? args.objectId ?? args.requested_id ?? args.requestedId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
};

// Call this immediately before any transport dispatch of a recipe-authoring verb. Throws
// RecipeAuthorshipRefusedError — never returns a falsy "did not work", never silently drops the
// call — when the calling workflow's charter does not name THIS SPECIFIC recipe type as one it may
// publish. Checked PER TYPE against charter.publishableTypes, exactly as point 2
// (objectPublishExecution.buildObjectPublishPlan's `allowedTypes.has(objectType)`) checks it — not
// against the coarser mayAuthorRecipes() above, because at this call site the actual objectType IS
// known (unlike point 1's static node audit, which only ever sees a tool name). Using the coarse
// check here would wrongly wave through, say, capture_conductor authoring a page TEMPLATE (objectType
// "template") on the strength of its OTHER recipe grants (theme/site/section_template) — a real
// precision gap point 2 does not have, so point 3 must not have it either (§2.2's "make the two
// points consistent with [point 2]").
//
// A no-op for every other verb and for a recipe-authoring verb whose resolved objectType is not
// itself a recipe type (an object_create/object_patch of a page or navigation object is untouched by
// this guard; that is publishing_conductor's whole job and not what §2 restricts).
//
// object_patch coverage note: publisher.ts's own DTC dialect never carries objectType on a patch call
// (a patch addresses an already-created object by id; its type was fixed, and already checked, at
// object_create time). This function still inspects object_patch's args for a type when one IS
// present — a dialect that does supply it gets the same guard for free — but the load-bearing check
// for the DTC path is at object_create, and that is where the runtime tests below exercise it.
export function assertRecipeAuthorshipAllowed(workflowId: string | undefined, tool: string, args: Record<string, unknown>): void {
  if (!RECIPE_AUTHORING_VERBS.has(tool)) return;
  const objectType = recipeAuthoringObjectType(tool, args);
  if (!objectType || !(RECIPE_OBJECT_TYPES as readonly string[]).includes(objectType)) return;
  const charter = resolvePublishableTypeCharter(workflowId);
  if (charter.publishableTypes.includes(objectType)) return;
  throw new RecipeAuthorshipRefusedError(workflowId ?? "(unknown)", tool, objectType, recipeAuthoringObjectId(args));
}
