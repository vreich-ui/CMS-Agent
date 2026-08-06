// GUI rework Session B: fetches a client's editorial voice deterministically — a plain function call
// the conductor makes before dispatching a voice-consuming node, not a tool the model invokes from
// inside its own agent loop — mirroring contractPrefetch.ts's F1 pattern exactly (same RunScopedCache,
// same "resolve a project-declared id, never guess" posture, same named-warning-on-degradation
// convention as prefetch_object_type_unresolved) so this optimization never repeats
// contract_intelligence's mistake: re-fetching inside a node's own loop measured at $10.87 across this
// project's history before F1 existed.
//
// UNLIKE contract prefetch, a missing or unreachable voice must NOT fail the node — Dr. Lurie's seeded
// editorialVoice.ts fallback (surfaced per-project via getProjectHooks(...).editorialVoiceFallback) is
// the safety net that keeps a run completing even when the live voice_<project> object is absent or
// the site is unreachable. The degradation is never silent: getEditorialVoice always reports a
// distinct `warningCode` when it did not return the live object, so the executor can stamp a
// run-visible warning ("the live voice degraded to the seed" is then a run-level fact, not something
// inferable only by reading this one node's input).
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { getProjectHooks } from "../projects/projectHooks.js";
import type { EditorialVoiceBody } from "../projects/projectHooks.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { conductorCache, type RunScopedCache } from "./conductor.js";

export type VoicePrefetchWarningCode =
  | "voice_project_unresolved"
  | "voice_object_unconfigured"
  | "voice_prefetch_blocked"
  | "voice_prefetch_unreachable"
  | "voice_object_not_found"
  | "voice_object_invalid"
  | "threw";

export type VoicePrefetchResult = {
  // Absent only when the live object could not be used AND the project contributes no fallback (i.e.
  // the voice concept is not wired for this project at all) — never absent for a project that HAS a
  // fallback registered.
  voice?: EditorialVoiceBody;
  source: "live" | "fallback" | "unavailable";
  // Present whenever source !== "live": names exactly why the live object was not used, the same
  // "distinct code plus prose naming the remedy" contract prefetch_object_type_unresolved uses.
  warningCode?: VoicePrefetchWarningCode;
  warning?: string;
};

export type VoicePrefetchParams = { runId: string; projectId: string; requestedVoiceObjectId?: string };
export type VoicePrefetchDeps = { projectRepository: ProjectRepository; cache?: RunScopedCache };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Same fix as contractPrefetch.ts's CONTRACT_PREFETCH_TIMEOUT_MS, for the identical reason: this call
// bypasses executeTool entirely (deterministic conductor code, not a model-invoked tool) and so never
// inherited a timeout at all. A hung remote here degrades gracefully anyway (source: "fallback" via
// voice_prefetch_unreachable, never a failed node — see getEditorialVoice below) but "gracefully" only
// if it degrades at ALL rather than hanging the node dispatch forever waiting on a dead connection.
const VOICE_PREFETCH_TIMEOUT_MS = 15_000;

// object_get's structuredContent/content[] shape mirrors object_contract's (see contractPrefetch.ts's
// extractContractPayload): prefer structuredContent (checking a couple of plausible nesting keys, then
// the structured value itself), and parse the content[] text block only when structuredContent is
// entirely absent. Never assumed beyond what THIS call actually returned.
function extractVoicePayload(result: unknown): unknown {
  if (!isObject(result)) return result;
  const structured = result.structuredContent;
  if (isObject(structured)) {
    if (isObject(structured.object)) return structured.object;
    if (isObject(structured.record)) return structured.record;
    return structured;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.find((block): block is { text: string } => isObject(block) && typeof block.text === "string")?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  return result;
}

// Shape check against the live editorial_voice contract's required fields (see projectHooks.ts /
// editorialVoice.ts). Deliberately loose on frameworks[]' internal shape — this workspace never
// enforces the live contract's strictness itself, it only decides whether what came back is usable
// enough to hand a node as `editorialVoice` rather than falling back.
function isVoiceBody(value: unknown): value is EditorialVoiceBody {
  if (!isObject(value)) return false;
  const lexicon = value.lexicon;
  return typeof value.name === "string"
    && typeof value.audience === "string"
    && Array.isArray(value.tone)
    && typeof value.cadence === "string"
    && isObject(lexicon) && Array.isArray(lexicon.prefer) && Array.isArray(lexicon.avoid)
    && typeof value.claim_policy === "string"
    && typeof value.cta_policy === "string"
    && typeof value.reader_safety_notes === "string"
    && Array.isArray(value.frameworks)
    && typeof value.default_framework === "string";
}

export async function getEditorialVoice(params: VoicePrefetchParams, deps: VoicePrefetchDeps): Promise<VoicePrefetchResult> {
  const cache = deps.cache ?? conductorCache;
  const cacheKey = `voice:${params.projectId}`;
  return cache.getOrLoad(params.runId, cacheKey, async (): Promise<VoicePrefetchResult> => {
    const fallback = getProjectHooks(params.projectId)?.editorialVoiceFallback;

    const config = await deps.projectRepository.get(params.projectId);
    if (!config) {
      if (!fallback) return { source: "unavailable" };
      return {
        voice: fallback,
        source: "fallback",
        warningCode: "voice_project_unresolved",
        warning: `Unknown projectId: ${params.projectId}; falling back to the seeded editorial voice.`
      };
    }

    const voiceObjectId = params.requestedVoiceObjectId ?? config.objectDialect?.voiceObjectId;
    if (!voiceObjectId) {
      // No live-voice convention declared for this project at all — a project this genuinely does
      // not apply to (e.g. platform, today) is a clean no-op, not a defect, UNLESS it also carries a
      // fallback (meaning it DOES have an editorial voice concept, just not yet a live object id).
      if (!fallback) return { source: "unavailable" };
      return {
        voice: fallback,
        source: "fallback",
        warningCode: "voice_object_unconfigured",
        warning: `Project "${params.projectId}" declares no objectDialect.voiceObjectId; falling back to the seeded editorial voice instead of a live "editorial_voice" object. Configure objectDialect.voiceObjectId (see projectTypes.ts) to read the live voice.`
      };
    }

    const arguments_ = { object_type: "editorial_voice", object_id: voiceObjectId };
    // Same ordering contractPrefetch.ts uses: the project's executable policy runs before any
    // transport, even though this call never goes through the controlled-tool/model-facing gate.
    const policyFindings = getProjectHooks(params.projectId)?.enforceCallToolPolicy?.({ tool: "object_get", arguments: arguments_ }) ?? [];
    const blocking = policyFindings.filter((finding) => finding.severity === "error");
    if (blocking.length) {
      const warning = `object_get for the editorial voice is blocked by executable project policy: ${blocking.map((finding) => finding.code).join(", ")}.`;
      if (!fallback) return { source: "unavailable", warningCode: "voice_prefetch_blocked", warning };
      return { voice: fallback, source: "fallback", warningCode: "voice_prefetch_blocked", warning: `${warning} Falling back to the seeded editorial voice.` };
    }

    try {
      const adapter = new ProjectMcpAdapter(config);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), VOICE_PREFETCH_TIMEOUT_MS);
      let call: Awaited<ReturnType<typeof adapter.callReadTool>>;
      try {
        call = await adapter.callReadTool("object_get", arguments_, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      if (!call.ok) {
        const warning = `object_get(${voiceObjectId}) failed for project ${params.projectId}: ${call.error ?? "unknown error"}.`;
        if (!fallback) return { source: "unavailable", warningCode: "voice_prefetch_unreachable", warning };
        return { voice: fallback, source: "fallback", warningCode: "voice_prefetch_unreachable", warning: `${warning} Falling back to the seeded editorial voice.` };
      }
      const raw = extractVoicePayload(call.result);
      if (isObject(raw) && raw.not_found === true) {
        const warning = `No live "${voiceObjectId}" editorial_voice object exists for project ${params.projectId}.`;
        if (!fallback) return { source: "unavailable", warningCode: "voice_object_not_found", warning };
        return { voice: fallback, source: "fallback", warningCode: "voice_object_not_found", warning: `${warning} Falling back to the seeded editorial voice.` };
      }
      if (!isVoiceBody(raw)) {
        const warning = `The live "${voiceObjectId}" editorial_voice object did not match the expected body shape.`;
        if (!fallback) return { source: "unavailable", warningCode: "voice_object_invalid", warning };
        return { voice: fallback, source: "fallback", warningCode: "voice_object_invalid", warning: `${warning} Falling back to the seeded editorial voice.` };
      }
      return { voice: raw, source: "live" };
    } catch (error) {
      // Defense in depth: ProjectMcpAdapter's own methods already catch and return ok:false rather
      // than throwing, so this branch should be unreachable in practice — kept so an unexpected throw
      // degrades to the same loud-fallback contract as every other failure mode here, never a crash.
      const message = error instanceof Error ? error.message : String(error);
      const warning = `Unexpected error fetching the editorial voice for project ${params.projectId}: ${message}.`;
      if (!fallback) return { source: "unavailable", warningCode: "threw", warning };
      return { voice: fallback, source: "fallback", warningCode: "threw", warning: `${warning} Falling back to the seeded editorial voice.` };
    }
  });
}
