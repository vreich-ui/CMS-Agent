// T15.33 (#209; ADR-2026-08-25-structure-studio §6.2) — the structure studio's STANDARDS PACK: a
// versioned skill of TS/component/a11y conventions plus a snapshot of the platform's section-type
// registry, delivered to the studio's authoring nodes through the EXISTING skills machinery
// (skillRegistry.ts / skillResolver.ts / seededSkills.ts) — the same mechanism every other skill
// (editorial_craft, contract_intelligence, ...) reaches a node through.
//
// THE PIN (§6.2: "version-pinned onto every run and recorded in the template's provenance... a
// standards bump does not retroactively change what an existing template claims"). This module is
// where the pin lives.
//
// STANDARDS_PACK_VERSION below is a CODE CONSTANT, deliberately NOT a live read of the skill store —
// the same choice publishableTypeCharter.ts made for publishableTypes and executor.ts's
// capturePublishingPolicySnapshot made for autonomyMode ("captured onto the snapshot in the exact
// same 'once, at creation, never re-read live' shape... this must never become a live read"). A
// value that TemplateLibraryStore.publish() stamps onto every deposit has to be identical no matter
// how many times, or in what order, it is read within one process — a live skill_update() bump
// mid-run must never retroactively change what a template published five minutes earlier claims to
// have been built against, and a compile-time-pinned constant makes that true by construction rather
// than by a snapshot-and-hope discipline. templateLibraryStore.ts already refuses to accept a
// caller-supplied standardsPack for the identical reason ("so every deposit carries the SAME pinned
// values a caller could otherwise omit, stale, or fabricate") — this constant is what it reads.
//
// THE REFRESH FLOW ("kept current with TypeScript and platform standards" — T15.33's issue, point 2).
// A deliberate, auditable version bump, never prompt drift:
//   1. Update STANDARDS_PACK_VERSION below and STANDARDS_PACK_INSTRUCTIONS with the new conventions.
//   2. Update standardsPackSkillDefinition's `version`/`updatedAt` to match (a test in
//      tests/agent/skills/standardsPack.test.ts asserts the two can never drift apart).
//   3. Once a live workspace exists, `skill_update` (or the standard seededSkills.ts /
//      `npm run nodes:update` re-seed path every other skill in this file follows) carries the new
//      instructions text to the live store so resolveSkillsForNode's prompt assembly picks it up.
// The pinned VERSION change (step 1) and the redeploy that ships it are one unit: exactly like
// publishableTypeCharter.ts, a version this constant states is a version that shipped in code, never
// one an operator merely typed into a form.
//
// A standards-pack bump never touches an already-published template: TemplateLibraryRecord versions
// are write-once (templateLibraryStore.ts, ADR §4.1), so a template minted under pack "2026.08.25-1"
// keeps stating exactly that forever, even after this constant moves to "2026.09.01-1" and a NEW
// template version is minted under the new pack.
import { SUPPORTED_SECTION_TYPES } from "../capture/engine/map.mjs";
import type { SkillDefinition } from "./skillTypes.js";

export const STANDARDS_PACK_SKILL_ID = "structure_studio_standards_pack";

// Calendar-versioned like this codebase's other pinned constants (provenance.ts's vendored-file
// table, publishableTypeCharter.ts). Bump this string — and standardsPackSkillDefinition.version to
// match — to record a deliberate refresh; see the refresh flow above.
export const STANDARDS_PACK_VERSION = "2026.08.25-1" as const;

/** A pure, alphabetized snapshot of the section-type vocabulary the studio may compose recipes from
 *  right now — the "snapshot of the platform's section-type registry" the T15.33 issue names.
 *  SUPPORTED_SECTION_TYPES is the SAME vendored registry recipe_designer's own RECIPE_VOCABULARY
 *  (cloneConductorNodes.ts) is built from and recipe_mint re-validates against — this is not a
 *  second, drift-prone copy of the vocabulary, it is the one registry read a second way. */
export function standardsPackSectionTypeSnapshot(): readonly string[] {
  return [...SUPPORTED_SECTION_TYPES].sort();
}

export const STANDARDS_PACK_INSTRUCTIONS = [
  "Standards pack " + STANDARDS_PACK_VERSION + " — the studio's current TypeScript, component and accessibility conventions. This is CONVENTION, not the registry: it tells you HOW to design within the section-type vocabulary clone_intake's briefing already states, never what that vocabulary is.",
  "TypeScript: strict mode, no `any` in a designed blueprint's own field values, no implicit narrowing of a registered section type's enum fields — state the value exactly as the registry declares it rather than a close guess recipe_mint would have to reject.",
  "Components: compose only registered section types (recipe_mint re-validates every design against the live registry and rejects, never coerces, anything else) — reuse an existing evergreen recipe over minting a near-duplicate; name a genuinely new recipe for what it is, not for the page it first appeared on.",
  "Accessibility (WCAG 2.1 AA): every blueprint needs a real accessible name for its interactive elements, heading levels that nest without skipping a level, alt text on every image field, and body-to-background contrast — a section_template that cannot satisfy these for at least one plausible content fill is not evergreen, only a one_off.",
  "Section-type registry snapshot pinned to this pack version: " + standardsPackSectionTypeSnapshot().join(", ") + ". A shape needing a type outside this list is never approximated — record it in unmetNeeds (ADR §6.3's capability-backlog loop) and move on; an honest gap is a platform backlog item, a bad approximation is a page nobody wants."
].join("\n\n");

const now = "2026-08-25T00:00:00.000Z";

export const standardsPackSkillDefinition: SkillDefinition = {
  skillId: STANDARDS_PACK_SKILL_ID,
  name: "Structure studio standards pack",
  description: "Versioned TS/component/a11y conventions and a section-type registry snapshot for the structure studio's authoring nodes (ADR-2026-08-25-structure-studio §6.2).",
  version: STANDARDS_PACK_VERSION,
  status: "active",
  instructions: STANDARDS_PACK_INSTRUCTIONS,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  allowedTools: [],
  requiredArtifacts: [],
  producedArtifacts: [],
  examples: [
    {
      name: "basic",
      input: { brief: "Design a section_template for a testimonial block." },
      output: { result: "Composed from registered section types, WCAG 2.1 AA-aware, cited against the pinned pack version.", artifacts: [] }
    }
  ],
  preconditions: ["A studio judgment node (layout_analyst, recipe_designer, theme_reconciler, fit_adjudicator) is composing or reconciling a design against the live registry."],
  completionCriteria: ["The design cites only section types in the pinned registry snapshot (or the live registry, when it has grown since this pin) and follows the stated TS/component/a11y conventions."],
  blockerCriteria: ["A needed shape has no section type in the live registry — that is an unmet need for the capability-backlog loop, not something this pack can resolve."],
  memoryPolicy: { namespaces: [STANDARDS_PACK_SKILL_ID], read: true, write: false },
  toolPolicy: { requestedTools: [], mutatingToolsRequireApproval: true },
  riskLevel: "read",
  // The registry snapshot restated in metadata (structured, not just prose in `instructions`) so a
  // caller resolving a run's standards-pack snapshot (resolveStandardsPackSnapshot, below) can read
  // it back as data rather than re-parsing the instructions string.
  metadata: { sectionTypeRegistrySnapshot: standardsPackSectionTypeSnapshot() },
  createdAt: now,
  updatedAt: now
};

export type StandardsPackSnapshot = {
  skillId: string;
  version: string;
  sectionTypeRegistry: string[];
};

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Pure, deterministic — no clock, no I/O. Resolves the pinned snapshot from a given skill
 *  definition (typically the studio's own `structure_studio_standards_pack`, read once). Absent
 *  skill (a fresh or misconfigured workspace whose skill store was never seeded with it) falls back
 *  to the code-pinned default rather than blocking a studio run or fabricating a version that was
 *  never actually assigned — the same "absent still resolves to a stated, honest default" posture
 *  capturePublishingPolicySnapshot takes for autonomyMode. */
export function resolveStandardsPackSnapshot(skill: SkillDefinition | undefined): StandardsPackSnapshot {
  if (!skill) {
    return { skillId: STANDARDS_PACK_SKILL_ID, version: STANDARDS_PACK_VERSION, sectionTypeRegistry: [...standardsPackSectionTypeSnapshot()] };
  }
  const registry = isStringArray(skill.metadata?.sectionTypeRegistrySnapshot) ? skill.metadata.sectionTypeRegistrySnapshot : [...standardsPackSectionTypeSnapshot()];
  return { skillId: skill.skillId, version: skill.version, sectionTypeRegistry: registry };
}

/** Convenience wrapper over resolveStandardsPackSnapshot for a caller holding a repository rather
 *  than an already-fetched skill (e.g. a future node dispatch wanting to log which pack a run
 *  actually saw). ONE repository read, never re-read mid-caller — the caller is responsible for not
 *  calling this more than once per run and threading the result, exactly as
 *  capturePublishingPolicySnapshot's single read at run creation is threaded via
 *  run.publishingPolicySnapshot rather than re-read at every gate evaluation. */
export async function loadStandardsPackSnapshot(repository: { get(skillId: string): Promise<SkillDefinition | undefined> }): Promise<StandardsPackSnapshot> {
  const skill = await repository.get(STANDARDS_PACK_SKILL_ID);
  return resolveStandardsPackSnapshot(skill);
}
