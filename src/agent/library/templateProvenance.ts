// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — "a template whose provenance cannot be
// stated is not publishable." This module is that check, enforced (not merely documented): every
// deposit into the library goes through validateTemplateProvenance before templateLibraryStore.ts
// writes anything, and a failure refuses with a NAMED reason rather than minting a partial record.
//
// PURE. No I/O, no clock, no network — the engine hashes below are read from provenance.ts's own
// pinned constants (never recomputed from disk), so this module is a pure function of its inputs,
// exactly like every other deterministic surface this run's output depends on (#200).
import { CAPTURE_ENGINE_FILES } from "../capture/provenance.js";
import { STANDARDS_PACK_VERSION } from "../skills/standardsPack.js";
import type { TemplateProvenance } from "./templateLibraryTypes.js";

// T15.33 (#209; ADR-2026-08-25-structure-studio §6.2) — the placeholder this constant used to be
// ("unpinned-pending-T15.33") is gone. STANDARDS_PACK_VERSION is now re-exported straight from
// skills/standardsPack.ts, the ONE place the pinned pack version is declared — the skill definition
// assigned to the studio's authoring nodes (layout_analyst, recipe_designer, theme_reconciler,
// fit_adjudicator) via assignedSkills, and this constant, are the SAME literal by construction (see
// that module's own header for why it is a code constant and not a live skill-store read: a pin that
// could drift mid-run would defeat "a standards bump does not retroactively change what an existing
// template claims"). Re-exported (not merely imported and used locally) so templateLibraryStore.ts's
// existing `import { STANDARDS_PACK_VERSION } from "./templateProvenance.js"` needs no change.
export { STANDARDS_PACK_VERSION };

/** The vendored capture-engine hashes, read once from CAPTURE_ENGINE_FILES's own pinned
 *  `vendoredSha256` values (not `hashVendoredEngineFile`, which does disk I/O to VERIFY the pin —
 *  provenance here only needs to STATE it). Pure and synchronous. */
export function buildCaptureEngineHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of CAPTURE_ENGINE_FILES) hashes[entry.file] = entry.vendoredSha256;
  return hashes;
}

export type TemplateProvenanceInput = {
  sourceUrl?: string | null;
  captureRunId?: string | null;
  /** "clone" when this deposit originates from a clone run (today, always) — captureRunId is then
   *  REQUIRED, not merely recorded when present. #206's demand-driven entry may one day supply
   *  "demand" here, at which point captureRunId is legitimately absent. */
  driven: "clone" | "demand";
  engineHashes?: Record<string, string> | null;
  standardsPack?: string | null;
};

export type TemplateProvenanceResult =
  | { ok: true; provenance: TemplateProvenance }
  | { ok: false; code: string; reason: string };

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Total, deterministic validation of one template's stated provenance. Never coerces a missing or
 *  malformed field into a placeholder that would make an unstateable provenance LOOK stated — every
 *  refusal names exactly which requirement failed, so a caller (and a test) can assert the reason
 *  rather than merely "it failed". */
export function validateTemplateProvenance(input: TemplateProvenanceInput): TemplateProvenanceResult {
  if (!nonEmptyString(input.sourceUrl)) {
    return { ok: false, code: "template_provenance_unstateable", reason: "provenance.sourceUrl is missing or empty; a template's source cannot be stated without the URL it was captured from." };
  }
  if (!isHttpsUrl(input.sourceUrl)) {
    return { ok: false, code: "template_provenance_unstateable", reason: `provenance.sourceUrl ("${input.sourceUrl}") is not a valid HTTPS URL; an unparseable or non-HTTPS source cannot be stated as this template's provenance.` };
  }
  if (input.driven === "clone" && !nonEmptyString(input.captureRunId)) {
    return { ok: false, code: "template_provenance_unstateable", reason: "provenance.captureRunId is required for a clone-driven template (ADR-2026-08-25-structure-studio §4.1) and is missing or empty; a clone-minted template cannot state provenance without the run it was minted from." };
  }
  const engineHashes = input.engineHashes && Object.keys(input.engineHashes).length > 0 ? input.engineHashes : undefined;
  if (!engineHashes) {
    return { ok: false, code: "template_provenance_unstateable", reason: "provenance.engineHashes is missing or empty; the vendored capture-engine hashes (src/agent/capture/provenance.ts) must be stated for every template." };
  }
  if (!nonEmptyString(input.standardsPack)) {
    return { ok: false, code: "template_provenance_unstateable", reason: "provenance.standardsPack is missing or empty; every template must state which standards-pack version it was built against (ADR-2026-08-25-structure-studio §6.2)." };
  }
  return {
    ok: true,
    provenance: {
      sourceUrl: input.sourceUrl,
      ...(input.driven === "clone" ? { captureRunId: input.captureRunId as string } : {}),
      engineHashes,
      standardsPack: input.standardsPack
    }
  };
}
