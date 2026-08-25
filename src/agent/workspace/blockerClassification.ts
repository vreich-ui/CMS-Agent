// W7 (2026-08-25, run_1787655709652_4k1z56) — which upstream blockers are allowed to stop a publish.
//
// WHY THIS EXISTS. publication_controller collects every upstream stage output's `blockers[]` and
// treats all of them as hard blocks. Its own decision record said so out loud:
//
//     "Content class: client_property (no blocker class is exempt; every upstream blocker hard-blocks)"
//
// On run_1787655709652_4k1z56 (project dr-lurie) that rule put four blockers on the same footing:
//
//     topic_opportunity: No viable public reader value for a real article.                  <- taste
//     brief_architect:   ...should be reframed as a real dermatology topic with evidence.   <- taste
//     publish_readiness: article_has_content (body.nodes is empty — nothing would render)   <- integrity
//     article_body:      article_body_validation_unavailable:MCP request failed with HTTP 401. <- integrity
//
// The first two are a model's opinion about whether the piece is GOOD. The last two are facts about
// whether the artifact is real, valid, and renderable. Only the second kind is a reason to stop a
// machine from publishing. Under the owner's standing directive (2026-08-25) agents publish freely by
// default and a human intervenes only when an authorized admin/owner explicitly says so, so a review
// node's taste verdict must be RECORDED, not GATING. Left as-is, a fixture or test article could never
// publish no matter how many approvals were given, because the review nodes will always (correctly)
// object to placeholder content.
//
// THE SHAPE OF THE FIX. Two classes, keyed on the node that RAISED the blocker — not on a regex over
// its wording, because a node's blocker vocabulary is its own and changes without notice, while the
// question "is this node judging the artifact or judging the writing?" is a stable property of the
// node's job. The table below is the whole policy, one line of rationale per entry, so a reader can
// see at a glance which node is which class and why.
//
//   INTEGRITY — hard block. Is the artifact real, valid, safe, and actually renderable?
//   EDITORIAL — advisory.   Is the piece any good?
//
// THREE RULES THIS TABLE OBEYS.
//
//   1. FAIL CLOSED. Anything not named here is INTEGRITY (DEFAULT_BLOCKER_CLASS). A node added
//      tomorrow that nobody classified hard-blocks until someone classifies it — the opposite default
//      would let a new gate silently become advisory, which is the failure mode this file exists to
//      make impossible.
//   2. trust_factual IS INTEGRITY, deliberately. It is the fact-check / reader-safety review, and its
//      biggest tenant (dr-lurie) is a live consumer-health site. A wrong medical claim is a fact about
//      the artifact's safety, not an opinion about its quality. It sits on the editorial side of the
//      pipeline and on the integrity side of this table, and that is not an oversight — see its entry.
//   3. PROMOTION ONLY. A project may promote an EDITORIAL source back to hard
//      (publishingPolicy.hardBlockerSources); nothing anywhere can demote an INTEGRITY source to
//      advisory. A tenant can only ever make its own gate stricter than the engine's default.
//
// Advisory blockers are never dropped: publicationController records each one in the decision's
// `advisories[]` with its source node and the rationale that classified it, and the summary counts
// hard blockers and advisories separately.

export type BlockerClass = "integrity" | "editorial";

// Fail-closed default for any source not named in the table below. See rule 1 above.
export const DEFAULT_BLOCKER_CLASS: BlockerClass = "integrity";

export type BlockerSourceClass = { class: BlockerClass; why: string };

// The classification table. Keys are node ids exactly as the conductor knows them, plus the one
// pseudo-source "publish_readiness" — the prefix publicationController puts on the project's own
// readiness-checklist failures, listed here so the table accounts for every blocker that can appear in
// a decision record rather than only the ones routed through the upstream partition.
export const BLOCKER_SOURCE_CLASSES: Readonly<Record<string, BlockerSourceClass>> = {
  // ---- INTEGRITY: is the artifact real, valid, safe, and actually renderable? -------------------
  publish_readiness: { class: "integrity", why: "The project's own readiness checklist (article_has_content, article_body_blockers, media/artifact verification, taxonomy, the hard_* contract constraints) — every item asks whether the thing would render and validate, none asks whether it is good." },
  contract_intelligence: { class: "integrity", why: "The client's contract: unavailable, unestablished, or a prefetch error means we do not know what a valid object even IS for this tenant, so nothing downstream can be verified." },
  article_body: { class: "integrity", why: "The artifact itself — client validation unavailable, body schema unknown, object type unestablished. run_1787655709652_4k1z56's `article_body_validation_unavailable:MCP request failed with HTTP 401` is exactly this: nothing checked the object." },
  publish_payload: { class: "integrity", why: "The payload a publish would actually send; client validation unavailable means nothing verified the bytes about to be written to a live site." },
  trust_factual: { class: "integrity", why: "The fact-check and reader-safety review. Deliberately NOT demoted with the other review nodes: dr-lurie is a live consumer-health site, so an unsupported claim is a safety fact about the artifact, not a matter of taste." },
  input_triage: { class: "integrity", why: "Resolves the target client and the request envelope; an unresolvable client identity means the run does not know whose site it would be writing to." },
  placement_resolver: { class: "integrity", why: "Computes the aggression vector. `aggression_ceiling_missing` is a standing operator rule (an absent ceiling is a blocker, never a default) and readinessContentChecks already names it unwaivable." },
  artifact_plan: { class: "integrity", why: "Media artifacts. An artifact that was never materialized for THIS request is a broken render, not an editorial preference." },
  publication_controller: { class: "integrity", why: "This node's own record. It never classifies its own blockers away — a gate that can demote itself is not a gate." },
  publish_executor: { class: "integrity", why: "The publish gate's own refusals (go-live evidence, approvalMatched, the operator veto). These ARE the gate." },
  learning_recorder: { class: "integrity", why: "The audit trail. It is a successor, never inside publication_controller's upstream closure, so it is never collected here — classified anyway so no future wiring change can quietly make audit blockers advisory." },

  // ---- EDITORIAL: is the piece any good? Advisory — recorded, never gating. ---------------------
  topic_opportunity: { class: "editorial", why: "Decides whether a request is worth writing at all. run_1787655709652_4k1z56's `No viable public reader value for a real article.` is a judgement about the idea, not a fact about the artifact." },
  reader_insight: { class: "editorial", why: "Models the reader's needs and sophistication — an assumption about audience, unfalsifiable from inside the run." },
  research: { class: "editorial", why: "Depth and sufficiency of evidence gathering. Whether a CLAIM is safe is trust_factual's question and stays hard; whether enough was read is taste." },
  objection_mapping: { class: "editorial", why: "Which reader objections the piece should answer — an argument about completeness of the argument." },
  narrative_movement: { class: "editorial", why: "Whether the piece moves. Pure craft." },
  angle_strategy: { class: "editorial", why: "Which angle to take on a topic — by construction one opinion among several defensible ones." },
  monetization_strategy: { class: "editorial", why: "Offer selection and EV posture: a commercial preference about what the piece should sell, not a statement that the artifact is broken. (The own-property EV-floor waiver still applies first and is still audited separately.)" },
  brief_architect: { class: "editorial", why: "Turns strategy into a brief. run_1787655709652_4k1z56's `should be reframed as a real dermatology topic with evidence` is a rewrite request — advice about what to write, offered before anything was written." },
  draft_writer: { class: "editorial", why: "The prose. A writer's own reservations about a draft are the definition of an editorial note." },
  human_texture: { class: "editorial", why: "Specificity, rhythm, voice, lived-in detail — explicitly forbidden from changing factual meaning, so it can only ever be judging quality." },
  emotional_resonance: { class: "editorial", why: "Whether the piece lands emotionally. No integrity content whatsoever." },
  reader_simulation: { class: "editorial", why: "A simulated reader's reaction — a model's opinion about a model's opinion." },
  review_aggregator: { class: "editorial", why: "Aggregates the review nodes above; it can only ever be as hard as its inputs, and its inputs are taste. Any integrity blocker it echoes is already carried by the integrity node that raised it." }
};

// Normalized identity for a source: node ids are lowercase snake_case by convention, but a policy list
// written by a human should not fail on stray whitespace or capitals.
const sourceKey = (nodeId: string): string => nodeId.trim().toLowerCase();

export type BlockerClassification = {
  class: BlockerClass;
  why: string;
  // Which rule answered — so an audit can tell an engine default from a tenant's deliberate promotion,
  // and an unclassified (fail-closed) source from a classified one.
  basis: "table" | "project_override" | "unclassified_default";
};

const UNCLASSIFIED_WHY =
  "Not named in BLOCKER_SOURCE_CLASSES. Unrecognised sources are INTEGRITY by default (fail-closed): a node nobody has classified hard-blocks until someone does, rather than silently becoming advisory.";

/**
 * The one classifier. `hardBlockerSources` is the project-level override (see
 * ProjectPublishingPolicy.hardBlockerSources) and is PROMOTION ONLY — it can turn an editorial source
 * hard, and can never turn an integrity source advisory. Listing an already-integrity source is a
 * harmless no-op that still reports basis "table", because the engine, not the tenant, is what made it
 * hard.
 */
export function classifyBlockerSource(nodeId: string, hardBlockerSources: readonly string[] = []): BlockerClassification {
  const key = sourceKey(nodeId);
  const entry = BLOCKER_SOURCE_CLASSES[key];
  const base: BlockerClassification = entry
    ? { class: entry.class, why: entry.why, basis: "table" }
    : { class: DEFAULT_BLOCKER_CLASS, why: UNCLASSIFIED_WHY, basis: "unclassified_default" };
  if (base.class === "integrity") return base;
  if (!hardBlockerSources.some((source) => sourceKey(String(source)) === key)) return base;
  return {
    class: "integrity",
    why: `Promoted to a hard blocker by this project's publishingPolicy.hardBlockerSources. Engine default was editorial: ${base.why}`,
    basis: "project_override"
  };
}

// Convenience readers for docs, tests and operator surfaces — the table is the policy, so let callers
// enumerate it rather than re-deriving the split from a second list that could drift.
export const editorialBlockerSources = (): string[] => Object.entries(BLOCKER_SOURCE_CLASSES).filter(([, entry]) => entry.class === "editorial").map(([nodeId]) => nodeId).sort();
export const integrityBlockerSources = (): string[] => Object.entries(BLOCKER_SOURCE_CLASSES).filter(([, entry]) => entry.class === "integrity").map(([nodeId]) => nodeId).sort();
