// Dr. Lurie's editorial voice and domain caution — the CLIENT layer's copy of everything the shared
// workspace layer used to carry for this one client.
//
// The node-system overhaul made the shared editorial baseline truly client-neutral: clarity craft +
// DTC writing craft + the universal safeguards (no overclaiming, no fabricated evidence or urgency,
// no invented sources, reader-visible strings never leak internal vocabulary, low-pressure next
// steps) — and nothing else. Medical/health caution is not universal craft; it is Dr. Lurie's, so it
// moved HERE rather than being deleted. This module is the source material for the future
// `vox_drlurie_default` voice record (P-2): when that record exists, the conductor delivers it in
// node input for Dr. Lurie runs and this file's text stops being load-bearing prose and becomes its
// seed. A missing client record is a named blocker (client_project_unresolved), never a reason for
// the shared layer to grow client-specific filler again.

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
