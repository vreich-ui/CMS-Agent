import type { EditorialVoiceBody } from "../drLurie/editorialVoice.js";

// Shape mirrors Platform's committed voice-seed-data.mjs editorial_voice body. It is used only
// when the live Fernwell voice record cannot be prefetched; the live object remains authoritative.
export const FERNWELL_VOICE_FALLBACK: EditorialVoiceBody = {
  name: "Fernwell — considered, unhurried",
  audience: "Readers browsing without a specific task, willing to spend a few minutes on something well made. They are skeptical of hype and notice when they are being handled.",
  tone: ["considered", "unhurried", "concrete", "quietly confident"],
  cadence: "Varied sentence length with a bias toward the short one at the end of a paragraph. Third person by default; second person only when addressing a choice the reader is actually making. Concrete nouns over abstractions.",
  lexicon: {
    prefer: ["made", "chosen", "lasts", "in practice", "trade-off", "worth"],
    avoid: ["curated", "elevate", "game-changing", "must-have", "obsessed", "iconic", "effortless", "luxe"]
  },
  claim_policy: "Comparative and superlative claims need a stated basis in the same sentence. Sponsored or affiliate relationships are disclosed at the top, not the bottom. An unverifiable claim is cut.",
  cta_policy: "One ask per page at most, stated plainly and placed after the reader has been given something. No countdowns, scarcity language, or interstitials.",
  reader_safety_notes: "General audience with no assumed expertise. Nothing here is medical, legal, or financial guidance, and content that would drift toward any of the three is either reframed or declined. No content addressed to minors.",
  frameworks: [
    { framework_id: "fw_feature", label: "Feature", description: "One subject examined closely, built on specifics rather than a summary of the category.", when_to_use: "The subject is singular and interesting on its own. The default when nothing else fits.", beats: ["The hook", "The specifics", "The trade-offs", "What it comes down to"] },
    { framework_id: "fw_comparison", label: "Comparison", description: "Two or more options judged against criteria stated up front, before any verdict.", when_to_use: "The reader has a choice to make between named options. Pick this only when the criteria can be stated honestly before the winner is known.", beats: ["The criteria", "Option by option", "Where each wins", "The recommendation and who it is wrong for"] }
  ],
  default_framework: "fw_feature"
};
