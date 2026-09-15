// CMP-W1.3 — "This house": the tenant's own standing facts, rendered from the RECORD and its
// genesis singletons rather than from a hand-written code module.
//
// WHAT THIS REPLACES, AND WHY IT MATTERS. `## Registered project knowledge` was `projectHooks`'
// `knowledge` object, stringified. A hook module exists only for the two tenants somebody hand-wrote
// one for (dr-lurie, fernwell); it is `null` for zilberman and for every genesis-minted tenant that
// will ever exist. So the block that was supposed to tell the agent what house it works for printed
// the four characters `null` for the tenants that needed it most — which is the same class of defect
// as the publication-identity incident (W5, 2026-09-13), where an absent block let the model
// confabulate a tagline for a film foundation. Everything below comes from data every tenant has:
// the project record, and the governed singletons genesis mints onto it.
//
// THE SEP-9 RULE, KEPT LITERALLY: an unset singleton renders as "not set — treat as needs-setting,
// never block". It never renders as an omission, never as a default wearing the tenant's name, and
// never as a reason to refuse work. A house with no visual standard yet is the ordinary state of a
// new tenant; a chat that treats it as an error is the defect.
//
// PURE. Every fact is passed in, already resolved (see assembleBriefing.ts for the I/O). That keeps
// this file testable without a tenant, and keeps the "what do we say when it is missing" decisions —
// the whole substance of this module — in one readable place.
import type { EditorialVoiceBody } from "../../projects/projectHooks.js";
import type { EditorialStrategyBody } from "../../projects/genesisEditorialStrategy.js";
import { isGenesisDefaultStrategy } from "../../projects/genesisEditorialStrategy.js";
import type { ReducedContractVisualStandard } from "../../workspace/contractReduction.js";
import type { AutonomyMode } from "./operationsMenu.js";
import { promptSafe } from "./safeReason.js";

export const NOT_SET = "not set — treat as needs-setting, never block";

export type TenantBaselineFacts = {
  publicationName: string;
  autonomyMode: AutonomyMode;
  publishEnabled: boolean;
  strategy?: EditorialStrategyBody;
  /** Why the strategy is absent or provisional, in the resolver's own words. */
  strategyNote?: string;
  voice?: EditorialVoiceBody;
  /** True when the voice came from a fallback rather than the tenant's live governed object. */
  voiceIsFallback?: boolean;
  visualStandard?: ReducedContractVisualStandard;
  /** `projectHooks.knowledge` — present for the two code-defined tenants, absent for every minted one. */
  hookKnowledge?: unknown;
};

const line = (label: string, value: string): string => `- ${label}: ${value}`;

// Every one of these strings is a TENANT-authored field (an editorial strategy this very agent can
// write, a visual standard's labels, a hook module's knowledge object). They render outside the
// untrusted-JSON marker and — unlike the bound object — they are CACHED, so one poisoned governed
// object would reach every conversation on the tenant until the entry expired. `promptSafe` both
// bounds and de-structures them; a review finding on this change, not a precaution.
const truncate = (value: string, max: number): string => promptSafe(value, max);

// A one-line reading of the funnel dials, because the numbers themselves say nothing to a reader who
// has not read the schema. Flat (every dial within 0.02 of a third) is genesis' deliberate "nobody
// has chosen" signal — reported as that, not as a posture.
const funnelPosture = (strategy: EditorialStrategyBody): string => {
  const { tofu, mofu, bofu } = strategy.funnel_aggression;
  const flat = [tofu, mofu, bofu].every((share) => Math.abs(share - 1 / 3) <= 0.02);
  if (flat) return "even across the funnel — nobody has chosen a posture yet";
  const ranked = ([["top", tofu], ["middle", mofu], ["bottom", bofu]] as const).slice().sort((left, right) => right[1] - left[1]);
  return `weighted toward the ${ranked[0][0]} of the funnel`;
};

const renderStrategy = (facts: TenantBaselineFacts): string[] => {
  const strategy = facts.strategy;
  if (!strategy) return [line("Editorial strategy", `${NOT_SET}${facts.strategyNote ? ` (${facts.strategyNote})` : ""}`)];
  const provisional = isGenesisDefaultStrategy(strategy);
  return [
    line("Goal", truncate(strategy.goal, 300)),
    line("Offer", truncate(strategy.offer, 300)),
    line("Audience", strategy.audience_segments.length ? strategy.audience_segments.map((segment) => truncate(segment, 120)).join("; ") : NOT_SET),
    line("Topic weights", strategy.topic_weights.length ? strategy.topic_weights.map((weight) => `${truncate(String(weight.label ?? weight.term_id ?? "unlabelled"), 80)} ${weight.weight}`).join(", ") : `${NOT_SET} (the tenant's taxonomy is the only honest source for these)`),
    line("Angle mix", strategy.angle_mix.length ? strategy.angle_mix.map((angle) => `${truncate(angle.angle, 60)} ${Math.round(angle.share * 100)}%`).join(", ") : NOT_SET),
    line("Funnel posture", funnelPosture(strategy)),
    line("Cadence", truncate(strategy.cadence, 200)),
    // Said out loud, every turn, on purpose. A provisional strategy is USED and is NOT A DECISION,
    // and an agent that cannot tell the two apart will cite genesis' own placeholder back to an
    // editor as though somebody chose it.
    ...(provisional ? [line("Strategy status", "provisional — written at genesis, never reviewed by a human. Use it, do not cite it as a decision, and offer to settle it when the conversation touches it.")] : [])
  ];
};

// STATUS ONLY, and a pointer. The full voice body already travels in its own `## Registered project
// voice` block (G6's record-first path), so repeating tone, lexicon and policies here would spend
// the briefing's whole size budget saying twice what the prompt already says once. What that block
// cannot say is whether anybody DECIDED this voice — and that is the fact that changes behaviour.
const renderVoice = (facts: TenantBaselineFacts): string[] => {
  if (!facts.voice) return [line("Editorial voice", NOT_SET)];
  return [line(
    "Editorial voice",
    facts.voiceIsFallback
      ? `${truncate(facts.voice.name, 120)} — a FALLBACK, not the decided voice: nobody has authored this tenant's governed voice object yet. Write to it, and offer to settle it when the conversation touches voice. Full body below.`
      : `${truncate(facts.voice.name, 120)} — the tenant's decided voice. Full body below; follow it.`
  )];
};

const renderVisualStandard = (facts: TenantBaselineFacts): string[] => {
  const standard = facts.visualStandard;
  // houseStatus, never houseId's absence, decides what to say — the exact distinction the
  // chat-recovery fix added it for: "this site has no standard yet" and "the read that would have
  // told me degraded" call for opposite behaviour, and neither is an error.
  if (!standard || standard.houseStatus === "unknown") return [line("Visual standard", "could not be read this turn — say so rather than assuming the house has none.")];
  if (standard.houseStatus === "none") return [line("Visual standard", `${NOT_SET}. Imagery for this house has no standard to follow yet; offer to settle one when imagery comes up.`)];
  return [
    line("Visual standard", `the house standard is in force${standard.templates.length ? `, with named templates: ${standard.templates.map((template) => truncate(template.label, 80)).join(", ")}` : ""}`),
    // The one sentence that changes behaviour, and the reason the standard is in the briefing at
    // all: rev 8 had no opinion, so imagery requests turned into questions about look and feel.
    line("How to use it", "it is a STYLE INPUT for the images you commission, not a thing to ask the editor about."),
    ...(standard.overridePolicy === "lock" ? [line("Brand imagery", "locked — this site refuses per-article overrides of its brand imagery.")] : [])
  ];
};

/**
 * The "This house" block.
 *
 * Identical in SHAPE for a hooked tenant and a data-defined one — that is the invariant worth
 * protecting. `hookKnowledge` is appended as one clearly-labelled extra line when a code module
 * exists, so dr-lurie keeps everything it had, and nothing about the block's structure tells the
 * model which kind of tenant it is talking about.
 */
export const renderTenantBaseline = (facts: TenantBaselineFacts): string => {
  const autonomy = facts.autonomyMode === "autonomous"
    ? "autonomous — registered operations and bounded edits run without asking. Approvals apply only where a tool's own floor or a guardrail demands them."
    : "operator-gated — propose the work and get one yes before starting it.";
  return [
    "### This house",
    line("Publication", truncate(facts.publicationName, 160)),
    line("How this house runs", autonomy),
    line("Publishing", facts.publishEnabled ? "enabled" : "disabled for this tenant — do not promise a publish you cannot perform."),
    ...renderStrategy(facts),
    ...renderVoice(facts),
    ...renderVisualStandard(facts),
    ...(facts.hookKnowledge !== undefined && facts.hookKnowledge !== null
      ? [line("Registered project knowledge", truncate(JSON.stringify(facts.hookKnowledge), 1_500))]
      : [])
  ].join("\n");
};
