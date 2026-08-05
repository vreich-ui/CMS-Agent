// Dr. Lurie's editorial voice and domain caution — the CLIENT layer's copy of everything the shared
// workspace layer used to carry for this one client.
//
// The node-system overhaul made the shared editorial baseline truly client-neutral: clarity craft +
// DTC writing craft + the universal safeguards (no overclaiming, no fabricated evidence or urgency,
// no invented sources, reader-visible strings never leak internal vocabulary, low-pressure next
// steps) — and nothing else. Medical/health caution is not universal craft; it is Dr. Lurie's, so it
// moved HERE rather than being deleted.
//
// P-2 CLOSED (GUI rework Session B, 2026-08-05): the live `voice_drlurie` editorial_voice object now
// exists (object_contract("editorial_voice") confirmed against Dr. Lurie; voice_drlurie is published,
// content_revision 1, status active). The conductor prefetches it once per run, deterministically,
// before dispatching a voice-consuming node (see ../../workspace/voicePrefetch.ts) — the SAME pattern
// contractPrefetch.ts uses for the client's content contract, for the same reason: a node that instead
// discovers its voice via a tool call inside its own agent loop re-sends it every turn, which is
// exactly what made contract_intelligence cost $10.87 across this project's history before F1.
//
// DR_LURIE_VOICE_SOURCE / DR_LURIE_DOMAIN_CAUTION below are the ORIGINAL text this file carried before
// the live object existed; they are kept verbatim as historical record (the retired
// `dr_lurie_dtc_science_editorial` skill's actual instructions) but are no longer delivered to any
// node — they are not shaped like the live `editorial_voice` object_contract body and nothing reads
// them at runtime anymore. DR_LURIE_VOICE_FALLBACK below IS what a Dr. Lurie run actually falls back
// to: it is shaped exactly like the live object body (name/audience/tone/cadence/lexicon/
// claim_policy/cta_policy/reader_safety_notes/frameworks/default_framework) and is used ONLY when
// voice_drlurie is unconfigured, unreachable, or missing — never silently: voicePrefetch.ts always
// stamps a named, run-visible warning (voice_prefetch_fallback:<code>) when this seed is used instead
// of the live object, mirroring contractPrefetch.ts's prefetch_object_type_unresolved convention. A
// missing client voice record is a visible degradation, never a reason to fail the run outright.

// Verbatim instructions of the branded skill `dr_lurie_dtc_science_editorial` v2 (skill store
// version_1784638425007_nrtm6a, created 2026-07-21), preserved before the skill's rename to the
// client-neutral `editorial_craft`. This is Dr. Lurie's actual voice.
export const DR_LURIE_VOICE_SOURCE = {
  skillId: "dr_lurie_dtc_science_editorial",
  versionId: "version_1784638425007_nrtm6a",
  name: "Dr. Lurie DTC science editorial",
  description: "Editorial direction for Dr. Lurie skincare/science content: evidence-aware, warm, direct-to-consumer, conversion-aware without hype.",
  instructions: "Write for a smart skincare reader who wants calm authority, not a lecture. The voice is precise, warm, practical, and commercially aware. Favor concrete routines, decision points, tradeoffs, and reassurance. Do not overclaim medical outcomes, imply diagnosis, or turn uncertainty into certainty. For DTC direction, connect education to reader action: newsletter signup, related reading, product/resource consideration, or a low-pressure next step. Avoid hype, fear tactics, fake urgency, and generic wellness language. Preserve Dr. Lurie's styling direction: science-led, elegant, clean, reader-first, and specific to skin health. Reader-visible copy must never expose internal strategy labels, prompts, scoring, private notes, or workflow language."
} as const;

// Domain caution that used to sit inside the SHARED node prompts (topic_opportunity, research,
// brief_architect, draft_writer, trust_factual) and applied Dr. Lurie's health-content bar to every
// client. Removed from the shared layer verbatim below; a Dr. Lurie run re-acquires it through this
// client record.
export const DR_LURIE_DOMAIN_CAUTION = {
  researchTriggers: "Treat scientific and medical-adjacent claims as source-sensitive: recommend deep research for them, prefer primary scientific, clinical, or regulatory pages, and never leave a health claim resting on secondary commentary.",
  claimSafety: "Never state unsupported medical certainty. Do not imply diagnosis, promise clinical outcomes, or turn uncertainty into certainty; soften to practical phrasing when evidence is limited.",
  reviewBar: "Factual review must flag overconfident medical language and medical/compliance risk explicitly, and unsafe medical certainty is a blocker, not a revision note.",
  audienceFrame: "Write for a science-minded skincare reader: evidence-led framing, concrete routines and decision points, reassurance over alarm."
} as const;

export type DrLurieEditorialVoice = { voiceSource: typeof DR_LURIE_VOICE_SOURCE; domainCaution: typeof DR_LURIE_DOMAIN_CAUTION };

// Shape of the live `editorial_voice` object_contract body (confirmed live against Dr. Lurie,
// 2026-08-05): required fields name, audience, tone[], cadence, lexicon{prefer[],avoid[]},
// claim_policy, cta_policy, reader_safety_notes, frameworks[] (each framework_id/label/
// description/when_to_use/beats[]), default_framework. additionalProperties: false server-side, but
// this workspace-side type stays permissive (description/beats optional) so a live payload that
// omits an optional-in-practice field is never rejected by OUR shape check — the live contract is the
// only authority on strictness, this type only describes what a node can read.
export type EditorialVoiceLexicon = { prefer: string[]; avoid: string[] };
export type EditorialVoiceFramework = { framework_id: string; label: string; description?: string; when_to_use: string; beats?: string[] };
export type EditorialVoiceBody = {
  name: string;
  audience: string;
  tone: string[];
  cadence: string;
  lexicon: EditorialVoiceLexicon;
  claim_policy: string;
  cta_policy: string;
  reader_safety_notes: string;
  frameworks: EditorialVoiceFramework[];
  default_framework: string;
};

// The FALLBACK/SEED editorial voice for Dr. Lurie — what voicePrefetch.ts hands a voice-consuming
// node when the live `voice_drlurie` object is unconfigured, unreachable, or missing. Shaped exactly
// like the live object body (not like DR_LURIE_VOICE_SOURCE/DR_LURIE_DOMAIN_CAUTION above, which
// predate the live contract and are kept only as historical record). Content is drawn from the same
// editorial direction those two constants already carried, re-expressed in the live shape; it is a
// SEED, not a synced mirror — if Dr. Lurie's live voice changes, this constant does not follow
// automatically and must be updated here deliberately, the same way any other fallback default would.
export const DR_LURIE_VOICE_FALLBACK: EditorialVoiceBody = {
  name: "Dr. Lurie — evidence-led skin health (seed fallback)",
  audience: "Adults making decisions about their own skin, most arriving from a search with a specific worry and no clinical training. They are capable of nuance and are tired of being sold to.",
  tone: ["warm", "calm", "evidence-led", "non-alarmist"],
  cadence: "Conversational but disciplined. Short sentences carry the medical content; longer ones carry the reassurance. Second person for the reader, third person for the science. Paragraphs stay under four sentences so a worried reader can scan without losing the thread.",
  lexicon: {
    prefer: ["evidence", "studies suggest", "in most people", "your dermatologist", "ingredient", "routine", "barrier"],
    avoid: ["miracle", "cure", "detox", "toxin", "chemical-free", "anti-aging", "flawless", "clinically proven", "guaranteed", "reverse"]
  },
  claim_policy: "Efficacy statements are hedged to the strength of the evidence behind them and attributed in-line. No claim to treat, cure, prevent, or diagnose any condition. Individual variation is stated wherever an outcome is described. A claim without a citable source is cut rather than softened into vagueness.",
  cta_policy: "At most one ask per article, and it is always the low-commitment one — read the next piece, or raise it with a clinician. Never urgency, never scarcity, never a purchase framed as a health necessity.",
  reader_safety_notes: "Consumer health audience with no clinical training: an over-confident sentence here can delay real care. Anything that could read as a diagnosis, a dosage, or a substitute for seeing a clinician is out. Content touching pregnancy, minors, prescription actives, or procedures carries the see-a-professional boundary in the body, not only in a footer disclaimer. Before/after framing that implies a guaranteed outcome is refused.",
  frameworks: [
    {
      framework_id: "fw_concern",
      label: "Concern explainer",
      description: "Explains a symptom or fear the reader arrived with: what it is, what commonly causes it, and what a reasonable next step looks like.",
      when_to_use: "The reader arrived with a symptom or a fear.",
      beats: ["Name the concern plainly", "Explain the likely mechanism", "Separate what's known from what's uncertain", "Give a low-pressure next step"]
    },
    {
      framework_id: "fw_ingredient",
      label: "Ingredient review",
      description: "Reviews a single named ingredient: what it does, the evidence behind it, who it suits, and reasonable expectations.",
      when_to_use: "The subject is a named ingredient rather than a symptom.",
      beats: ["What it is and what it claims to do", "What the evidence actually shows", "Who it suits and who should be cautious", "How it fits a routine"]
    },
    {
      framework_id: "fw_routine",
      label: "Routine guide",
      description: "Walks the reader through an ordered sequence rather than a single explanation.",
      when_to_use: "The reader wants a sequence, not an explanation.",
      beats: ["State the goal of the routine", "Order the steps and why the order matters", "Flag common mistakes", "Note when to adjust or stop"]
    },
    {
      framework_id: "fw_myth",
      label: "Myth check",
      description: "Corrects a persistent false belief without ridicule, replacing it with the accurate, practical version.",
      when_to_use: "The topic is a persistent false belief.",
      beats: ["State the myth neutrally", "Explain why it's wrong", "Give the accurate version", "Give the practical takeaway"]
    }
  ],
  default_framework: "fw_concern"
};
