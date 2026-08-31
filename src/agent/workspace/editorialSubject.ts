// W10 (2026-08-31, run_1788207377621_behzkh) — THE SUBJECT GATE: a live editorial run must name what
// it is about before anything is dispatched.
//
// WHAT THIS COST. The admin chat asked the operator for a topic, the operator said "done for now",
// and the agent started a production run anyway with TAXONOMY ONLY — a category and three tags, no
// topic, no title, no angle, no body. `input_triage` said so in its own output at the FIRST node:
//
//   "Blocker: missing critical publishing inputs including requested content format, draft/source
//    body, title or topic, target audience, destination/channel, factual support, CTA, and
//    publication intent."
//
// Sixteen more paid nodes then ran on that nothing. `draft_writer` refused in 7.6s ("the brief is a
// clarification brief, not a writing brief"), `review_aggregator` said return to the requester,
// `article_body` emitted `nodes: []`, and the publish gate correctly refused an empty article. Every
// gate did its job. The run still cost real money to discover, at the end, what node one already knew.
//
// The operator's read of this was "the approve button is broken" — because approval WAS recorded
// (operatorPublishDecision "approved", source "explicit") and nothing moved. Approval was never the
// problem; there was simply nothing publishable. A run that cannot succeed should say so before it
// spends, not after.
//
// WHY THIS IS A STRUCTURAL CHECK AND NOT A READ OF input_triage's BLOCKERS. Node one DID diagnose it,
// in prose, in a model-authored `notes[]`. Gating a run on that prose would put a model's phrasing in
// the control path — precisely what skipPredicates.ts's rule 1 forbids ("predicates are data, not
// code"; no predicate reads model output as prose). The run's OWN initialInput is a structural fact
// that costs nothing to inspect and cannot be re-worded, so the gate reads that instead — and it can
// therefore run BEFORE node one rather than after it, which is where the saving is.
//
// THE TIE GOES TO REFUSING, and this is the one place in the conductor where it does. Everywhere else
// (skipPredicates.ts rule 3) an undecidable predicate resolves toward RUNNING, because the cost of a
// wrong skip is a thinner article and the cost of a wrong run is a few cents. Here the asymmetry is
// reversed: a wrong refusal costs one clarifying question, and a wrong run costs a full pipeline and
// ends in an empty article nobody can publish. But the check is deliberately NARROW — it fires only
// when the input names no subject in ANY recognised form, which is unambiguous, never on a subject it
// merely judges thin. A run that says what it is about always proceeds.
// Structurally the slice of StartDryRunInput this gate reads. Declared locally rather than imported
// from executor.ts: that module imports this one, and a type-only edge back would be a cycle the
// bundler tolerates but the reader should not have to.
export type SubjectGateInput = { input?: unknown; executionMode?: string; entrypoint?: unknown };

/** Every field a caller may legitimately use to say what the piece is about. Order is not
 *  significant — the first non-empty one wins only for the human-readable echo in the refusal. */
export const EDITORIAL_SUBJECT_KEYS = [
  "topic",
  "title",
  "subject",
  "headline",
  "articleTitle",
  "slug",
  "brief",
  "angle",
  "question",
  "readerQuestion",
  "prompt",
  "input"
] as const;

/** Fields that carry the CONTENT itself rather than a description of it. A run handed a draft, a body
 *  or a source URL to work from has named its subject as surely as one handed a title. */
export const EDITORIAL_CONTENT_KEYS = ["body", "draft", "articleBody", "content", "sourceUrl", "contentSource"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Non-empty in the sense that matters: a string with characters, an array with entries, an object
 *  with keys. `{}`, `[]`, `""` and null all say nothing. */
const carriesSomething = (value: unknown): boolean => {
  if (nonEmptyString(value)) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
};

/**
 * The subject this run declares, or undefined when it declares none.
 *
 * A bare non-empty string input IS the subject — that is the oldest calling convention in this
 * codebase (`input: "CA3 regression"`) and it must keep working.
 */
export const readEditorialSubject = (initialInput: unknown): string | undefined => {
  if (nonEmptyString(initialInput)) return initialInput.trim();
  if (!isRecord(initialInput)) return undefined;
  // A TYPED ARTIFACT ENVELOPE is a declaration in its own right, and a richer one than a topic line:
  // a caller handing the conductor a `content_source.v1` has already said what the piece is, in the
  // system's own vocabulary. Recognising it structurally (a non-empty `artifact` discriminator) rather
  // than by enumerating envelope-specific fields keeps this gate from having to know every artifact
  // shape, now or later.
  if (nonEmptyString(initialInput.artifact)) return `<${initialInput.artifact.trim()}>`;
  for (const key of EDITORIAL_SUBJECT_KEYS) {
    const value = initialInput[key];
    if (nonEmptyString(value)) return value.trim();
    // `input` and `brief` are commonly nested objects rather than strings; a populated one is a
    // declaration even when this reader cannot render it as a line of text.
    if ((key === "input" || key === "brief") && carriesSomething(value)) return `<${key}>`;
  }
  for (const key of EDITORIAL_CONTENT_KEYS) {
    if (carriesSomething(initialInput[key])) return `<${key}>`;
  }
  return undefined;
};

export const declaresEditorialSubject = (initialInput: unknown): boolean => readEditorialSubject(initialInput) !== undefined;

export type SubjectGateVerdict = { ok: true } | { ok: false; code: string; message: string; details: Record<string, unknown> };

export const EDITORIAL_SUBJECT_MISSING = "editorial_subject_missing";

/**
 * The gate itself. Applies to a LIVE run that will actually dispatch the ideation segment.
 *
 * Exempt, deliberately:
 *   - mock runs — they produce schema-shaped placeholders for CI traversal and cost nothing;
 *   - late-stage entrypoint runs — they seed article_body with the finished object and legitimately
 *     carry no topic, because the ideation nodes they would name a topic for are seeded as skipped.
 */
export function checkEditorialSubject(data: SubjectGateInput): SubjectGateVerdict {
  if (data.executionMode === "mock") return { ok: true };
  if (data.entrypoint) return { ok: true };
  if (declaresEditorialSubject(data.input)) return { ok: true };
  const supplied = isRecord(data.input) ? Object.keys(data.input).sort() : typeof data.input;
  return {
    ok: false,
    code: EDITORIAL_SUBJECT_MISSING,
    message:
      "This run does not say what the piece is about, so it was not started and nothing was spent. Supply a subject in the run input — any of " +
      `${EDITORIAL_SUBJECT_KEYS.slice(0, 6).join(", ")} — or the content itself (${EDITORIAL_CONTENT_KEYS.slice(0, 3).join(", ")}). ` +
      "Taxonomy alone (a category and tags) is not a subject: it says where a piece would file, not what it would say. " +
      "If you are an agent holding a conversation with the requester, ask for the topic and angle and start the run once you have them.",
    details: { suppliedKeys: supplied, accepted: { subject: [...EDITORIAL_SUBJECT_KEYS], content: [...EDITORIAL_CONTENT_KEYS] } }
  };
}
