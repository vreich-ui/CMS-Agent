// T15.17 — initial playbook seeds for the six judgment nodes (capture and clone conductors).
// These seeds establish baseline strategies, pitfalls, and constraints extracted from each
// node's canonical prompt and documented behavior patterns.
//
// Each seed is a PlaybookDelta ready for playbook.apply_delta; seeds are applied once during
// workspace initialization via a separate integration seeding pass (never at test time).

import type { PlaybookDelta } from "./improvementTypes.js";

// block_classifier: judges blocks the heuristic mapper declined, proposing a governed sectionType.
// Extracted from: captureConductorNodes.ts block_classifier prompt, T12.23 classifier vocabulary.
export const blockClassifierSeed: PlaybookDelta = {
  add: [
    {
      text: "STRUCTURAL types (faq, comparison_table, testimonial, stats, timeline, steps, checklist) are matched from block.structure in the snapshot — never from prose alone. Suggesting a structural type for a block without the matching recovered DOM shape leads to builder rejection.",
      kind: "pitfall",
      provenance: { source: "human" }
    },
    {
      text: "content_embed is first-class: recognized providers are placed automatically before classification. A ledger entry with nearestType 'content_embed' is NOT a block to retype — it means the provider was unrecognized or declined by policy. Never propose content_embed from the vocabulary.",
      kind: "constraint",
      provenance: { source: "human" }
    },
    {
      text: "The declined blocks ledger is your ONLY jurisdiction. Never re-judge blocks the mapper already mapped; every suggestion must correspond to a declinedBlocks entry with matching blockRef.",
      kind: "constraint",
      provenance: { source: "human" }
    },
    {
      text: "Prefer the plainest type the block's own evidence can fill. An out-of-spec suggestion (type that requires data the block structure does not provide) is rejected by the deterministic builder, so the block stays declined.",
      kind: "strategy",
      provenance: { source: "human" }
    }
  ]
};

// gap_adjudicator: adjudicates residual gaps into W10 evidence feed entries and run report summary.
// Extracted from: captureConductorNodes.ts gap_adjudicator prompt, T12.6 gap disposition framework.
export const gapAdjudicatorSeed: PlaybookDelta = {
  add: [
    {
      text: "Four disposition classes: capability_backlog (feature does not exist in platform), source_quality (source was incomplete/malformed), policy_boundary (policy forbids capture/use), needs_human_review (judgment call needed). Classify every gap into exactly one.",
      kind: "strategy",
      provenance: { source: "human" }
    },
    {
      text: "Each gap needs a single most useful recommendation: a next action for an operator or a backlog item. Honest gaps get honest recommendations; a gap with no clear path forward is a valid entry — say so rather than inventing a fix.",
      kind: "strategy",
      provenance: { source: "human" }
    },
    {
      text: "The humanSummary is what an operator READS FIRST to understand the run. Brevity and honesty matter more than comprehensiveness. Name the top capability miss, source quality issue, or policy boundary; surface any needs_human_review gaps; close with the run's verdict.",
      kind: "constraint",
      provenance: { source: "human" }
    },
    {
      text: "Never invent gapIds. Adjudicate only gaps that exist in the fidelity report; silently inventing entries means an operator never sees that work.",
      kind: "pitfall",
      provenance: { source: "human" }
    }
  ]
};

// layout_analyst: judges structural divergences between source and emitted shapes, identifying where recipes could help.
// Extracted from: cloneConductorNodes.ts layout_analyst prompt, clone structure-divergence contract.
export const layoutAnalystSeed: PlaybookDelta = {
  add: [
    {
      text: "Compare sourceShape (source's ordered block types) against emittedShape (registered section types actually written). That contrast IS your evidence — never assert a source fact these shapes do not support.",
      kind: "constraint",
      provenance: { source: "human" }
    },
    {
      text: "For each divergence, answer: could a NEW RECIPE close it? section_template for repeated arrangements within/across pages, template for whole-page slot sequences that need a blueprint, none for gaps needing behavior (code), source quality (bad input), or policy boundaries.",
      kind: "strategy",
      provenance: { source: "human" }
    },
    {
      text: "'none' is a real and common answer. Do NOT propose new section types — those are code, they ship in releases. If a genuine need has no registered type, record it in unmetNeeds and move on.",
      kind: "pitfall",
      provenance: { source: "human" }
    },
    {
      text: "Check budget.truncated first. If the briefing dropped something (truncated flag non-empty), say what was lost and how it limits your analysis rather than pretending you saw everything.",
      kind: "constraint",
      provenance: { source: "human" }
    }
  ]
};

// recipe_designer: designs recipes (section_template or page template) to close layout divergences.
// Extracted from: cloneConductorNodes.ts recipe_designer prompt, recipe reuse-first law.
export const recipeDesignerSeed: PlaybookDelta = {
  add: [
    {
      text: "REUSE FIRST: before designing, check clone_intake.recipes for existing recipes that already fit the divergence. An existing near-match is better than a new duplicate that splits future stamping.",
      kind: "strategy",
      provenance: { source: "human" }
    },
    {
      text: "Vocabulary is FIXED: compose only from registry.sectionTypes (you have the field names; you cannot check enums so prefer plainest values). Do NOT invent section types; they are .astro components that ship in releases. Unmet needs go to unmetNeeds, not approximations.",
      kind: "constraint",
      provenance: { source: "human" }
    },
    {
      text: "For page templates, appliesTo page types must satisfy registry.pageTypes' allowed/required sets. Never assume — read the registry rather than guessing page-type compatibility.",
      kind: "pitfall",
      provenance: { source: "human" }
    },
    {
      text: "Cite only identifiers that exist in the briefing (pageRef, candidateId). A name you invent cannot be resolved downstream and silently drops the work.",
      kind: "constraint",
      provenance: { source: "human" }
    }
  ]
};

// theme_reconciler: re-validates theme proposals and applies them to sites.
// Extracted from: cloneConductorNodes.ts theme_reconciler prompt, totality contract and site_apply_theme law.
export const themeReconcilerSeed: PlaybookDelta = {
  add: [
    {
      text: "site_apply_theme is the ONLY legal route to write brandTokens. Never hand-author set_site_fields with brandTokens; that verb is forbidden. The tool computes the op itself and will reject an incomplete theme (missing keys the site carries).",
      kind: "constraint",
      provenance: { source: "human" }
    },
    {
      text: "Totality law: every color key the site carries but the theme lacks is UNSET. An incomplete proposal is REJECTED naming missing keys — do not backfill them yourself. Inventing a brand color is worse than not applying the theme.",
      kind: "pitfall",
      provenance: { source: "human" }
    },
    {
      text: "If dry_run reports totality rejection or a token fails a bound, refuse with the reason named — do not attempt to fix it. A refusal is honest; a broken or incomplete theme shipped is a customer-visible mistake.",
      kind: "strategy",
      provenance: { source: "human" }
    },
    {
      text: "Sequence: validate proposal against bounds -> checkout theme -> patch fields -> checkin theme -> checkout site -> dry_run -> apply -> checkin site. The lock is yours to take and release; site_apply_theme never auto-checks-out.",
      kind: "constraint",
      provenance: { source: "human" }
    }
  ]
};

// fit_adjudicator: judges substitutions (section types, fonts, recipes, page types) when originals do not fit the target.
// Extracted from: cloneConductorNodes.ts fit_adjudicator prompt, fidelity cost honesty.
export const fitAdjudicatorSeed: PlaybookDelta = {
  add: [
    {
      text: "CHOOSE ONLY FROM candidates. The list is LIVE-registry-derived and refusal-safe. A name you invent cannot be resolved and silently drops the work. Empty candidates array always means decline.",
      kind: "constraint",
      provenance: { source: "human" }
    },
    {
      text: "FONTS are the pattern: a theme token cannot load a webfont, so a named display face becomes what the browser has. Choosing a web-safe stack that PRESERVES THE FEEL (serif for serif, geometric sans for geometric sans) is a real fix; leaving the name in place is not.",
      kind: "strategy",
      provenance: { source: "human" }
    },
    {
      text: "fidelityCost: be HONEST rather than generous. 'none' (equivalent for readers), 'minor' (not identical but reader won't notice), 'material' (visible loss or absence). An over-optimistic cost can mislead a human into shipping something they would have rejected.",
      kind: "pitfall",
      provenance: { source: "human" }
    },
    {
      text: "DECLINING is a real answer. Set chosen to null when no candidate preserves what the source was doing. An empty ledger (everything fit) is a valid, good run — say so and return empty arrays.",
      kind: "strategy",
      provenance: { source: "human" }
    },
    {
      text: "Restamp quarantine patterns (T15.4 and prior): when a substitution's reason is 'font_not_loadable' or similar restamp-sourced refusal, document the fidelityCost honestly — theme tokens cannot load webfonts, so webs-safe fallback is real but not perfect.",
      kind: "strategy",
      provenance: { source: "human" }
    }
  ]
};

// Export all seeds as a map for initialization.
export const playbookSeeds = new Map<string, PlaybookDelta>([
  ["block_classifier", blockClassifierSeed],
  ["gap_adjudicator", gapAdjudicatorSeed],
  ["layout_analyst", layoutAnalystSeed],
  ["recipe_designer", recipeDesignerSeed],
  ["theme_reconciler", themeReconcilerSeed],
  ["fit_adjudicator", fitAdjudicatorSeed]
]);
