// site_content_drafting — THE EXECUTOR (C4). An operation-executor module, the pattern
// visualIdentityReviewChangeExecutor.ts uses: plain TypeScript orchestration that calls `executeNode`
// (nodeRuntime.ts) in a loop, OUTSIDE the conductor's DAG machinery. See this module's own commit for
// why a DAG conductor cannot do this job: run.nodes/stateById/dependencyOutputs/run.stageOutputs are
// all keyed 1:1 by nodeId, so one run can never hold two states for the same node — and a page with N
// sections needs one writer call per section, dispatching the SAME node (e.g.
// reference_content_writer) more than once in one page. siteContentSpecialistWorkflow.ts's own
// comment already points at this path: "the C4 conductor dispatches these five by node id
// (node_execute / node.get_effective_prompt) ... this registration does not need to change for that
// to work."
//
// THE COMPOSED FLOW: one site_content_planner call (site_content_plan.v1) -> loop over its sections,
// plain TypeScript, dispatching ONE specialist node per section via executeNode -> assembled result:
// the plan plus one outcome per section (drafted / refused / skipped), never a partial success that
// silently drops sections that never ran.
//
// WHAT THIS MODULE NEVER DOES. It writes no objects. There is no siteContentEngine.ts, and the
// page/section object mapping has no precedent in this repo — the five specialist nodes correctly
// carry no write tool (siteContentSpecialistNodes.ts: allowedTools is workspace.get_node,
// stage.get_output, stage.list_outputs, project.call_read_tool — read-only by construction). This
// module calls none of object_create / object_patch / object_publish / project.call_tool, and
// `SiteContentDraftingDeps` below has exactly one seam (`executeNodeImpl`) — there is no dependency
// surface this module could use to reach a write tool even by mistake.
//
// ROUTING IS BY JOB, NOT BY sectionType. site_content_planner's own outputSchema
// (siteContentSpecialistNodes.ts) declares each section as
// {order, sectionType, purpose, mustEstablish, reusesExisting?} with `additionalProperties: true` —
// it does NOT declare `contentRequirement`. The page_composition skill's own examples
// (seededSkills.ts), which describe the judgment this planner performs, use a `contentRequirement:
// {job, needs}` field per section — but page_composition is a DRAFT skill (dormant until an operator
// flips it to "active", per siteContentSpecialistNodes.ts's own header) and its example shape
// (`plan: [{type, purpose, contentRequirement}]`) does not even match site_content_planner's real
// outputSchema field names (`type` vs `sectionType`, `plan` vs `sections`, no `order`/`mustEstablish`
// in the skill's own examples). `additionalProperties: true` on the schema's section items means a
// section CAN carry `contentRequirement.job` without the schema strictly requiring or even declaring
// it — so this module reads it defensively (`section.contentRequirement?.job`), never assumes its
// presence, and treats an absent/null job as "skipped", never as a schema violation. See the C4
// commit message for the minimal outputSchema addition this module's author recommends instead of
// leaving the mismatch implicit.
//
// THE AMBIGUOUS DISCRIMINATORS. Three jobs route to a node whose own inputSchema requires an enum
// field the job alone does not determine: product_service_description / program_event_description
// both route to offering_description_writer's `offeringKind`; faq_help_process routes to
// reference_content_writer's `referenceKind`. Nothing in the planner's declared outputSchema
// guarantees that field is present either, so this module never guesses — a section whose job is
// ambiguous and carries no matching discriminator (checked on the section itself, its
// `contentRequirement`, and any caller-supplied `supplements` entry paired to that section — see
// SUPPLEMENT MATCHING below) is REFUSED BY NAME (order + sectionType + the missing field), and
// drafting continues for every other section. A plausible default here (writing an event page as a
// product page) is exactly the failure mode a named refusal exists to avoid.
//
// SUPPLEMENT MATCHING (2026-09-17 fix — the live dr-lurie defect). `supplements[].order` cannot, on a
// FIRST draft, name the planner's real per-section `order`: the caller cannot know it until after the
// planner has run, and a planner has no obligation to number sections 0..N-1 (the live defect: a
// one-section plan came back `order: 1`, a supplement keyed `order: 0` never matched, and the section
// silently skipped while the tool reported `ok: true`). So matching is decided ONCE for the whole
// call, highest precedence first: (1) if ANY supplied supplement's `order` equals a returned section's
// own `order`, every supplement in this call is matched against sections BY `order` (the correct,
// stable behaviour on a RE-draft, where the caller has already seen the plan and is keying on real
// orders — a caller who has seen real orders must never have them silently reinterpreted positionally);
// (2) otherwise, every supplement's `order` is read as a 0-based POSITION in the plan's returned
// section array (a caller drafting fresh has no orders to key on and means position 0..N-1). The mode
// is reported on the result as `supplementMatching` ("order" | "position" | "none") with
// `supplementMatchingReason`, and any supplement that paired with no section under the chosen mode is
// reported as its own `supplement_unmatched` outcome — never silently dropped; that silent drop, with
// the tool still reporting overall success, is exactly the live defect.
import { executeNode } from "../workspace/nodeRuntime.js";
import { getPageRecipe, SITE_CONTENT_PAGE_RECIPE_NAMES, type SiteContentRecipeSection } from "./siteContentPageRecipes.js";

// ---------------------------------------------------------------------------------------------
// Job vocabulary — the crosswalk fixed by the routing table below, never invented per-call.
export const SITE_CONTENT_JOBS = [
  "about_organization",
  "people_profile",
  "product_service_description",
  "program_event_description",
  "faq_help_process",
  "policy_explanation",
  "evidence_story",
  "focused_revision",
  "localization"
] as const;
export type SiteContentJob = (typeof SITE_CONTENT_JOBS)[number];
const SITE_CONTENT_JOB_SET: ReadonlySet<string> = new Set(SITE_CONTENT_JOBS);

export const SITE_CONTENT_SPECIALIST_NODE_IDS = [
  "site_content_planner",
  "organization_narrative_writer",
  "offering_description_writer",
  "reference_content_writer",
  "site_content_reviewer"
] as const;
export type SiteContentSpecialistNodeId = (typeof SITE_CONTENT_SPECIALIST_NODE_IDS)[number];

// ---------------------------------------------------------------------------------------------
// The plan, as site_content_planner's own outputSchema declares it — sections carry
// `additionalProperties: true`, so a section MAY carry extra fields (contentRequirement,
// offeringKind, referenceKind, ...) this module reads defensively, never assumes.
export type PlanSection = {
  order: number;
  sectionType: string;
  purpose: string;
  mustEstablish: string[];
  reusesExisting?: string | null;
  contentRequirement?: { job?: string | null; needs?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

export type SiteContentPlan = {
  sections: PlanSection[];
  openQuestions?: string[];
  summary?: string;
};

// A caller-supplied overlay of per-section content this module has no way to originate itself —
// facts, source material, existing copy to revise, a target locale, or an explicit discriminator —
// keyed by `order`. Pairing is resolved once per call: by the plan's own returned `order` values
// when any supplement's `order` matches one (a re-draft, keying on real orders already seen); by
// 0-based POSITION in the plan's returned section array otherwise (a first draft, where the caller
// cannot know the planner's real numbering yet) — see SUPPLEMENT MATCHING in this module's header.
// Entirely optional: a section with no matching supplement still dispatches on whatever the plan
// itself carries (contentRequirement, an inline offeringKind/referenceKind, ...).
export type SiteContentDraftingSupplement = {
  order: number;
  brief?: Record<string, unknown>;
  facts?: Array<string | Record<string, unknown>>;
  sourceMaterial?: Array<string | Record<string, unknown>>;
  existingCopy?: string | Record<string, unknown>;
  targetLocale?: string;
  offeringKind?: string;
  referenceKind?: string;
  voice?: string | Record<string, unknown>;
  job?: string | null;
};

export type SiteContentDraftingInput = {
  projectId: string;
  // The page brief handed to site_content_planner verbatim (plus, per section, folded into that
  // section's own writer brief — see buildSectionBrief below).
  brief: Record<string, unknown>;
  existingContent?: Array<Record<string, unknown>>;
  siteContext?: Record<string, unknown>;
  voice?: string | Record<string, unknown>;
  supplements?: SiteContentDraftingSupplement[];
  // Optional, named page-shape declaration (siteContentPageRecipes.ts). Omitting it leaves every
  // routing decision exactly as it was before recipes existed — see that module's header for the
  // precedence rule (supplement > planner job > recipe) and runSiteContentDrafting below for the
  // unknown-name refusal and the undelivered-section reporting.
  pageRecipe?: string;
};

// Where a section's job came from — an operator-facing "why was this routed this way" trail (rule 7
// of the recipe layer task). "recipe" only ever appears when neither the caller's supplement nor the
// planner's own section named a job for this order; see resolveJob below.
export type SiteContentJobSource = "supplement" | "planner" | "recipe";

export type SiteContentDraftedOutcome = {
  outcome: "drafted";
  order: number;
  sectionType: string;
  job: SiteContentJob;
  jobSource: SiteContentJobSource;
  pageRecipe?: string;
  nodeId: SiteContentSpecialistNodeId;
  // The skill id(s) this dispatch was narrowed to via candidateSkillIds (#365/#374) — always `[job]`
  // today, since every job in SITE_CONTENT_JOBS is a 1:1 skillId (see siteContentPageRecipes.ts's
  // header). Reported explicitly rather than left implicit so an operator can see why a specialist
  // saw only one job's instructions.
  candidateSkillIds: string[];
  draft: Record<string, unknown>;
  // This dispatch's own run/execution ids (see extractNodeIds) — a drafted outcome always dispatched
  // a node, so these are populated whenever executeNode's result carried them, `null` only when the
  // payload itself did not carry one (never fabricated).
  runId: string | null;
  executionId: string | null;
};
export type SiteContentRefusedOutcome = {
  outcome: "refused";
  order: number;
  sectionType: string;
  job: string | null;
  jobSource?: SiteContentJobSource;
  pageRecipe?: string;
  nodeId?: SiteContentSpecialistNodeId;
  candidateSkillIds?: string[];
  reason: string;
  // `null`/`null` for a section refused BEFORE any node was dispatched (unknown job, a missing
  // ambiguous discriminator) — no run ever happened, so there is nothing to report. A section
  // refused AFTER dispatch (the node returned no draft, or threw) carries the real ids from that
  // dispatch's own executeNode result (extractNodeIds) — `null` only if that payload itself lacked
  // them, never faked.
  runId: string | null;
  executionId: string | null;
};
export type SiteContentSkippedOutcome = {
  outcome: "skipped";
  order: number;
  sectionType: string;
  reason: "no_job";
};
// A recipe named a section (by POSITION — the recipe's Nth declared section, never the planner's own
// `order` value) that the planner's actual output never delivered: the recipe declared more sections
// than the plan returned. Reported explicitly rather than silently dropped — rule 5 of the recipe
// layer task.
export type SiteContentRecipeUndeliveredOutcome = {
  outcome: "recipe_undelivered";
  order: number;
  job: SiteContentJob;
  pageRecipe: string;
  reason: string;
};
// A caller-supplied supplement whose `order` paired with no returned section under the call's chosen
// matching mode ("order" or "position" — see SUPPLEMENT MATCHING). Reported explicitly, never
// silently dropped: this is the exact shape of the live dr-lurie defect (a supplement naming a `job`
// that matched nothing, with the tool otherwise reporting `ok: true`).
export type SiteContentSupplementUnmatchedOutcome = {
  outcome: "supplement_unmatched";
  order: number;
  job?: string | null;
  reason: string;
};
export type SiteContentSectionOutcome =
  | SiteContentDraftedOutcome
  | SiteContentRefusedOutcome
  | SiteContentSkippedOutcome
  | SiteContentRecipeUndeliveredOutcome
  | SiteContentSupplementUnmatchedOutcome;

export type SiteContentDraftingResult = {
  projectId: string;
  plan: SiteContentPlan;
  outcomes: SiteContentSectionOutcome[];
  // How this call paired `supplements[].order` to plan sections (decided once for the whole call —
  // see SUPPLEMENT MATCHING in this module's header). "none" means no supplements were supplied.
  supplementMatching: "order" | "position" | "none" | "ambiguous";
  supplementMatchingReason: string;
  // The site_content_planner dispatch's own ids (extractNodeIds) — populated on EVERY return path,
  // including the ambiguous-supplement early return, because the planner has already run by the time
  // either return statement executes. `null` only when the planner's own executeNode result did not
  // carry an id, never fabricated.
  plannerRunId: string | null;
  plannerExecutionId: string | null;
};

// The one seam. Production gets nodeRuntime.ts's real `executeNode` (its own default parameter
// already reaches the live repositoryManager singletons); a test supplies a mock here and needs no
// live store, no live model — see visualIdentityTools.ts's identical `executeNodeImpl` seam.
export type SiteContentDraftingDeps = {
  executeNodeImpl?: typeof executeNode;
};

// ---------------------------------------------------------------------------------------------
const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Drops undefined-valued keys so a node's own `required` check never sees a key that is present but
// unset — the JSON-Schema-facing shape a caller supplying `undefined` in JS should produce.
const compact = <T extends Record<string, unknown>>(input: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

const firstDefined = <T>(...values: Array<T | undefined | null>): T | undefined =>
  values.find((value): value is T => value !== undefined && value !== null);

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

// Reads a field off the section itself, falling back to `section.contentRequirement` — the two
// places a planner (or the caller narrowing its plan) could plausibly have put a discriminator,
// given the schema declares neither and `additionalProperties: true` allows both.
const readSectionField = (section: PlanSection, field: string): unknown =>
  (section as Record<string, unknown>)[field] ?? (isBag(section.contentRequirement) ? section.contentRequirement[field] : undefined);

// ---------------------------------------------------------------------------------------------
// The node's own output off an executeNode result, the same three-place read
// visualIdentityTools.ts's extractNodeProposal uses (nodeRuntime.ts writes a completed node's
// output to state.output, execution.stageOutputs[nodeId] and execution.artifacts[].value) — kept
// local rather than imported, since operations/ never depends on mcp/workspace/.
function extractNodeOutput(executed: unknown, nodeId: string): { ok: true; output: Record<string, unknown> } | { ok: false; reason: string } {
  if (!isBag(executed)) return { ok: false, reason: "node execution returned no object." };
  const execution = isBag(executed.execution) ? executed.execution : undefined;
  if (!execution) return { ok: false, reason: "node execution returned no execution record." };

  const nodes = Array.isArray(execution.nodes) ? execution.nodes.filter(isBag) : [];
  const state = nodes.find((node) => node.nodeId === nodeId) ?? nodes[0];

  // Order matters: a failed node's state.output is DEFINED (nodeRuntime.ts writes
  // `state.output = { error: … }` on the failure path), so an error envelope must never be read as
  // a draft.
  if (state?.output !== undefined && !(isBag(state.output) && isBag(state.output.error))) {
    return isBag(state.output) ? { ok: true, output: state.output } : { ok: false, reason: "node output was not an object." };
  }

  const stageOutputs = isBag(execution.stageOutputs) ? execution.stageOutputs : undefined;
  if (isBag(stageOutputs?.[nodeId])) return { ok: true, output: stageOutputs[nodeId] as Record<string, unknown> };

  const artifacts = Array.isArray(execution.artifacts) ? execution.artifacts.filter(isBag) : [];
  const artifact = artifacts.find((entry) => entry.nodeId === nodeId);
  if (isBag(artifact?.value)) return { ok: true, output: artifact!.value as Record<string, unknown> };

  const errors = [
    ...(Array.isArray(execution.errors) ? execution.errors : []),
    ...(Array.isArray(state?.errors) ? (state!.errors as unknown[]) : [])
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, 5);
  const status = typeof execution.status === "string" ? execution.status : "unknown";
  return { ok: false, reason: errors.length ? `node run ${status}: ${errors.join("; ")}` : `node run ${status} produced no output.` };
}

// The dispatch's own run/execution ids off an executeNode result — nodeRuntime.ts's executeNode
// (`return redactSecrets({ execution: await repos.executionRepository.saveRun(run), executionId,
// ... })`) puts the run id on `execution.runId` (the saved WorkflowExecutionRecord) and the
// execution id at the top level, sibling to `execution`. TOTAL: never throws, and a payload that
// does not carry an id (wrong shape, a mocked/partial executeNode in a test, a thrown dispatch whose
// catch block never got an `executed` value at all) reports `null` for that id — never `undefined`,
// never `""`, never invented. A read that did not happen is reported as unknown, not fabricated.
function extractNodeIds(executed: unknown): { runId: string | null; executionId: string | null } {
  if (!isBag(executed)) return { runId: null, executionId: null };
  const execution = isBag(executed.execution) ? executed.execution : undefined;
  const runId = typeof execution?.runId === "string" ? execution.runId : null;
  const executionId = typeof executed.executionId === "string" ? executed.executionId : null;
  return { runId, executionId };
}

// A section's writer brief: the page-level brief plus what this section's own plan entry adds
// (purpose, mustEstablish) — a caller-supplied supplement.brief, when present, wins outright rather
// than being merged, so a caller narrowing a section's brief is never fighting this default.
function buildSectionBrief(
  section: PlanSection,
  supplement: SiteContentDraftingSupplement | undefined,
  pageBrief: Record<string, unknown>,
  recipeEntry: SiteContentRecipeSection | undefined
): Record<string, unknown> {
  if (supplement?.brief !== undefined) return supplement.brief;
  return {
    ...pageBrief,
    sectionOrder: section.order,
    sectionType: section.sectionType,
    // The planner's own purpose/mustEstablish win when present; a recipe's are only a default for
    // when the planner's section left them out — never an override of what the planner said.
    sectionPurpose: section.purpose ?? recipeEntry?.purpose,
    // Trailing `?? section.mustEstablish` is load-bearing: with no recipe an empty array the
    // planner actually wrote must stay an empty array, not become undefined. A recipe default only
    // applies when there IS a recipe entry to default from.
    mustEstablish: (section.mustEstablish?.length ? section.mustEstablish : recipeEntry?.mustEstablish) ?? section.mustEstablish
  };
}

type DispatchResolution =
  | { ok: true; nodeId: SiteContentSpecialistNodeId; nodeInput: Record<string, unknown> }
  | { ok: false; reason: string };

// Routes one job to one specialist node with one fully-built node input, or refuses by name when an
// ambiguous job's discriminator is missing. This is the routing table the C4 brief specifies —
// see this module's commit message for the table in full.
function resolveDispatch(
  job: SiteContentJob,
  section: PlanSection,
  supplement: SiteContentDraftingSupplement | undefined,
  page: { brief: Record<string, unknown>; voice?: string | Record<string, unknown> },
  recipeEntry: SiteContentRecipeSection | undefined
): DispatchResolution {
  const brief = buildSectionBrief(section, supplement, page.brief, recipeEntry);
  const voice = supplement?.voice ?? page.voice;
  const plan = section;
  const sectionLabel = `section ${section.order} ("${section.sectionType}")`;

  switch (job) {
    case "about_organization":
    case "people_profile": {
      const narrativeKind = job === "about_organization" ? "organization" : "people";
      return {
        ok: true,
        nodeId: "organization_narrative_writer",
        nodeInput: compact({ narrativeKind, brief, facts: supplement?.facts, plan, voice })
      };
    }
    case "product_service_description":
    case "program_event_description": {
      const allowed = job === "product_service_description" ? (["product", "service"] as const) : (["program", "event"] as const);
      // Precedence: supplement > the planner's own section > recipe. A recipe only ever SUPPLIES a
      // discriminator; it is last in this chain and never overrides either of the other two.
      const offeringKind = firstDefined(supplement?.offeringKind, readSectionField(section, "offeringKind") as string | undefined, recipeEntry?.offeringKind);
      if (!isOneOf(offeringKind, allowed)) {
        return {
          ok: false,
          reason: `${sectionLabel} has job "${job}" but no offeringKind in {${allowed.join(", ")}} on the section or its supplement — refusing rather than guessing product vs service / program vs event.`
        };
      }
      return {
        ok: true,
        nodeId: "offering_description_writer",
        nodeInput: compact({ offeringKind, brief, facts: supplement?.facts, plan, voice })
      };
    }
    case "faq_help_process": {
      const allowed = ["faq", "process"] as const;
      const referenceKind = firstDefined(supplement?.referenceKind, readSectionField(section, "referenceKind") as string | undefined, recipeEntry?.referenceKind);
      if (!isOneOf(referenceKind, allowed)) {
        return {
          ok: false,
          reason: `${sectionLabel} has job "faq_help_process" but no referenceKind in {${allowed.join(", ")}} on the section or its supplement — refusing rather than guessing faq vs process.`
        };
      }
      return {
        ok: true,
        nodeId: "reference_content_writer",
        nodeInput: compact({ referenceKind, brief, sourceMaterial: supplement?.sourceMaterial, plan, voice })
      };
    }
    case "policy_explanation":
      return {
        ok: true,
        nodeId: "reference_content_writer",
        nodeInput: compact({ referenceKind: "policy", brief, sourceMaterial: supplement?.sourceMaterial, plan, voice })
      };
    case "evidence_story":
      return {
        ok: true,
        nodeId: "reference_content_writer",
        nodeInput: compact({ referenceKind: "evidence_story", brief, sourceMaterial: supplement?.sourceMaterial, plan, voice })
      };
    case "focused_revision":
      return {
        ok: true,
        nodeId: "site_content_reviewer",
        nodeInput: compact({ mode: "revise", existingCopy: supplement?.existingCopy, brief, plan, voice })
      };
    case "localization":
      return {
        ok: true,
        nodeId: "site_content_reviewer",
        nodeInput: compact({ mode: "localize", existingCopy: supplement?.existingCopy, brief, targetLocale: supplement?.targetLocale, plan, voice })
      };
  }
}

// One section, start to finish: job extraction -> skip (no job) / route+dispatch / refuse. A thrown
// error from `runNode` (the node runner itself, not this module) is caught here and turned into a
// refused outcome — it never propagates out of this function, which is what keeps one writer's
// failure from discarding every other section's draft (see runSiteContentDrafting below).
// Job precedence: supplement (highest) > the planner's own section.contentRequirement.job > this
// recipe entry's job (lowest, and only consulted when neither of the first two said anything at
// all — see the module header and siteContentPageRecipes.ts's own header for why).
function resolveJob(
  section: PlanSection,
  supplement: SiteContentDraftingSupplement | undefined,
  recipeEntry: SiteContentRecipeSection | undefined
): { job: string | null | undefined; source: SiteContentJobSource | undefined } {
  // NOT firstDefined: a supplement that omits `job` must fall through to the section's own
  // contentRequirement.job, and that value's own explicit `null` (page_composition's own
  // contact_form example: "job": null) must be preserved as null, never collapsed into "absent" by
  // a null-skipping helper — both null and undefined mean "skip", but they are read here exactly as
  // the planner wrote them. This is untouched by recipes: a recipe is consulted only when BOTH of
  // the first two are `undefined` (never when either is present-and-null).
  if (supplement?.job !== undefined) return { job: supplement.job, source: supplement.job === null ? undefined : "supplement" };
  if (section.contentRequirement?.job !== undefined) {
    const plannerJob = section.contentRequirement.job;
    return { job: plannerJob, source: plannerJob === null ? undefined : "planner" };
  }
  if (recipeEntry !== undefined) return { job: recipeEntry.job, source: "recipe" };
  return { job: undefined, source: undefined };
}

async function dispatchSection(
  section: PlanSection,
  supplement: SiteContentDraftingSupplement | undefined,
  page: { brief: Record<string, unknown>; voice?: string | Record<string, unknown> },
  runNode: typeof executeNode,
  recipeEntry: SiteContentRecipeSection | undefined,
  pageRecipeName: string | undefined
): Promise<SiteContentSectionOutcome> {
  const { job, source } = resolveJob(section, supplement, recipeEntry);
  if (job === undefined || job === null) {
    return { outcome: "skipped", order: section.order, sectionType: section.sectionType, reason: "no_job" };
  }
  const pageRecipe = source === "recipe" ? pageRecipeName : undefined;
  if (!SITE_CONTENT_JOB_SET.has(job)) {
    // Before dispatch — no route was found, so no node ever ran. Never fake an id for a run that
    // never happened.
    return {
      outcome: "refused",
      order: section.order,
      sectionType: section.sectionType,
      job,
      jobSource: source,
      pageRecipe,
      runId: null,
      executionId: null,
      reason: `section ${section.order} ("${section.sectionType}") names job "${job}", which has no registered route.`
    };
  }

  const resolved = resolveDispatch(job as SiteContentJob, section, supplement, page, recipeEntry);
  if (!resolved.ok) {
    // Before dispatch — an ambiguous discriminator refuses before any writer runs (see this
    // module's header, SUPPLEMENT MATCHING / THE AMBIGUOUS DISCRIMINATORS). No node ran, so null.
    return { outcome: "refused", order: section.order, sectionType: section.sectionType, job, jobSource: source, pageRecipe, runId: null, executionId: null, reason: resolved.reason };
  }

  const { nodeId, nodeInput } = resolved;
  const candidateSkillIds = [job];
  try {
    // #374's candidateSkillIds — naming the job is what keeps reference_content_writer (assigned
    // all three of faq_help_process/policy_explanation/evidence_story) from dragging every family's
    // instructions into one dispatch.
    const executed = await runNode({ nodeId, input: nodeInput, candidateSkillIds });
    const ids = extractNodeIds(executed);
    const extracted = extractNodeOutput(executed, nodeId);
    if (!extracted.ok) {
      // After dispatch — the node ran (executed carries whatever ids that dispatch's own
      // executeNode result reported) but produced no usable draft.
      return { outcome: "refused", order: section.order, sectionType: section.sectionType, job, jobSource: source, pageRecipe, nodeId, candidateSkillIds, runId: ids.runId, executionId: ids.executionId, reason: `${nodeId} returned no draft: ${extracted.reason}` };
    }
    return { outcome: "drafted", order: section.order, sectionType: section.sectionType, job: job as SiteContentJob, jobSource: source!, pageRecipe, nodeId, candidateSkillIds, draft: extracted.output, runId: ids.runId, executionId: ids.executionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // After dispatch — the call was made (a run may already exist), but the dispatch itself threw
    // rather than returning a result. extractNodeIds reads whatever the thrown value itself carries
    // (best-effort, e.g. an error object shaped like an executeNode result); it is `null` when the
    // thrown value carries nothing, never invented.
    const ids = extractNodeIds(error);
    return { outcome: "refused", order: section.order, sectionType: section.sectionType, job, jobSource: source, pageRecipe, nodeId, candidateSkillIds, runId: ids.runId, executionId: ids.executionId, reason: `${nodeId} threw: ${message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// The entry point. One site_content_planner call, then one dispatch per section — every section
// gets an outcome (drafted / refused / skipped); no section is silently dropped, and no single
// section's failure discards another's draft.
export async function runSiteContentDrafting(input: SiteContentDraftingInput, deps: SiteContentDraftingDeps = {}): Promise<SiteContentDraftingResult> {
  const runNode = deps.executeNodeImpl ?? executeNode;

  // Recipe resolution happens before the planner call so an unknown name is refused immediately,
  // never silently ignored (rule 4). Omitting pageRecipe entirely takes this whole branch out of
  // play — pageRecipe stays undefined, recipe stays undefined, every recipeEntry lookup below is
  // undefined, and dispatchSection's behaviour is byte-for-byte what it was before recipes existed.
  let recipe: ReturnType<typeof getPageRecipe> | undefined;
  if (input.pageRecipe !== undefined) {
    recipe = getPageRecipe(input.pageRecipe);
    if (!recipe) {
      throw new Error(
        `unknown pageRecipe "${input.pageRecipe}" — known recipes: ${SITE_CONTENT_PAGE_RECIPE_NAMES.join(", ")}.`
      );
    }
  }
  // Recipe sections pair with plan sections BY POSITION (the recipe's Nth declared section <-> the
  // plan's Nth returned section), never by the planner's own `order` value — a recipe is authored
  // before any plan exists, so it cannot reference the planner's numbering. `recipe.sections[i].order`
  // is only that section's own declaration index, asserted contiguous in this module's test.
  const recipeSections = recipe?.sections ?? [];

  const plannerInput = compact({ brief: input.brief, existingContent: input.existingContent, siteContext: input.siteContext });
  const plannerExecuted = await runNode({ nodeId: "site_content_planner", input: plannerInput, candidateSkillIds: ["page_composition"] });
  // Captured before the ok-check so it is available on every return path that follows a successful
  // planner dispatch, including the ambiguous-supplement early return below — the planner has
  // already run by then, and WHY (item 2 of the task this closes) is that an ambiguous refusal is
  // the one path an operator could previously only infer no writer ran on, never confirm.
  const plannerIds = extractNodeIds(plannerExecuted);
  const plannerExtracted = extractNodeOutput(plannerExecuted, "site_content_planner");
  if (!plannerExtracted.ok) {
    throw new Error(`site_content_planner produced no plan: ${plannerExtracted.reason}`);
  }

  const rawSections = plannerExtracted.output.sections;
  const sections: PlanSection[] = Array.isArray(rawSections) ? (rawSections as PlanSection[]) : [];
  const openQuestions = plannerExtracted.output.openQuestions;
  const summary = plannerExtracted.output.summary;

  const suppliedSupplements = input.supplements ?? [];
  const supplementByOrderValue = new Map<number, SiteContentDraftingSupplement>();
  for (const supplement of suppliedSupplements) supplementByOrderValue.set(supplement.order, supplement);

  // SUPPLEMENT MATCHING — decided once for the whole call (see this module's header). "order" wins
  // whenever ANY supplied supplement's `order` equals a returned section's own `order` (a re-draft,
  // keying on real orders already seen); otherwise, when supplements were supplied at all, every
  // supplement's `order` is read as a 0-based POSITION in the plan's returned section array (a first
  // draft, where the caller cannot know the planner's real numbering yet — the live dr-lurie defect).
  const returnedOrders = sections.map((section) => section.order);
  const returnedOrderSet = new Set(returnedOrders);
  // ALL, not ANY. A partial match is the one case where a guess misattributes content rather than
  // merely losing it: a first-draft caller keying 0..N-1 against a plan that came back [1, 2] has one
  // supplement that happens to match order 1, and choosing "order" on that basis would apply position
  // 0's facts to the section the planner numbered 1 — the wrong section, with the right-looking
  // result. So each mode is chosen only when it accounts for EVERY supplied supplement, and a call
  // that satisfies neither is REFUSED rather than resolved on the majority. Refusing beats guessing
  // here for the same reason it does for the ambiguous discriminators above.
  const allMatchByOrder = suppliedSupplements.every((supplement) => returnedOrderSet.has(supplement.order));
  const allMatchByPosition = suppliedSupplements.every(
    (supplement) => Number.isInteger(supplement.order) && supplement.order >= 0 && supplement.order < sections.length
  );

  let supplementMatching: "order" | "position" | "none" | "ambiguous";
  let supplementMatchingReason: string;
  if (suppliedSupplements.length === 0) {
    supplementMatching = "none";
    supplementMatchingReason = "no supplements were supplied.";
  } else if (allMatchByOrder) {
    // Order first when both fit: a caller keying on orders they have already seen is the more
    // specific intent, and where both interpretations fit they select the same sections anyway
    // whenever the planner numbered its sections 0..N-1.
    supplementMatching = "order";
    supplementMatchingReason =
      "every supplied supplement's `order` matched a returned section's own `order`, so supplements are matched by `order` (a caller who has seen real section orders must not have them reinterpreted positionally).";
  } else if (allMatchByPosition) {
    supplementMatching = "position";
    supplementMatchingReason =
      "no supplied supplement's `order` matched a returned section's own `order`, but every one is a valid 0-based position in the plan's returned section array, so each is read as a position (a first-draft caller cannot know the planner's real numbering yet).";
  } else {
    supplementMatching = "ambiguous";
    supplementMatchingReason =
      `supplements cannot be paired to this plan without guessing: the plan returned orders [${returnedOrders.join(", ")}] (${sections.length} section(s), positions 0..${Math.max(sections.length - 1, 0)}), and the supplied orders [${suppliedSupplements.map((supplement) => supplement.order).join(", ")}] match neither every returned \`order\` nor every valid position. Re-key the supplements on the orders this plan actually returned and call again.`;
  }

  // An ambiguous pairing refuses BEFORE any writer is dispatched — no model spend, and no section
  // drafted from facts that may belong to a different section. The plan is still returned, so the
  // caller can re-key on the real orders immediately rather than replanning.
  if (supplementMatching === "ambiguous") {
    return {
      projectId: input.projectId,
      plan: {
        sections,
        ...(Array.isArray(openQuestions) ? { openQuestions: openQuestions as string[] } : {}),
        ...(typeof summary === "string" ? { summary } : {})
      },
      outcomes: suppliedSupplements.map((supplement) => ({
        outcome: "supplement_unmatched" as const,
        order: supplement.order,
        job: supplement.job,
        reason: supplementMatchingReason
      })),
      supplementMatching,
      supplementMatchingReason,
      plannerRunId: plannerIds.runId,
      plannerExecutionId: plannerIds.executionId
    };
  }

  // The set of supplement `order` keys that this call actually paired to a section, so any leftover
  // key can be reported as `supplement_unmatched` rather than silently dropped.
  const consumedSupplementOrders = new Set<number>();

  const page = { brief: input.brief, voice: input.voice };
  const outcomes: SiteContentSectionOutcome[] = [];
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    let supplement: SiteContentDraftingSupplement | undefined;
    if (supplementMatching === "order") {
      supplement = supplementByOrderValue.get(section.order);
      if (supplement) consumedSupplementOrders.add(section.order);
    } else if (supplementMatching === "position") {
      supplement = supplementByOrderValue.get(index);
      if (supplement) consumedSupplementOrders.add(index);
    }
    outcomes.push(
      await dispatchSection(section, supplement, page, runNode, recipeSections[index], input.pageRecipe)
    );
  }

  // Rule C: a supplement whose `order` paired with no returned section, under this call's chosen
  // matching mode, is reported explicitly — never silently dropped. This is the exact shape of the
  // live dr-lurie defect: a supplement naming a `job` that matched nothing, with the tool otherwise
  // reporting `ok: true`.
  // BACKSTOP, not a live path: mode selection above admits "order" only when every supplement
  // matches a returned order and "position" only when every one is a valid index, so by construction
  // nothing is left over here — an unpairable set is refused as "ambiguous" before any dispatch. This
  // loop stays so that a future change to mode selection cannot silently drop a caller's supplement
  // the way the original `order`-only keying did.
  for (const [orderKey, supplement] of supplementByOrderValue) {
    if (consumedSupplementOrders.has(orderKey)) continue;
    const reason =
      supplementMatching === "order"
        ? `supplement order ${orderKey} matched no returned section by \`order\`; the plan returned orders: [${returnedOrders.join(", ")}].`
        : `supplement order ${orderKey} matched no position in the plan's returned section array; the plan returned ${sections.length} section(s) (positions 0..${Math.max(sections.length - 1, 0)}).`;
    outcomes.push({ outcome: "supplement_unmatched", order: orderKey, job: supplement.job, reason });
  }

  // Rule 5: a recipe never fabricates a section the planner did not plan, but an entry the recipe
  // named (by position) that the planner never delivered is reported explicitly, not dropped — "the
  // recipe declared N sections, the plan returned fewer."
  if (recipe) {
    for (let index = sections.length; index < recipeSections.length; index++) {
      const recipeSection = recipeSections[index];
      outcomes.push({
        outcome: "recipe_undelivered",
        order: recipeSection.order,
        job: recipeSection.job,
        pageRecipe: recipe.name,
        reason: `recipe "${recipe.name}" declares ${recipeSections.length} section(s), but site_content_planner's plan returned only ${sections.length}; the recipe's section at position ${index} (job "${recipeSection.job}") was not delivered.`
      });
    }
  }

  return {
    projectId: input.projectId,
    plan: {
      sections,
      ...(Array.isArray(openQuestions) ? { openQuestions: openQuestions as string[] } : {}),
      ...(typeof summary === "string" ? { summary } : {})
    },
    outcomes,
    supplementMatching,
    supplementMatchingReason,
    plannerRunId: plannerIds.runId,
    plannerExecutionId: plannerIds.executionId
  };
}
