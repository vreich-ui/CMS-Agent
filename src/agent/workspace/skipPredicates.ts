// W4 (determinism program, 2026-08-12) — SKIP PREDICATES: deterministic, pre-dispatch node gating.
//
// WHY THIS EXISTS. The 23/23 live run (run_1786468126136_ev9goe) paid for nodes that had nothing to
// do. `research` made zero web calls and its own output said browsing was not needed — $0.06 to
// conclude there was nothing to conclude. `artifact_plan` re-derived its own zero-media rule (its
// output states it as an if-statement) at model prices. `monetization_strategy` ran for content whose
// EV floor is exempt by standing operator ruling. All four reviewers ran on docs-class content that
// needs one. Each of those is a decision a program can make BEFORE the dispatch, from facts the run
// already holds — which is the difference between not spending the money and spending it to find out
// there was nothing to buy.
//
// THE THREE RULES THIS MODULE IS BUILT ON.
//
//  1. PREDICATES ARE DATA, NOT CODE. A `skipWhen` entry in node metadata is a small declarative
//     object — {when: "no_media_slots"} — whose MEANING lives here, in engine code, under test. The
//     workspace store can carry node metadata but must never carry executable logic: a store row that
//     could say "skip when <arbitrary expression>" is a remote code path into the conductor. So the
//     store says WHICH rule, this file says WHAT THE RULE MEANS, and an unrecognized rule name is
//     inert (see 3).
//
//  2. SKIPPING IS EXPLICIT AND AUDITABLE, NEVER SILENT. The executor marks the node `skipped` — a
//     real execution status (executionTypes.ts) — and records the predicate that fired plus the facts
//     it fired on. A run that skipped four nodes reads as a run that skipped four nodes, with the
//     reason attached to each, rather than as a run that mysteriously has fewer nodes than the last
//     one. "Cheaper" is only worth having if it is also legible afterwards.
//
//  3. EVERY UNCERTAINTY RESOLVES TOWARD RUNNING. A predicate that cannot decide does not skip. An
//     unrecognized rule name does not skip. A malformed predicate does not skip. An absent or
//     unrecognized content class runs the FULL review quartet. The failure mode of a wrong skip is a
//     silently thinner article that a reviewer never saw; the failure mode of a wrong run is $0.06.
//     Those are not the same size, so the tie always goes to running.
//
// WHAT IS DELIBERATELY NOT HERE. No predicate reads model output as prose, none infers intent from
// text, and none consults a remembered convention from another client. Every signal is either an
// EXPLICIT declaration on the run (a field someone set) or a STRUCTURAL fact of an upstream artifact
// (a client object that contains no media reference at all). A run whose input declares nothing gets
// the full pipeline, exactly as it does today.
import { readDeclaredContentClass } from "./publicationController.js";
import { gatedMetadata } from "./nodeGatingSeed.js";

// ---------------------------------------------------------------------------------------------
// The predicate schema. Four rules, deliberately few: each one exists because a specific node paid
// for a specific decision on the 2026-08-12 live run.
export type SkipPredicate =
  // Skip when the run's DECLARED content class is one of `classes`. The class is read from the same
  // explicit run-level signal the standing own-property EV/aggression waiver uses
  // (publicationController.readDeclaredContentClass) — deliberately the SAME signal, so a run can
  // never be own-property enough to waive the EV floor but not own-property enough to skip the node
  // that computes it.
  | { when: "content_class_in"; classes: string[]; reason?: string }
  // Skip when the upstream body/brief declares no media slots at all — artifact_plan's own zero-media
  // shortcut, moved ahead of the dispatch that used to re-derive it.
  | { when: "no_media_slots"; reason?: string }
  // Skip unless something in the run indicates external claims that need checking — research's
  // trigger. Explicit declaration first; docs-class fallback second; run otherwise.
  | { when: "no_external_claims"; reason?: string }
  // Skip when this reviewer is not in the review tier the run's content class selects (the operator
  // policy below). `reviewer` defaults to the node's own id.
  | { when: "review_tier_excludes"; reviewer?: string; reason?: string }
  // T12.9 capture_conductor — copy_regenerator's gate. Skip when an upstream capture envelope
  // POSITIVELY declares policy.rights.content === "retain_allowed_origin_content": rights permit the
  // extracted copy, so there is nothing to regenerate. The rights fact is stamped onto every capture
  // stage envelope by captureEngine.ts from the registry policy — a run artifact, not a re-fetch —
  // and per rule 3 an absent/unreadable declaration RUNS the node (a wasted regeneration costs
  // model dollars; emitting copy the rights prohibit is what emission's own quarantine prevents).
  | { when: "capture_rights_allow_extracted_copy"; reason?: string }
  // T12.9 capture_conductor — block_classifier's gate. Skip when an upstream capture-map envelope
  // POSITIVELY declares declinedBlocks as an empty array: the heuristic mapper declined nothing, so
  // there is no block for the classifier to judge. Absent/unreadable declaration runs the node.
  | { when: "capture_no_declined_blocks"; reason?: string }
  // T13.2 clone_conductor — recipe_designer's gate. Skip when the upstream layout-analysis envelope
  // POSITIVELY declares a mismatch ledger containing ZERO mismatches a recipe could close, i.e. none
  // whose `missingRecipeKind` is "section_template" or "template". A mismatch marked "none" is an
  // honest analyst answer that NO recipe closes that divergence — it is evidence against running the
  // designer, never for it. Absent/unreadable ledger runs the node.
  | { when: "clone_no_actionable_mismatches"; reason?: string }
  // T15.30 clone_conductor — layout_analyst's gate (#206; ADR-2026-08-25-structure-studio §3). Skip
  // when the upstream clone_intake envelope POSITIVELY declares entryMode === "demand": a
  // demand-driven run carries no capture snapshot to diff a source shape against, so there is
  // nothing for the layout analyst to compare — clone_intake states the equivalent mismatch ledger
  // directly (its own `mismatches` field, read by `clone_no_actionable_mismatches` above via the
  // SAME generic "any carrier declaring a `mismatches` array" rule, no change needed there). Absent/
  // unreadable entryMode RUNS the node (rule 3) — an older envelope shape that predates entryMode is
  // analyzed exactly as before.
  | { when: "clone_demand_driven_entry"; reason?: string }
  // T15.34 clone_conductor — pdf_template_designer's gate (#210; ADR-2026-08-25-structure-studio
  // §7). Skip when the upstream pdf_template_intake envelope POSITIVELY declares zero entries — no
  // pdfTemplateBrief was supplied on this run's initialInput (the overwhelming majority of studio
  // runs, which design site structure, not PDF templates) or every briefed entry was rejected at
  // intake (e.g. no siteId). Mirrors clone_no_actionable_mismatches exactly: reads a structural fact
  // of ONE named upstream envelope (never raw initialInput itself — that stays pdf_template_intake's
  // job), and an absent/unreadable envelope RUNS the node (rule 3).
  | { when: "clone_no_pdf_template_entries"; reason?: string };

export type SkipPredicateKind = SkipPredicate["when"];
export const SKIP_PREDICATE_KINDS: readonly SkipPredicateKind[] = ["content_class_in", "no_media_slots", "no_external_claims", "review_tier_excludes", "capture_rights_allow_extracted_copy", "capture_no_declined_blocks", "clone_no_actionable_mismatches", "clone_demand_driven_entry", "clone_no_pdf_template_entries"];

// ---------------------------------------------------------------------------------------------
// REVIEW QUARTET TIERING — operator policy, decided by Wolf 2026-08-12. Three tiers:
//
//   docs / runbook class   → trust_factual ONLY. Documentation fails on being WRONG, not on being
//                            unmoving; a runbook does not need emotional resonance modelled.
//   standard editorial     → trust_factual + human_texture + reader_simulation. The reader must be
//                            able to follow it and it must not read as machine prose; emotional
//                            resonance is the dial that matters least when nothing is being sold.
//   money class            → all four. Copy that asks for money gets every reviewer.
//   absent / unrecognized  → ALL FOUR. Fail-safe: an unclassified run is treated as the most
//                            demanding one. Skipping a reviewer requires a positive declaration.
//
// The tier lists are the POLICY; the per-node predicate ({when:"review_tier_excludes"}) is just how a
// node asks whether it is in the selected tier.
export const REVIEW_QUARTET = ["trust_factual", "human_texture", "emotional_resonance", "reader_simulation"] as const;
export type ReviewerNodeId = typeof REVIEW_QUARTET[number];
export type ReviewTier = "docs" | "standard" | "full";

export const REVIEW_TIER_MEMBERS: Record<ReviewTier, readonly ReviewerNodeId[]> = {
  docs: ["trust_factual"],
  standard: ["trust_factual", "human_texture", "reader_simulation"],
  full: [...REVIEW_QUARTET]
};

// Content-class vocabularies. Tight on purpose: a class this file does not recognize is NOT a licence
// to skip anything (rule 3), so widening these sets is a deliberate policy act, not a typo away.
export const DOCS_CONTENT_CLASSES: readonly string[] = ["docs", "doc", "documentation", "runbook", "runbooks", "reference", "internal_docs", "internal_documentation", "changelog", "release_notes"];
export const MONEY_CONTENT_CLASSES: readonly string[] = ["money", "money_page", "commercial", "affiliate", "monetized", "transactional", "offer", "sales"];
export const STANDARD_CONTENT_CLASSES: readonly string[] = ["standard", "editorial", "standard_editorial", "article", "blog", "blog_post", "client_property"];

const normalizeToken = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, "_");
const inSet = (set: readonly string[], value: string | undefined): boolean => value !== undefined && set.includes(normalizeToken(value));

export const isDocsContentClass = (contentClass: string | undefined): boolean => inSet(DOCS_CONTENT_CLASSES, contentClass);
export const isMoneyContentClass = (contentClass: string | undefined): boolean => inSet(MONEY_CONTENT_CLASSES, contentClass);

export type ReviewTierResolution = { tier: ReviewTier; reviewers: readonly ReviewerNodeId[]; basis: string };

// The one place a run's review tier comes from.
export function resolveReviewTier(contentClass: string | undefined): ReviewTierResolution {
  const tier = (): { tier: ReviewTier; basis: string } => {
    if (contentClass === undefined) return { tier: "full", basis: "no content class declared on this run — full quartet by fail-safe default" };
    if (isDocsContentClass(contentClass)) return { tier: "docs", basis: `content class "${contentClass}" is docs/runbook class` };
    if (isMoneyContentClass(contentClass)) return { tier: "full", basis: `content class "${contentClass}" is money class` };
    if (inSet(STANDARD_CONTENT_CLASSES, contentClass)) return { tier: "standard", basis: `content class "${contentClass}" is standard editorial` };
    return { tier: "full", basis: `content class "${contentClass}" is not a class this policy recognizes — full quartet by fail-safe default` };
  };
  const resolved = tier();
  return { tier: resolved.tier, reviewers: REVIEW_TIER_MEMBERS[resolved.tier], basis: resolved.basis };
}

// ---------------------------------------------------------------------------------------------
// Evaluation context: run facts only. No repository, no network, no model — a predicate is a pure
// function of what the run already holds, which is why it can be evaluated before the dispatch and
// re-evaluated identically afterwards when someone asks why a node did not run.
export type SkipEvaluationContext = {
  nodeId: string;
  // The node's declared dependencies, so a predicate reads the artifacts this node would have been
  // handed rather than rummaging through the whole run.
  dependsOn?: readonly string[];
  initialInput?: unknown;
  stageOutputs?: Record<string, unknown>;
};

export type SkipVerdict = {
  skip: boolean;
  // The predicate that decided. Present on a skip; present on a no-skip too when exactly one
  // predicate was evaluated, so "why did this run" is as answerable as "why did this not".
  predicate?: SkipPredicate;
  reason: string;
  // The facts the decision was made on, in the order they were read. This is what makes a skip
  // auditable rather than merely recorded.
  basis: string[];
  // Malformed / unrecognized predicate names, surfaced as run warnings by the caller. A metadata typo
  // that quietly disabled gating would be indistinguishable from gating that decided to run.
  warnings: string[];
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// A carrier marked dryRun is a MOCK placeholder (MockNodeRunner's fixtures carry it, and
// readPlacementTarget already refuses them for the same reason): a placeholder must never be the
// evidence that something real is absent.
const isPlaceholder = (value: unknown): boolean => isObject(value) && value.dryRun === true;

// Read a value from a carrier at its top level or under `contentSource` — the same carrier convention
// extractPlacementSignals and readContentClass use, so a run declares its facts in one place.
const readDeclared = (carrier: unknown, keys: readonly string[]): { value: unknown; key: string } | undefined => {
  for (const scope of [carrier, isObject(carrier) ? carrier.contentSource : undefined]) {
    if (!isObject(scope)) continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(scope, key) && scope[key] !== undefined && scope[key] !== null) return { value: scope[key], key };
    }
  }
  return undefined;
};

// "Is this declaration telling me there IS something?" — true/false, a count, or a list. Anything
// else is not a usable declaration and is ignored (rule 3).
const declarationPresence = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  return undefined;
};

const carriersFor = (context: SkipEvaluationContext, extra: readonly string[] = []): unknown[] => {
  const stageOutputs = context.stageOutputs ?? {};
  const ids = [...(context.dependsOn ?? []), ...extra];
  return [context.initialInput, ...ids.map((id) => stageOutputs[id])];
};

// ---------------------------------------------------------------------------------------------
// Predicate 1 — content_class_in.
function evaluateContentClassIn(predicate: Extract<SkipPredicate, { when: "content_class_in" }>, context: SkipEvaluationContext): SkipVerdict {
  const declared = readDeclaredContentClass(context.initialInput, context.stageOutputs?.input_triage);
  const classes = (predicate.classes ?? []).map(normalizeToken);
  if (declared === undefined) {
    return { skip: false, predicate, reason: `${context.nodeId} runs: no content class is declared on this run, and an undeclared class never satisfies a skip.`, basis: ["contentClass: not declared"], warnings: [] };
  }
  const matched = classes.includes(normalizeToken(declared));
  return {
    skip: matched,
    predicate,
    reason: matched
      ? predicate.reason ?? `${context.nodeId} skipped: the run declares content class "${declared}", which this node's skip policy excludes (${classes.join(", ")}).`
      : `${context.nodeId} runs: declared content class "${declared}" is not in this node's skip set (${classes.join(", ")}).`,
    basis: [`contentClass: ${declared}`, `skipClasses: ${classes.join(", ")}`],
    warnings: []
  };
}

// ---------------------------------------------------------------------------------------------
// Predicate 2 — no_media_slots. artifact_plan's own rule, moved pre-dispatch.
//
// Two ways to know, in order: an EXPLICIT media declaration on the run or on an upstream artifact,
// then a STRUCTURAL scan of the client object the plan would have planned artifacts for. A client
// object with real nodes and not one media reference in any of them is the zero-media case stated as
// a fact rather than as a model's summary of a fact.
const MEDIA_DECLARATION_KEYS = ["mediaSlots", "media_slots", "mediaPlan", "media_plan", "artifactRequests", "artifact_requests", "imageSlots", "image_slots"] as const;
const NO_MEDIA_FLAG_KEYS = ["noMedia", "no_media"] as const;

type MediaNode = { public?: { media?: { src?: unknown } | unknown } };
const clientObjectNodesOf = (envelope: unknown): MediaNode[] | undefined => {
  if (!isObject(envelope)) return undefined;
  const body = envelope.body;
  if (!isObject(body)) return undefined;
  return Array.isArray(body.nodes) ? (body.nodes as MediaNode[]) : undefined;
};

const mediaReferenceCount = (nodes: MediaNode[]): number =>
  nodes.filter((node) => {
    const media = isObject(node) && isObject(node.public) ? (node.public as Record<string, unknown>).media : undefined;
    if (media === undefined || media === null) return false;
    if (isObject(media)) return Object.keys(media).length > 0;
    return true;
  }).length;

function evaluateNoMediaSlots(predicate: Extract<SkipPredicate, { when: "no_media_slots" }>, context: SkipEvaluationContext): SkipVerdict {
  const basis: string[] = [];
  for (const carrier of carriersFor(context)) {
    if (isPlaceholder(carrier)) { basis.push("carrier: mock placeholder (dryRun) — not evidence"); continue; }
    const flag = readDeclared(carrier, NO_MEDIA_FLAG_KEYS);
    if (flag && flag.value === true) {
      basis.push(`${flag.key}: true`);
      return { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: the run declares ${flag.key}=true, so there is no media slot to plan.`, basis, warnings: [] };
    }
    const declaration = readDeclared(carrier, MEDIA_DECLARATION_KEYS);
    const presence = declaration ? declarationPresence(declaration.value) : undefined;
    if (declaration && presence !== undefined) {
      basis.push(`${declaration.key}: ${presence ? "non-empty" : "empty"}`);
      return presence
        ? { skip: false, predicate, reason: `${context.nodeId} runs: ${declaration.key} declares media to plan.`, basis, warnings: [] }
        : { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: ${declaration.key} is declared and empty — no media slot exists to plan.`, basis, warnings: [] };
    }
  }
  // Structural scan of the client object, the artifact this node plans against.
  for (const carrier of carriersFor(context)) {
    if (isPlaceholder(carrier)) continue;
    const nodes = clientObjectNodesOf(carrier);
    if (!nodes) continue;
    const count = mediaReferenceCount(nodes);
    basis.push(`client object: ${nodes.length} node(s), ${count} carrying media`);
    return count === 0
      ? { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: the client object carries ${nodes.length} node(s) and not one media reference, so there is no artifact to plan or materialize.`, basis, warnings: [] }
      : { skip: false, predicate, reason: `${context.nodeId} runs: the client object carries ${count} media reference(s) to plan artifacts for.`, basis, warnings: [] };
  }
  basis.push("no media declaration and no scannable client object");
  return { skip: false, predicate, reason: `${context.nodeId} runs: nothing in this run states whether media is needed, and an unanswered question is answered by running.`, basis, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Predicate 3 — no_external_claims. research's trigger.
//
// SIGNAL NOTE (documented because it is a compromise, not a design): there is no clean upstream
// external-claims fact today. input_triage's output schema is the generic {artifact, summary, notes}
// shape, so the "brief/triage facts indicating external claims" the work order hopes for do not exist
// as structured data. This predicate therefore keys on, in order:
//   1. an EXPLICIT declaration anywhere on the run or its upstream artifacts (externalClaims,
//      requiresResearch, researchRequired, ... — true/false, a count, or a list),
//   2. failing that, the run's declared CONTENT CLASS: docs/runbook class skips research (a runbook
//      documents this system, whose facts are in this repository, not on the web),
//   3. failing that, RESEARCH RUNS. An unclassified run keeps the $0.06 and its browsing.
// When input_triage gains a real external-claims field, step 1 picks it up with no change here.
const EXTERNAL_CLAIM_KEYS = ["externalClaims", "external_claims", "externalClaimsExpected", "requiresResearch", "requires_research", "researchRequired", "research_required"] as const;

function evaluateNoExternalClaims(predicate: Extract<SkipPredicate, { when: "no_external_claims" }>, context: SkipEvaluationContext): SkipVerdict {
  const basis: string[] = [];
  for (const carrier of carriersFor(context, ["input_triage", "topic_opportunity", "reader_insight"])) {
    if (isPlaceholder(carrier)) continue;
    const declaration = readDeclared(carrier, EXTERNAL_CLAIM_KEYS);
    const presence = declaration ? declarationPresence(declaration.value) : undefined;
    if (declaration && presence !== undefined) {
      basis.push(`${declaration.key}: ${presence}`);
      return presence
        ? { skip: false, predicate, reason: `${context.nodeId} runs: ${declaration.key} declares external claims that need checking.`, basis, warnings: [] }
        : { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: ${declaration.key} is declared false/empty — this run makes no external claim to verify.`, basis, warnings: [] };
    }
  }
  const declaredClass = readDeclaredContentClass(context.initialInput, context.stageOutputs?.input_triage);
  basis.push(`contentClass: ${declaredClass ?? "not declared"}`);
  if (isDocsContentClass(declaredClass)) {
    return { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: no external-claim declaration on this run and the declared content class "${declaredClass}" is docs/runbook class, whose facts live in this system rather than on the web.`, basis, warnings: [] };
  }
  return { skip: false, predicate, reason: `${context.nodeId} runs: no declaration says this run is claim-free and its content class is not docs class.`, basis, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Predicate 4 — review_tier_excludes.
function evaluateReviewTierExcludes(predicate: Extract<SkipPredicate, { when: "review_tier_excludes" }>, context: SkipEvaluationContext): SkipVerdict {
  const reviewer = nonEmptyString(predicate.reviewer) ? predicate.reviewer.trim() : context.nodeId;
  const declaredClass = readDeclaredContentClass(context.initialInput, context.stageOutputs?.input_triage);
  const tier = resolveReviewTier(declaredClass);
  const included = (tier.reviewers as readonly string[]).includes(reviewer);
  const basis = [`contentClass: ${declaredClass ?? "not declared"}`, `reviewTier: ${tier.tier} (${tier.basis})`, `tierReviewers: ${tier.reviewers.join(", ")}`];
  return {
    skip: !included,
    predicate,
    reason: included
      ? `${reviewer} runs: it is in the ${tier.tier} review tier selected for this run.`
      : predicate.reason ?? `${reviewer} skipped: the ${tier.tier} review tier for this run runs ${tier.reviewers.join(" + ")} only (operator review-tier policy, Wolf 2026-08-12).`,
    basis,
    warnings: []
  };
}

// ---------------------------------------------------------------------------------------------
// Predicates 5 + 6 — the capture_conductor gates (T12.9). Both read STRUCTURAL facts the capture
// engine stamps onto its stage envelopes (policy rights; the declined-block ledger), both resolve
// every uncertainty toward running (rule 3), and both ignore mock placeholders like every other
// predicate here.
function evaluateCaptureRightsAllowExtractedCopy(predicate: Extract<SkipPredicate, { when: "capture_rights_allow_extracted_copy" }>, context: SkipEvaluationContext): SkipVerdict {
  const basis: string[] = [];
  for (const carrier of carriersFor(context)) {
    if (isPlaceholder(carrier)) { basis.push("carrier: mock placeholder (dryRun) — not evidence"); continue; }
    if (!isObject(carrier)) continue;
    const policy = carrier.policy;
    const rights = isObject(policy) ? policy.rights : undefined;
    const content = isObject(rights) ? rights.content : undefined;
    if (typeof content !== "string") continue;
    basis.push(`policy.rights.content: ${content}`);
    return content === "retain_allowed_origin_content"
      ? { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: the target project's capture rights permit retaining extracted allowed-origin copy, so there is nothing to regenerate.`, basis, warnings: [] }
      : { skip: false, predicate, reason: `${context.nodeId} runs: the target project's capture rights (${content}) do not permit extracted copy, so regeneration is required before live emission.`, basis, warnings: [] };
  }
  basis.push("no capture policy rights declared on any upstream envelope");
  return { skip: false, predicate, reason: `${context.nodeId} runs: no upstream capture envelope declares the rights fact, and an unanswered question is answered by running.`, basis, warnings: [] };
}

function evaluateCaptureNoDeclinedBlocks(predicate: Extract<SkipPredicate, { when: "capture_no_declined_blocks" }>, context: SkipEvaluationContext): SkipVerdict {
  const basis: string[] = [];
  for (const carrier of carriersFor(context)) {
    if (isPlaceholder(carrier)) { basis.push("carrier: mock placeholder (dryRun) — not evidence"); continue; }
    if (!isObject(carrier) || !Array.isArray(carrier.declinedBlocks)) continue;
    basis.push(`declinedBlocks: ${carrier.declinedBlocks.length}`);
    return carrier.declinedBlocks.length === 0
      ? { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: the heuristic mapper declined zero blocks, so there is nothing for the classifier to judge.`, basis, warnings: [] }
      : { skip: false, predicate, reason: `${context.nodeId} runs: the heuristic mapper declined ${carrier.declinedBlocks.length} block(s) awaiting classification.`, basis, warnings: [] };
  }
  basis.push("no declined-block ledger declared on any upstream envelope");
  return { skip: false, predicate, reason: `${context.nodeId} runs: no upstream capture-map envelope declares a declined-block ledger, and an unanswered question is answered by running.`, basis, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Predicate 7 — the clone_conductor gate (T13.2). recipe_designer exists to design the recipes that
// close layout_analyst's mismatches; when the analyst found none a recipe could close, there is
// nothing to design. The ACTIONABLE set is exactly the two kinds a recipe is: a `section_template`
// blueprint and a page `template`. `none` is the analyst saying no recipe closes that divergence —
// a first-class honest answer (a missing section TYPE is code, not data), so a ledger of nothing but
// `none` is a positive declaration that the designer has no work, not a gap to run into. Per rule 3
// an absent or unreadable analysis envelope RUNS the node, and a mock placeholder is never evidence.
const CLONE_ACTIONABLE_RECIPE_KINDS: readonly string[] = ["section_template", "template"];

function evaluateCloneNoActionableMismatches(predicate: Extract<SkipPredicate, { when: "clone_no_actionable_mismatches" }>, context: SkipEvaluationContext): SkipVerdict {
  const basis: string[] = [];
  for (const carrier of carriersFor(context)) {
    if (isPlaceholder(carrier)) { basis.push("carrier: mock placeholder (dryRun) — not evidence"); continue; }
    if (!isObject(carrier) || !Array.isArray(carrier.mismatches)) continue;
    const actionable = carrier.mismatches.filter((mismatch) => isObject(mismatch) && nonEmptyString(mismatch.missingRecipeKind) && CLONE_ACTIONABLE_RECIPE_KINDS.includes(normalizeToken(mismatch.missingRecipeKind)));
    basis.push(`mismatches: ${carrier.mismatches.length}`);
    basis.push(`actionable (section_template|template): ${actionable.length}`);
    return actionable.length === 0
      ? { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: layout_analyst reported ${carrier.mismatches.length} mismatch(es), none of which a section_template or template could close, so there is no recipe to design.`, basis, warnings: [] }
      : { skip: false, predicate, reason: `${context.nodeId} runs: layout_analyst reported ${actionable.length} mismatch(es) a new recipe could close.`, basis, warnings: [] };
  }
  basis.push("no layout-analysis mismatch ledger declared on any upstream envelope");
  return { skip: false, predicate, reason: `${context.nodeId} runs: no upstream clone_layout_analysis envelope declares a mismatch ledger, and an unanswered question is answered by running.`, basis, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Predicate 8 — the clone_conductor demand-driven-entry gate (T15.30/#206). layout_analyst's whole
// job is comparing a SOURCE shape to an EMITTED one; a demand-driven run has no capture snapshot to
// derive either from, so the comparison is not merely unneeded, it is impossible to perform honestly.
// clone_intake states which entry produced this run (`entryMode`, engine/clone.mjs's
// buildCloneIntake) as a STRUCTURAL fact of its own envelope — never a model's inference — so this
// predicate reads it exactly the way capture_rights_allow_extracted_copy reads `policy.rights.content`.
function evaluateCloneDemandDrivenEntry(predicate: Extract<SkipPredicate, { when: "clone_demand_driven_entry" }>, context: SkipEvaluationContext): SkipVerdict {
  const basis: string[] = [];
  for (const carrier of carriersFor(context)) {
    if (isPlaceholder(carrier)) { basis.push("carrier: mock placeholder (dryRun) — not evidence"); continue; }
    if (!isObject(carrier) || typeof carrier.entryMode !== "string") continue;
    basis.push(`entryMode: ${carrier.entryMode}`);
    return carrier.entryMode === "demand"
      ? { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: clone_intake declares entryMode "demand" — a demand-driven run carries no capture snapshot to diff a source shape against, so there is nothing for the layout analyst to compare.`, basis, warnings: [] }
      : { skip: false, predicate, reason: `${context.nodeId} runs: clone_intake declares entryMode "${carrier.entryMode}", not "demand".`, basis, warnings: [] };
  }
  basis.push("no entryMode declared on any upstream envelope");
  return { skip: false, predicate, reason: `${context.nodeId} runs: no upstream clone_intake envelope declares entryMode, and an unanswered question is answered by running.`, basis, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Predicate 9 — the clone_conductor pdf-template gate (T15.34/#210; ADR-2026-08-25-structure-studio
// §7). pdf_template_designer exists to propose the template_json content that closes a BRIEFED pdf
// template need; when pdf_template_intake named none (no pdfTemplateBrief on this run, or every
// entry rejected at intake) there is nothing to design. Reads `entries` as an ARRAY, structurally —
// the same shape clone_no_actionable_mismatches reads `mismatches` — never `rejectedEntries`, which
// is evidence of what was REFUSED, not of what remains to design.
function evaluateCloneNoPdfTemplateEntries(predicate: Extract<SkipPredicate, { when: "clone_no_pdf_template_entries" }>, context: SkipEvaluationContext): SkipVerdict {
  const basis: string[] = [];
  for (const carrier of carriersFor(context)) {
    if (isPlaceholder(carrier)) { basis.push("carrier: mock placeholder (dryRun) — not evidence"); continue; }
    if (!isObject(carrier) || carrier.artifact !== "pdf_template_intake.v1" || !Array.isArray(carrier.entries)) continue;
    basis.push(`entries: ${carrier.entries.length}`);
    return carrier.entries.length === 0
      ? { skip: true, predicate, reason: predicate.reason ?? `${context.nodeId} skipped: pdf_template_intake named zero usable entries (no pdfTemplateBrief on this run, or every briefed entry was rejected at intake), so there is no PDF template to design.`, basis, warnings: [] }
      : { skip: false, predicate, reason: `${context.nodeId} runs: pdf_template_intake named ${carrier.entries.length} PDF-template entrie(s) to design.`, basis, warnings: [] };
  }
  basis.push("no pdf_template_intake envelope declared on any upstream carrier");
  return { skip: false, predicate, reason: `${context.nodeId} runs: no upstream pdf_template_intake envelope declares an entries array, and an unanswered question is answered by running.`, basis, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Metadata parsing. `skipWhen` accepts a single predicate or an array of them; an array means OR
// (the first predicate that fires skips the node), which is the only composition rule worth having
// while predicates are this few — AND would let two half-true conditions add up to a skip nobody
// intended.
export function readSkipPredicates(metadata: unknown): { predicates: SkipPredicate[]; warnings: string[] } {
  const declared = isObject(metadata) ? metadata.skipWhen : undefined;
  if (declared === undefined || declared === null) return { predicates: [], warnings: [] };
  const entries = Array.isArray(declared) ? declared : [declared];
  const predicates: SkipPredicate[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || !nonEmptyString(entry.when)) { warnings.push("skip_predicate_malformed:not_a_predicate_object"); continue; }
    const when = entry.when.trim();
    if (!(SKIP_PREDICATE_KINDS as readonly string[]).includes(when)) { warnings.push(`skip_predicate_unrecognized:${when}`); continue; }
    if (when === "content_class_in" && !(Array.isArray(entry.classes) && entry.classes.every(nonEmptyString) && entry.classes.length > 0)) {
      warnings.push("skip_predicate_malformed:content_class_in_requires_classes");
      continue;
    }
    predicates.push(entry as unknown as SkipPredicate);
  }
  return { predicates, warnings };
}

const evaluatePredicate = (predicate: SkipPredicate, context: SkipEvaluationContext): SkipVerdict => {
  switch (predicate.when) {
    case "content_class_in": return evaluateContentClassIn(predicate, context);
    case "no_media_slots": return evaluateNoMediaSlots(predicate, context);
    case "no_external_claims": return evaluateNoExternalClaims(predicate, context);
    case "review_tier_excludes": return evaluateReviewTierExcludes(predicate, context);
    case "capture_rights_allow_extracted_copy": return evaluateCaptureRightsAllowExtractedCopy(predicate, context);
    case "capture_no_declined_blocks": return evaluateCaptureNoDeclinedBlocks(predicate, context);
    case "clone_no_actionable_mismatches": return evaluateCloneNoActionableMismatches(predicate, context);
    case "clone_demand_driven_entry": return evaluateCloneDemandDrivenEntry(predicate, context);
    case "clone_no_pdf_template_entries": return evaluateCloneNoPdfTemplateEntries(predicate, context);
    default: {
      // Unreachable through readSkipPredicates; kept because an unrecognized rule must be inert
      // rather than throwing inside a dispatch path.
      const unknownPredicate = predicate as { when?: string };
      return { skip: false, reason: `${context.nodeId} runs: unrecognized skip predicate "${unknownPredicate.when}".`, basis: [], warnings: [`skip_predicate_unrecognized:${unknownPredicate.when}`] };
    }
  }
};

// The executor's entry point. Returns undefined for a node that declares no skipWhen at all (the
// overwhelming majority), so the caller can tell "no policy" from "policy said run".
//
// The node's metadata is read through the gating seed (nodeGatingSeed.ts): the node's OWN metadata
// wins wherever it declares `skipWhen` — including declaring it empty, which is how an operator turns
// a policy off from the store without a deploy — and the seeded policy fills the key in otherwise.
export function evaluateNodeSkip(node: { id: string; dependsOn?: readonly string[]; metadata?: Record<string, unknown> | undefined }, context: Omit<SkipEvaluationContext, "nodeId" | "dependsOn">): SkipVerdict | undefined {
  const { predicates, warnings } = readSkipPredicates(gatedMetadata(node));
  if (!predicates.length && !warnings.length) return undefined;
  const evaluationContext: SkipEvaluationContext = { nodeId: node.id, dependsOn: node.dependsOn, initialInput: context.initialInput, stageOutputs: context.stageOutputs };
  const basis: string[] = [];
  for (const predicate of predicates) {
    const verdict = evaluatePredicate(predicate, evaluationContext);
    basis.push(...verdict.basis);
    if (verdict.skip) return { ...verdict, basis, warnings: [...warnings, ...verdict.warnings] };
  }
  return {
    skip: false,
    predicate: predicates.length === 1 ? predicates[0] : undefined,
    reason: predicates.length ? `${node.id} runs: no skip predicate fired.` : `${node.id} runs: no usable skip predicate was declared.`,
    basis,
    warnings
  };
}

// ---------------------------------------------------------------------------------------------
// DOWNSTREAM SEMANTICS — "satisfied with absent".
//
// A skipped node is not a missing node and not a failed one: the conductor decided it had nothing to
// contribute, so a dependant treats the dependency as SATISFIED and its output as ABSENT. This is the
// whole reason review_aggregator can aggregate over one, three or four reviewers without knowing in
// advance which; and why a deliberately-skipped node never becomes a publish blocker.
export const SKIPPED_NODE_STATUS = "skipped" as const;

// The ledger handed to a dependant in its own input, so "this input is absent" arrives with the
// reason attached rather than as an unexplained hole.
export type SkippedDependencyEntry = { nodeId: string; reason: string; predicate?: SkipPredicate };

export function renderSkippedDependencyPolicy(entries: readonly SkippedDependencyEntry[]): string | undefined {
  if (!entries.length) return undefined;
  return `The conductor deliberately SKIPPED ${entries.length} of this node's upstream dependencies for this run: ${entries.map((entry) => `${entry.nodeId} (${entry.reason})`).join("; ")}. ` +
    "Their outputs are absent by decision, not by failure. Work with the inputs you DO have, say what you covered, and never wait for, re-request, guess at, or invent the skipped node's output.";
}
