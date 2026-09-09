// G6 tier 1 — the provisional editorial voice a minted tenant is born with.
//
// THE GAP. `getEditorialVoice` resolves `objectDialect.voiceObjectId` and reads a live
// `editorial_voice` object; with neither that pointer nor a fallback it returns `{source:
// "unavailable"}`, and five prefetch nodes (topic_opportunity, research, brief_architect,
// draft_writer, trust_factual) plus `visual_identity_propose` then run with no voice at all. Only
// dr-lurie and fernwell escaped that, and only because each carries a hand-written
// `*_VOICE_FALLBACK` in code — which is precisely the "tenant identity lives in code" pattern
// genesis parity exists to end.
//
// WHY THIS IS A FALLBACK AND NOT AN OBJECT. Writing a body generated from two input strings into
// `voice_<slug>` and pointing `objectDialect.voiceObjectId` at it would make every node treat
// boilerplate as the tenant's DECIDED voice — indistinguishable, at the point of use, from one an
// editor authored. A fallback is the honest shape for a guess: `getEditorialVoice` labels it
// `source: "fallback"` with `warningCode: "voice_object_unconfigured"`, so every consumer can tell
// the difference. The real voice is tier 2 — an editorial-voice writer node run at birth, the same
// way `runVisualIdentityHouse` writes the house visual standard — and until that node exists there
// is no object and no pointer.
//
// The wording below is deliberately thin. It states what genesis actually knows (the niche and
// audience it was given) and commits to nothing it does not: no house style, no claims posture
// invented for a client nobody has interviewed. Thin and labelled beats rich and fabricated.
import type { EditorialVoiceBody } from "./projectHooks.js";

export const GENESIS_VOICE_FRAMEWORK_ID = "plain_explainer";

/**
 * Build the provisional voice for a newly minted tenant. Returns undefined when genesis was given
 * neither a niche nor an audience: with nothing to say about the tenant, a "fallback" would be pure
 * boilerplate wearing the tenant's name, and `{source: "unavailable"}` is the more truthful state.
 */
export function genesisEditorialVoiceFallback(input: { slug: string; niche?: string; audience?: string }): EditorialVoiceBody | undefined {
  const niche = input.niche?.trim();
  const audience = input.audience?.trim();
  if (!niche && !audience) return undefined;

  const subject = niche || `${input.slug}'s subject area`;
  return {
    name: `${input.slug} — provisional voice (genesis)`,
    audience: audience || `general readers arriving on ${subject}`,
    tone: ["clear", "specific", "unhurried", "non-promotional"],
    cadence: "Short paragraphs. One idea per paragraph. Concrete nouns before abstractions.",
    lexicon: {
      prefer: ["plain words", "the reader's own terms", "specific quantities"],
      avoid: ["hype", "superlatives", "unearned certainty", "filler transitions"]
    },
    claim_policy:
      "State only what the source material supports. Attribute anything contested. Do not assert outcomes, results or guarantees that the tenant has not published.",
    cta_policy:
      "At most one call to action, at the end, and only when the page genuinely has a next step. Never mid-article.",
    reader_safety_notes:
      `This voice was generated at genesis from the niche and audience supplied then; nobody has reviewed it. Treat it as a floor, not a house style, and do not let it license claims about ${subject} that the tenant's own material does not make.`,
    frameworks: [
      {
        framework_id: GENESIS_VOICE_FRAMEWORK_ID,
        label: "Plain explainer",
        description: "Answer the reader's question directly, then give the reasoning behind the answer.",
        when_to_use: "Any article, until an editor decides this tenant needs something else."
      }
    ],
    default_framework: GENESIS_VOICE_FRAMEWORK_ID
  };
}
