// W4 (2026-09-09, Wolf) — the governed `editorial_strategy` object: its genesis default, and the one
// resolver every consumer reads it through.
//
// THE GAP. `editorial_strategy` is a new platform-side governed object type, id `strat_<slug>`, one
// per tenant, sibling of `editorial_voice` (`voice_<slug>`) and `visual_standard` (`vis_<slug>`). It
// carries what the site DECIDES TO COMMISSION — the goal, the offer, the audience segments, the topic
// weights, the angle mix, the funnel aggression — and it is the artefact the weekly strategy review
// (improvement/strategyReview.ts) has always addressed its proposals to. What nothing in this repo
// could do was READ it: the planning and writer nodes ran with the tenant's VOICE in hand and no
// strategy at all, so every brief was written in the right tone about whatever the model felt like
// commissioning, and the one loop that proposes changes to the strategy could not tell a strategy
// somebody had decided from a placeholder nobody had ever looked at.
//
// THE UNSET MARKER IS PROVENANCE, NOT ABSENCE. A tenant's strategy object EXISTS from birth — genesis
// writes a default one — so "is this configured?" cannot be answered by whether the object is there.
// It is answered by the body's own `provenance.set_by`: "genesis_default" means nobody has decided
// anything yet, "agent" and "human" mean somebody has. `editorial_voice` gains the same optional block
// on the platform side, for the same reason. `getEditorialStrategy` below reports a genesis default as
// `source: "default"` with `warningCode: "strategy_object_unconfigured"` — the SAME warning an absent
// object gets, because to a consumer those two states mean the identical thing.
//
// UNSET NEVER BLOCKS (Wolf, 2026-09-09). A default surfaces as a warning and every consumer still
// runs. This is the same posture voicePrefetch.ts takes and for the same reason: a run that stops
// because nobody has written a strategy yet punishes the tenant for the pipeline's own gap, and a
// silent degradation is worse than either. Loud, named, and non-blocking.
//
// WHY THE DEFAULT BUILDER IS DELIBERATELY THIN. Same discipline as genesisEditorialVoiceFallback: it
// states what genesis actually knows (the niche and audience it was handed) and commits to nothing it
// does not. It invents no offer, no topic weights and no funnel numbers for a client nobody has
// interviewed, because a rich default is indistinguishable at the point of use from a strategy an
// editor decided — which is exactly the confusion `provenance` exists to prevent. Thin, labelled, and
// marked `set_by: "genesis_default"` beats plausible and unmarked.
import { ProjectMcpAdapter } from "./projectMcpAdapter.js";
import { getProjectHooks } from "./projectHooks.js";
import { conventionalStrategyObjectId, type ProjectConnectionConfig } from "./projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { RunScopedCache } from "../workspace/conductor.js";

/** The governed object type, as the tenant MCP's closed `object_type` enum spells it. */
export const EDITORIAL_STRATEGY_OBJECT_TYPE = "editorial_strategy";

/** `provenance.set_by` values. "genesis_default" is the UNSET MARKER — see the module header. */
export const strategyProvenanceSetters = ["genesis_default", "agent", "human"] as const;
export type StrategyProvenanceSetter = typeof strategyProvenanceSetters[number];
export const GENESIS_DEFAULT_SET_BY: StrategyProvenanceSetter = "genesis_default";

export type StrategyProvenance = {
  set_by: StrategyProvenanceSetter;
  set_at: string;
};

/**
 * The body shape this repo consumes, mirroring the platform-side schema being written in parallel.
 *
 * Read it as a CONSUMER contract, not as a definition: nothing here validates a tenant's object
 * against the platform's own schema, and `isEditorialStrategyBody` below is deliberately loose in the
 * same way `isVoiceBody` is — it decides only whether what came back is usable enough to hand a node,
 * never whether it satisfies the governed contract, which is the tenant server's job.
 */
export type EditorialStrategyTopicWeight = { term_id?: string; label?: string; weight: number };
export type EditorialStrategyAngle = { angle: string; share: number };
export type EditorialStrategyFunnelAggression = { tofu: number; mofu: number; bofu: number };

export type EditorialStrategyBody = {
  name: string;
  goal: string;
  offer: string;
  audience_segments: string[];
  topic_weights: EditorialStrategyTopicWeight[];
  angle_mix: EditorialStrategyAngle[];
  funnel_aggression: EditorialStrategyFunnelAggression;
  cadence: string;
  notes?: string;
  provenance: StrategyProvenance;
};

/**
 * Build the provisional strategy a newly minted tenant is born with.
 *
 * Returns undefined when genesis was given neither a niche nor an audience — exactly the rule
 * genesisEditorialVoiceFallback follows, and for the same reason: with nothing true to say about the
 * tenant, the "default" would be boilerplate wearing its name, and having no strategy object at all is
 * the more truthful state. Every numeric field below is a deliberately FLAT distribution, not a guess
 * dressed up as a decision: equal angle shares and an even funnel spread say "nobody has chosen", which
 * is the fact, while a weighted mix would encode a preference genesis has no basis for.
 */
export function genesisEditorialStrategyDefault(input: { slug: string; niche?: string; audience?: string; now?: () => Date }): EditorialStrategyBody | undefined {
  const niche = input.niche?.trim();
  const audience = input.audience?.trim();
  if (!niche && !audience) return undefined;

  const subject = niche || `${input.slug}'s subject area`;
  const readers = audience || `general readers arriving on ${subject}`;
  return {
    name: `${input.slug} — provisional strategy (genesis)`,
    goal: `Publish material about ${subject} that a reader finds genuinely useful, and learn from what they do with it. Genesis has no revenue or growth target for this tenant, and inventing one would set a bar nobody agreed to.`,
    // Deliberately not an offer. Genesis knows of no product, price or funnel here, and a fabricated
    // offer is the one field in this body that could push a writer into making a claim for a tenant.
    offer: "None declared. Genesis was given no offer for this tenant; nothing here authorizes a pitch, a price or a promise.",
    audience_segments: [readers],
    // Empty rather than invented. A topic weight is a commissioning instruction; an unowned one would
    // be obeyed. The tenant's taxonomy registry is the only honest source for these.
    topic_weights: [],
    // A flat mix over the angles this pipeline can actually distinguish, so no angle is privileged by
    // an accident of genesis. The strategy review's ANGLE MIX proposals are the intended way this
    // stops being flat — on measured evidence, in front of a human.
    angle_mix: [
      { angle: "explainer", share: 0.34 },
      { angle: "objection", share: 0.33 },
      { angle: "comparison", share: 0.33 }
    ],
    // An even, unaggressive spread. Pushing the offer harder anywhere down the funnel is a decision
    // about a tenant's commercial posture, and genesis has not met the tenant.
    funnel_aggression: { tofu: 0.34, mofu: 0.33, bofu: 0.33 },
    cadence: "Undecided. Publish when there is something worth publishing about " + subject + "; genesis sets no schedule.",
    notes: `This strategy was generated at genesis from the niche and audience supplied then; nobody has reviewed it. It is marked provenance.set_by="${GENESIS_DEFAULT_SET_BY}" precisely so every consumer can tell it apart from a strategy an editor decided. Treat it as a floor, not a plan, and do not let it license claims about ${subject} that the tenant's own material does not make.`,
    provenance: { set_by: GENESIS_DEFAULT_SET_BY, set_at: (input.now?.() ?? new Date()).toISOString() }
  };
}

// ── resolution ───────────────────────────────────────────────────────────────

export type StrategyResolutionWarningCode =
  | "strategy_object_unconfigured"
  | "strategy_prefetch_blocked"
  | "strategy_prefetch_unreachable"
  | "strategy_object_invalid"
  | "threw";

export type StrategyResolutionSource =
  // A live object somebody DECIDED: provenance.set_by is "agent" or "human" (or the object predates
  // provenance entirely, which is treated as decided — an object with no provenance block was written
  // by somebody, and calling it a default would be the more damaging guess).
  | "object"
  // A live object still carrying provenance.set_by === "genesis_default": present, readable, and by
  // its own admission not yet decided.
  | "default"
  // No usable object; a genesis default built here, in memory, from what the record knows.
  | "fallback"
  // No usable object and nothing honest to build one from.
  | "unavailable";

export type StrategyResolutionResult = {
  /** Absent only when source is "unavailable". */
  strategy?: EditorialStrategyBody;
  source: StrategyResolutionSource;
  /** The address that was read (or would have been), so a caller can name it without re-deriving it. */
  objectId?: string;
  /** How that address was reached: the record's pointer, or the `strat_<slug>` convention. */
  objectIdSource?: "record" | "convention";
  /** Present whenever source !== "object": names exactly why the decided object was not used. */
  warningCode?: StrategyResolutionWarningCode;
  warning?: string;
};

export type StrategyResolutionParams = {
  projectId: string;
  /** Run-scoped cache key. Omit outside a run (the strategy-review job) and the read is not memoized. */
  runId?: string;
  /** Explicit override, ahead of both the record pointer and the convention. */
  requestedStrategyObjectId?: string;
};

export type StrategyResolutionDeps = {
  projectRepository: ProjectRepository;
  cache?: RunScopedCache;
  /** Test seam and future transport swap. Defaults to the tenant MCP through ProjectMcpAdapter. */
  callReadTool?: (config: ProjectConnectionConfig, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Same timeout, for the same reason, as voicePrefetch.ts's VOICE_PREFETCH_TIMEOUT_MS: this call is
// deterministic conductor/job code rather than a model-invoked tool, so it inherits no timeout at all
// from executeTool. It degrades gracefully on a dead remote — but only if it degrades AT ALL, rather
// than hanging a node dispatch or a weekly job forever on a connection nobody is going to answer.
const STRATEGY_PREFETCH_TIMEOUT_MS = 15_000;

/**
 * Loose usability check, deliberately mirroring voicePrefetch.ts's isVoiceBody in strictness: the
 * five fields a consumer actually reads have to be the right SHAPE, and the rest is the tenant
 * server's contract to enforce. `provenance` is NOT required here — an object written before the
 * block existed is a real strategy, and refusing it would degrade a decided strategy to a fallback.
 */
export function isEditorialStrategyBody(value: unknown): value is EditorialStrategyBody {
  if (!isObject(value)) return false;
  return typeof value.name === "string"
    && typeof value.goal === "string"
    && typeof value.offer === "string"
    && Array.isArray(value.audience_segments)
    && Array.isArray(value.topic_weights)
    && Array.isArray(value.angle_mix)
    && isObject(value.funnel_aggression)
    && typeof value.cadence === "string";
}

/** The provenance setter an object declares, or undefined when it carries no provenance block. */
export const strategyProvenanceSetBy = (body: EditorialStrategyBody): StrategyProvenanceSetter | undefined => {
  const setBy = (body as { provenance?: unknown }).provenance;
  if (!isObject(setBy)) return undefined;
  const value = setBy.set_by;
  return typeof value === "string" && (strategyProvenanceSetters as readonly string[]).includes(value) ? (value as StrategyProvenanceSetter) : undefined;
};

/** True when the object is present but still says, in its own body, that nobody has decided it. */
export const isGenesisDefaultStrategy = (body: EditorialStrategyBody): boolean => strategyProvenanceSetBy(body) === GENESIS_DEFAULT_SET_BY;

// The same shape-first descent voicePrefetch.ts uses (T10): object_get answers with the full RECORD —
// object_id, status, version, history and the body under `body` — and a server that returns the body
// unwrapped is equally valid. Descending by shape rather than by a memorised path means neither has to
// be declared canonical, and the T10 failure (a live, authored object silently degrading to a fallback
// for a year because the record wrapper was handed to the shape check) cannot repeat here.
const descendToStrategyBody = (candidate: unknown): unknown => {
  if (!isObject(candidate)) return candidate;
  if (isEditorialStrategyBody(candidate)) return candidate;
  return isObject(candidate.body) ? candidate.body : candidate;
};

function extractStrategyPayload(result: unknown): unknown {
  if (!isObject(result)) return result;
  const structured = result.structuredContent;
  if (isObject(structured)) {
    if (isObject(structured.object)) return descendToStrategyBody(structured.object);
    if (isObject(structured.record)) return descendToStrategyBody(structured.record);
    return descendToStrategyBody(structured);
  }
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.find((block): block is { text: string } => isObject(block) && typeof block.text === "string")?.text;
    if (typeof text === "string") {
      try { return descendToStrategyBody(JSON.parse(text)); } catch { return text; }
    }
  }
  return descendToStrategyBody(result);
}

/**
 * The in-memory last resort, built from what the RECORD knows about the tenant.
 *
 * The audience comes off `editorialVoiceFallback.audience` when there is one, and that is not a hack:
 * genesis derived that string from the very `audience` input this builder wants, so reading it back is
 * recovering a recorded fact rather than inventing one. With no voice fallback there is no audience and
 * no niche on the record at all, the builder returns undefined, and the honest answer is "unavailable".
 */
const recordFallbackStrategy = (config: ProjectConnectionConfig): EditorialStrategyBody | undefined =>
  genesisEditorialStrategyDefault({
    slug: config.projectId,
    ...(config.editorialVoiceFallback?.audience ? { audience: config.editorialVoiceFallback.audience } : {})
  });

/**
 * Resolve a tenant's editorial strategy: the live governed object first, a genesis default second, and
 * a named warning on every path that is not a decided object.
 *
 * NEVER THROWS and NEVER BLOCKS. Every failure mode — an unknown project, a policy refusal, an
 * unreachable tenant, a missing object, a body that is not one — resolves to a usable-or-absent
 * strategy plus a distinct `warningCode`, exactly the loud-degradation contract getEditorialVoice
 * established. A consumer that gets `source !== "object"` should say so where its own warnings go; it
 * should not stop.
 */
export async function getEditorialStrategy(params: StrategyResolutionParams, deps: StrategyResolutionDeps): Promise<StrategyResolutionResult> {
  const load = async (): Promise<StrategyResolutionResult> => {
    const config = await deps.projectRepository.get(params.projectId);
    if (!config) {
      // NO warningCode here, deliberately, and it mirrors voicePrefetch.ts exactly. An unregistered
      // projectId is a registration gap, not a strategy gap: the voice path returns a silent
      // `{source: "unavailable"}` for the same case, and stamping a run-visible STRATEGY warning on a
      // run whose project has no record at all would blame this loop for somebody else's hole while
      // making a genuinely strategy-less project (project-a) noisy on every dispatch. The prose is
      // still returned for a caller that wants to say something about it.
      return {
        source: "unavailable",
        warning: `Unknown projectId: ${params.projectId}; there is no record to resolve an editorial_strategy object from.`
      };
    }

    // RECORD POINTER FIRST, CONVENTION SECOND. The convention is what makes this loop serve every
    // tenant rather than the configured few: `strat_<slug>` is the platform-side singleton id, the
    // same shape voice_<slug> and vis_<slug> already have, so a genesis-minted tenant carrying no
    // objectDialect at all still has a real address. The pointer stays ahead of it for the tenant
    // whose object genuinely is not at the conventional id.
    const pointer = params.requestedStrategyObjectId?.trim() || config.objectDialect?.strategyObjectId?.trim();
    const objectId = pointer || conventionalStrategyObjectId(config.projectId);
    const objectIdSource: "record" | "convention" = pointer ? "record" : "convention";
    const fallback = recordFallbackStrategy(config);
    const degraded = (warningCode: StrategyResolutionWarningCode, warning: string): StrategyResolutionResult =>
      fallback
        ? { strategy: fallback, source: "fallback", objectId, objectIdSource, warningCode, warning: `${warning} Falling back to a genesis default built from this project's record.` }
        : { source: "unavailable", objectId, objectIdSource, warningCode, warning };

    const arguments_ = { object_type: EDITORIAL_STRATEGY_OBJECT_TYPE, object_id: objectId };
    // Same ordering voicePrefetch.ts uses: the project's executable policy runs before any transport,
    // even though this read never passes through the model-facing controlled-tool gate.
    const policyFindings = getProjectHooks(params.projectId)?.enforceCallToolPolicy?.({ tool: "object_get", arguments: arguments_ }) ?? [];
    const blocking = policyFindings.filter((finding) => finding.severity === "error");
    if (blocking.length) {
      return degraded("strategy_prefetch_blocked", `object_get for the editorial strategy is blocked by executable project policy: ${blocking.map((finding) => finding.code).join(", ")}.`);
    }

    try {
      const call = deps.callReadTool
        ? await deps.callReadTool(config, "object_get", arguments_)
        : await (async () => {
            const adapter = new ProjectMcpAdapter(config);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), STRATEGY_PREFETCH_TIMEOUT_MS);
            try {
              return await adapter.callReadTool("object_get", arguments_, controller.signal);
            } finally {
              clearTimeout(timer);
            }
          })();

      if (!call.ok) {
        return degraded("strategy_prefetch_unreachable", `object_get(${objectId}) failed for project ${params.projectId}: ${call.error ?? "unknown error"}.`);
      }
      const raw = extractStrategyPayload(call.result);
      if (isObject(raw) && raw.not_found === true) {
        // NOT a distinct code. To every consumer, "no strategy object exists" and "a strategy object
        // exists that nobody has decided" mean the identical thing — nobody has told this tenant's
        // pipeline what to commission — so they share one warning an operator can act on once.
        return degraded("strategy_object_unconfigured", `No "${objectId}" editorial_strategy object exists for project ${params.projectId}${objectIdSource === "convention" ? " at the conventional strat_<slug> address" : ""}.`);
      }
      if (!isEditorialStrategyBody(raw)) {
        return degraded("strategy_object_invalid", `The "${objectId}" editorial_strategy object did not match the expected body shape.`);
      }
      if (isGenesisDefaultStrategy(raw)) {
        return {
          strategy: raw,
          source: "default",
          objectId,
          objectIdSource,
          warningCode: "strategy_object_unconfigured",
          warning: `The live "${objectId}" editorial_strategy object is still the genesis default (provenance.set_by="${GENESIS_DEFAULT_SET_BY}"): nobody has decided this tenant's goal, offer, topic weights, angle mix or funnel posture yet. It is being used, and it is not a decision. Editing it (or accepting a strategy-review proposal against it) sets provenance and clears this warning.`
        };
      }
      return { strategy: raw, source: "object", objectId, objectIdSource };
    } catch (error) {
      // Defense in depth: ProjectMcpAdapter's own methods return ok:false rather than throwing, so
      // this should be unreachable — kept so an unexpected throw degrades to the same contract as
      // every other failure here rather than becoming the one path that crashes a caller.
      const message = error instanceof Error ? error.message : String(error);
      return degraded("threw", `Unexpected error fetching the editorial strategy for project ${params.projectId}: ${message}.`);
    }
  };

  if (!params.runId || !deps.cache) return load();
  return deps.cache.getOrLoad(params.runId, `strategy:${params.projectId}:${params.requestedStrategyObjectId ?? ""}`, load);
}
