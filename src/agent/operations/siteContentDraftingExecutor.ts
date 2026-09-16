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
// `contentRequirement`, and any caller-supplied `supplements` entry for that section's order) is
// REFUSED BY NAME (order + sectionType + the missing field), and drafting continues for every other
// section. A plausible default here (writing an event page as a product page) is exactly the failure
// mode a named refusal exists to avoid.
import { executeNode } from "../workspace/nodeRuntime.js";

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
// keyed by the section's own `order` (the plan's only stable per-section identifier). Entirely
// optional: a section with no matching supplement still dispatches on whatever the plan itself
// carries (contentRequirement, an inline offeringKind/referenceKind, ...).
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
};

export type SiteContentDraftedOutcome = {
  outcome: "drafted";
  order: number;
  sectionType: string;
  job: SiteContentJob;
  nodeId: SiteContentSpecialistNodeId;
  draft: Record<string, unknown>;
};
export type SiteContentRefusedOutcome = {
  outcome: "refused";
  order: number;
  sectionType: string;
  job: string | null;
  nodeId?: SiteContentSpecialistNodeId;
  reason: string;
};
export type SiteContentSkippedOutcome = {
  outcome: "skipped";
  order: number;
  sectionType: string;
  reason: "no_job";
};
export type SiteContentSectionOutcome = SiteContentDraftedOutcome | SiteContentRefusedOutcome | SiteContentSkippedOutcome;

export type SiteContentDraftingResult = {
  projectId: string;
  plan: SiteContentPlan;
  outcomes: SiteContentSectionOutcome[];
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

// A section's writer brief: the page-level brief plus what this section's own plan entry adds
// (purpose, mustEstablish) — a caller-supplied supplement.brief, when present, wins outright rather
// than being merged, so a caller narrowing a section's brief is never fighting this default.
function buildSectionBrief(section: PlanSection, supplement: SiteContentDraftingSupplement | undefined, pageBrief: Record<string, unknown>): Record<string, unknown> {
  if (supplement?.brief !== undefined) return supplement.brief;
  return {
    ...pageBrief,
    sectionOrder: section.order,
    sectionType: section.sectionType,
    sectionPurpose: section.purpose,
    mustEstablish: section.mustEstablish
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
  page: { brief: Record<string, unknown>; voice?: string | Record<string, unknown> }
): DispatchResolution {
  const brief = buildSectionBrief(section, supplement, page.brief);
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
      const offeringKind = firstDefined(supplement?.offeringKind, readSectionField(section, "offeringKind") as string | undefined);
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
      const referenceKind = firstDefined(supplement?.referenceKind, readSectionField(section, "referenceKind") as string | undefined);
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
async function dispatchSection(
  section: PlanSection,
  supplement: SiteContentDraftingSupplement | undefined,
  page: { brief: Record<string, unknown>; voice?: string | Record<string, unknown> },
  runNode: typeof executeNode
): Promise<SiteContentSectionOutcome> {
  // NOT firstDefined: a supplement that omits `job` must fall through to the section's own
  // contentRequirement.job, and that value's own explicit `null` (page_composition's own
  // contact_form example: "job": null) must be preserved as null, never collapsed into "absent" by
  // a null-skipping helper — both null and undefined mean "skip", but they are read here exactly as
  // the planner wrote them.
  const job = supplement?.job !== undefined ? supplement.job : section.contentRequirement?.job;
  if (job === undefined || job === null) {
    return { outcome: "skipped", order: section.order, sectionType: section.sectionType, reason: "no_job" };
  }
  if (!SITE_CONTENT_JOB_SET.has(job)) {
    return {
      outcome: "refused",
      order: section.order,
      sectionType: section.sectionType,
      job,
      reason: `section ${section.order} ("${section.sectionType}") names job "${job}", which has no registered route.`
    };
  }

  const resolved = resolveDispatch(job as SiteContentJob, section, supplement, page);
  if (!resolved.ok) {
    return { outcome: "refused", order: section.order, sectionType: section.sectionType, job, reason: resolved.reason };
  }

  const { nodeId, nodeInput } = resolved;
  try {
    // #374's candidateSkillIds — naming the job is what keeps reference_content_writer (assigned
    // all three of faq_help_process/policy_explanation/evidence_story) from dragging every family's
    // instructions into one dispatch.
    const executed = await runNode({ nodeId, input: nodeInput, candidateSkillIds: [job] });
    const extracted = extractNodeOutput(executed, nodeId);
    if (!extracted.ok) {
      return { outcome: "refused", order: section.order, sectionType: section.sectionType, job, nodeId, reason: `${nodeId} returned no draft: ${extracted.reason}` };
    }
    return { outcome: "drafted", order: section.order, sectionType: section.sectionType, job: job as SiteContentJob, nodeId, draft: extracted.output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: "refused", order: section.order, sectionType: section.sectionType, job, nodeId, reason: `${nodeId} threw: ${message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// The entry point. One site_content_planner call, then one dispatch per section — every section
// gets an outcome (drafted / refused / skipped); no section is silently dropped, and no single
// section's failure discards another's draft.
export async function runSiteContentDrafting(input: SiteContentDraftingInput, deps: SiteContentDraftingDeps = {}): Promise<SiteContentDraftingResult> {
  const runNode = deps.executeNodeImpl ?? executeNode;

  const plannerInput = compact({ brief: input.brief, existingContent: input.existingContent, siteContext: input.siteContext });
  const plannerExecuted = await runNode({ nodeId: "site_content_planner", input: plannerInput, candidateSkillIds: ["page_composition"] });
  const plannerExtracted = extractNodeOutput(plannerExecuted, "site_content_planner");
  if (!plannerExtracted.ok) {
    throw new Error(`site_content_planner produced no plan: ${plannerExtracted.reason}`);
  }

  const rawSections = plannerExtracted.output.sections;
  const sections: PlanSection[] = Array.isArray(rawSections) ? (rawSections as PlanSection[]) : [];
  const openQuestions = plannerExtracted.output.openQuestions;
  const summary = plannerExtracted.output.summary;

  const supplementByOrder = new Map<number, SiteContentDraftingSupplement>();
  for (const supplement of input.supplements ?? []) supplementByOrder.set(supplement.order, supplement);

  const page = { brief: input.brief, voice: input.voice };
  const outcomes: SiteContentSectionOutcome[] = [];
  for (const section of sections) {
    outcomes.push(await dispatchSection(section, supplementByOrder.get(section.order), page, runNode));
  }

  return {
    projectId: input.projectId,
    plan: {
      sections,
      ...(Array.isArray(openQuestions) ? { openQuestions: openQuestions as string[] } : {}),
      ...(typeof summary === "string" ? { summary } : {})
    },
    outcomes
  };
}
