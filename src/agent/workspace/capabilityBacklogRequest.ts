// T15.33 (#209; ADR-2026-08-25-structure-studio §6.3) — the capability-backlog loop's STRUCTURED
// REQUEST, built from clone_report's own `capabilityBacklog` (a map keyed by missing section TYPE,
// each value the array of raw unmetNeeds entries recipe_designer reported for it — the SAME map
// engine/clone.mjs's vendored `groupUnmetNeedsBySectionType` already produces and clone_report
// already carries; this module never touches, re-implements, or duplicates that vendored grouping,
// per capture/provenance.ts's byte-fidelity discipline for vendored engine files).
//
// ADR §6.3 names a four-step loop:
//   1. the studio records the unmet need with evidence — which structures wanted it, from which sources;
//   2. it emits a structured capability request naming the proposed section type, its fields, and the evidence;
//   3. a human initiates the platform section-type release;
//   4. the new type appears in REGISTERED_SECTION_TYPES, and the studio's next run can express it.
// This module is steps 1 and 2 — a pure transform from "what recipe_designer already said was
// missing" into a request precise enough for a human to act on. Steps 3 and 4 are explicitly NOT
// here, and never will be from this module: ADR §6.4 is unambiguous that the studio does not open a
// platform PR, autonomously or behind a review gate. What this returns is a REQUEST for a human, not
// an action — see cloneConductorNodes.ts's clone_report schema comment for where this is consumed.
//
// PURE AND DETERMINISTIC (#200). No clock, no I/O, no randomness, no re-judgment of recipe_designer's
// claims: the exact same `capabilityBacklog` input, under the exact same context, always produces the
// exact same CapabilityRequest[] — section types sorted, proposed fields deduplicated and sorted,
// evidence rows in stable input order. Two runs against the same URL (or the same design output
// replayed through this function twice) produce byte-identical requests.

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter(nonEmptyString).map((entry) => entry.trim()) : []);

/** One occurrence's evidence: which structure wanted the missing type (`pageRef`), why (`why`), and
 *  from which source (`sourceUrl`/`runId`, stated once for the whole request via `context` — every
 *  unmet need in one clone_report comes from the same run against the same source). A field the
 *  underlying data never stated is `null`, never fabricated or silently omitted — a human reading
 *  this request can tell "we don't know" from "we know and it's this". */
export type CapabilityRequestEvidence = {
  pageRef: string | null;
  why: string | null;
  sourceUrl: string | null;
  runId: string | null;
};

export type CapabilityRequest = {
  /** The proposed section type's name, exactly as recipe_designer stated it — never normalized,
   *  translated, or otherwise altered, so the request a human reads matches what actually blocked
   *  every occurrence grouped under it. */
  sectionType: string;
  /** How many unmet-need occurrences this run recorded for this type — the same count
   *  learningRecord.ts's `cloneFacts.capabilityBacklog` already reports, computed independently here
   *  (never imported from there) because that module's job is "what the run did", not "what to ask
   *  the platform for". */
  occurrences: number;
  /** The union of every occurrence's own `proposedFields`, deduplicated and alphabetized. Empty when
   *  no occurrence proposed any — an honestly incomplete request, never padded to look more complete
   *  than the evidence supports. */
  proposedFields: string[];
  evidence: CapabilityRequestEvidence[];
};

export type CapabilityRequestContext = {
  /** The source this run's evidence came from — clone_intake's own sourceUrl on a clone-driven run,
   *  or the structureBrief's stated sourceUrl on a demand-driven one (ADR §6.3 point 1: "from which
   *  sources"). `null`, never a fabricated URL, when the run genuinely has none to state. */
  sourceUrl: string | null;
  /** The run these requests were built from, when the caller has one to state. Optional (and
   *  defaulted to `null`) so this function stays callable in isolation — from a unit test, or from a
   *  future aggregator folding several runs' `capabilityBacklog` maps together — without inventing a
   *  run identity that does not apply. */
  runId?: string | null;
};

/**
 * Turns clone_report's `capabilityBacklog` map into one CapabilityRequest per missing section type.
 *
 * `capabilityBacklog` is read exactly as clone_report already carries it — a map whose keys are
 * section-type names and whose values are the raw unmetNeeds entries recipe_designer reported
 * (cloneConductorNodes.ts's recipe_designer output schema: `{sectionType, pageRef?, why?,
 * proposedFields?}`, `additionalProperties: true` so an older or thinner entry is never a schema
 * failure — this function reads defensively for exactly that reason, never assuming a field is
 * present). A malformed or non-object entry in the array is skipped, never thrown on: one bad entry
 * must not drop every other occurrence's evidence, the same "one bad item doesn't abort the batch"
 * discipline recipe_mint and the template-deposit loop already hold.
 */
export function buildCapabilityRequests(
  capabilityBacklog: Record<string, unknown[]>,
  context: CapabilityRequestContext = { sourceUrl: null }
): CapabilityRequest[] {
  const sourceUrl = nonEmptyString(context.sourceUrl) ? context.sourceUrl : null;
  const runId = nonEmptyString(context.runId ?? undefined) ? (context.runId as string) : null;

  return Object.keys(capabilityBacklog)
    .sort((left, right) => left.localeCompare(right))
    .map((sectionType) => {
      const needs = Array.isArray(capabilityBacklog[sectionType]) ? capabilityBacklog[sectionType] : [];
      const fieldSet = new Set<string>();
      const evidence: CapabilityRequestEvidence[] = [];
      for (const raw of needs) {
        if (!isRecord(raw)) continue;
        for (const field of stringArray(raw.proposedFields)) fieldSet.add(field);
        const why = nonEmptyString(raw.why) ? raw.why : nonEmptyString(raw.rationale) ? raw.rationale : undefined;
        evidence.push({
          pageRef: nonEmptyString(raw.pageRef) ? raw.pageRef : null,
          why: why ?? null,
          sourceUrl,
          runId
        });
      }
      return {
        sectionType,
        occurrences: evidence.length,
        proposedFields: [...fieldSet].sort((left, right) => left.localeCompare(right)),
        evidence
      };
    });
}
