// W1 + W6.1 (determinism program, 2026-08-12; docs/plan/WORK-ORDER-2026-08-12-determinism.md) — the
// deterministic half of publication_controller, and the conductor rule that makes upstream blockers
// reach the decision.
//
// WHY THIS EXISTS (W1). publication_controller spent ~$0.10/run producing a GO verdict that
// `workflow.publish_readiness` — an existing, side-effect-free server capability driven by the
// project's OWN readiness hook — already produced for $0 on the same run. The node's job is to read a
// checklist and state a decision; the checklist is computed by policy code, not by judgment. So the
// conductor calls the readiness FUNCTION engine-side (evaluatePublishReadiness in publisher.ts — the
// same function the MCP tool wraps, never a round trip through MCP) and maps:
//     readiness.status          -> decision
//     readiness.checklist[].detail -> notes
//     readiness.blockers        -> blockers
//
// WHY THIS EXISTS (W6.1). On run_1786468126136_ev9goe the controller emitted decision:"go" while
// contract_intelligence carried `aggression_ceiling_missing` and monetization_strategy's EV floor said
// block. Upstream blockers never reached the decision because nothing but prompt text carried them.
// Here they are a RULE: every upstream stage output's `blockers[]` is collected, and the decision
// cannot be "go" while any unwaived blocker exists.
//
// THE WAIVER, AND WHY IT IS AUDITED. Wolf's standing ruling (2026-08-12): own-property content is
// exempt from EV-floor and aggression-ceiling blockers BY RULE — an own property has no affiliate EV
// to clear and no client-declared aggression ceiling to resolve against. The exemption is NOT silent:
// every waived blocker is recorded in `waivedBlockers[]` on the decision output with the rule that
// waived it and the node that raised it, so an audit can always answer "what was waived, by which
// rule, on whose say-so". Everything else HARD blocks. A content class that is not own-property waives
// nothing.
//
// WHY THIS EXISTS (W7, 2026-08-25, run_1787655709652_4k1z56). The blocker RULE above was
// indiscriminate: it treated a model's opinion about editorial quality as exactly as fatal as a broken
// integrity fact. On that run, `topic_opportunity: No viable public reader value for a real article.`
// and `brief_architect: ...should be reframed as a real dermatology topic with evidence.` blocked the
// publish as hard as `publish_readiness: article_has_content` (body.nodes empty — nothing would
// render) and `article_body: article_body_validation_unavailable:MCP request failed with HTTP 401`.
// The consequence: a fixture article can NEVER publish however many approvals are given, because the
// review nodes will always (correctly) object to placeholder content. Upstream blockers are now split
// by the node that raised them (blockerClassification.ts): INTEGRITY hard-blocks, EDITORIAL is
// ADVISORY — recorded in `advisories[]`, counted separately in the summary, and never able to flip the
// decision to no_go. Nothing is dropped, nothing about content integrity is weakened, unrecognised
// sources fail closed to INTEGRITY, and a project may promote an editorial source back to hard through
// publishingPolicy.hardBlockerSources.
//
// SAFETY. This is a fast path, not the only path: the caller (executor.ts) validates the built record
// against the node's OWN outputSchema and falls through to the model dispatch on any failure, exactly
// as the contract_intelligence / publish_payload deterministic paths do. It also refuses to decide at
// all when the project has no readiness policy (`available: false`) — an invented decision from a
// missing checklist is precisely the failure mode this module exists to remove.

import { evaluatePublishReadiness } from "./publisher.js";
import { classifyBlockerSource, type BlockerClass } from "./blockerClassification.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { PublishReadinessResult } from "../projects/projectHooks.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";

export const PUBLICATION_DECISION_ARTIFACT = "publication_decision.v1";

// The three decisions the node's (store-side) outputSchema admits. "go" additionally requires an EMPTY
// blockers array — the schema enforces it with an if/then, publishDecision.readPublicationDecision
// enforces it again at the publish gate, and this module never emits a "go" carrying a blocker.
export type PublicationDecision = "go" | "no_go" | "blocked";

// An upstream blocker with the node that raised it, so a waiver (or a hard block) can always name its
// source. Order is the conductor's node order, not object-key order — determinism includes ordering.
export type SourcedBlocker = { nodeId: string; blocker: string };

export type WaivedBlocker = SourcedBlocker & { rule: string; reason: string };

// W7 — an EDITORIAL blocker, demoted to advice. Carries the source node, the class that demoted it and
// the one-line rationale from the classification table, so "why did this not stop the publish?" is
// answerable from the decision record alone, without reading any code.
export type AdvisoryBlocker = SourcedBlocker & { class: BlockerClass; rationale: string };

export type PublicationDecisionOutput = {
  artifact: typeof PUBLICATION_DECISION_ARTIFACT;
  summary: string;
  decision: PublicationDecision;
  state: "ready_for_publish_execution" | "blocked_for_publish_execution";
  blockers: string[];
  waivedBlockers: WaivedBlocker[];
  // W7 — every editorial blocker that was recorded rather than enforced. NEVER a reason for no_go, and
  // never empty-by-omission: an editorial blocker that reached this decision is in here or it is in
  // `blockers`, never nowhere.
  advisories: AdvisoryBlocker[];
  contentClass: string;
  checklist: PublishReadinessResult["checklist"];
  nextAction: string;
  notes: string[];
};

export type PublicationControllerResult =
  | { ok: true; decision: PublicationDecisionOutput }
  | { ok: false; code: string; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// ---------------------------------------------------------------------------------------------
// W6.1 — the own-property signal.
//
// No existing run fact carries a content class: input_triage's outputSchema is the generic
// {artifact, summary, notes} shape, and aggressionVector's trafficSource/awarenessStage describe the
// PLACEMENT, not who owns the property. So the class is keyed on an EXPLICIT run-level field, read
// from the run's initial input (top level or under `contentSource`) and from input_triage's own
// echoed envelope, under either spelling:
//
//     contentClass: "own_property"   (also accepted: content_class, "owned_property", "own-property")
//     ownProperty: true              (also accepted: own_property: true)
//
// Explicit by design: a waiver that switches itself on from an inferred signal is a waiver nobody
// authorized. Absent field => not own property => nothing is waived.
export const OWN_PROPERTY_CONTENT_CLASS = "own_property";
export const DEFAULT_CONTENT_CLASS = "client_property";

const OWN_PROPERTY_VALUES = new Set(["own_property", "ownproperty", "own-property", "owned_property", "owned-property", "own", "owned"]);

const readContentClassFrom = (carrier: unknown): string | undefined => {
  if (!isObject(carrier)) return undefined;
  for (const key of ["contentClass", "content_class"]) {
    const value = carrier[key];
    if (nonEmptyString(value)) return value.trim().toLowerCase();
  }
  for (const key of ["ownProperty", "own_property"]) {
    if (carrier[key] === true) return OWN_PROPERTY_CONTENT_CLASS;
    if (carrier[key] === false) return DEFAULT_CONTENT_CLASS;
  }
  return undefined;
};

// First explicit declaration wins, scanned carrier by carrier in the order the caller supplies them
// (executor passes: run.initialInput, then input_triage's output). Each carrier is read both at its
// top level and under `contentSource`, mirroring extractPlacementSignals' carrier convention.
//
// W4 (2026-08-12) — split in two WITHOUT changing readContentClass's behaviour, because the skip
// predicates need a distinction this waiver does not: whether a class was DECLARED at all.
// readContentClass answers "which class is in force" and defaults to client_property, which is the
// right answer for a waiver (absent ⇒ waive nothing). A skip predicate asking the same question would
// read that default as a positive declaration and could gate on it, so it calls
// readDeclaredContentClass, which returns undefined when nobody said. Same signal, same carriers, one
// reader — deliberately not a second content-class concept.
export function readDeclaredContentClass(...carriers: unknown[]): string | undefined {
  for (const carrier of carriers) {
    for (const value of [carrier, isObject(carrier) ? carrier.contentSource : undefined]) {
      const declared = readContentClassFrom(value);
      if (declared !== undefined) return OWN_PROPERTY_VALUES.has(declared) ? OWN_PROPERTY_CONTENT_CLASS : declared;
    }
  }
  return undefined;
}

export function readContentClass(...carriers: unknown[]): string {
  return readDeclaredContentClass(...carriers) ?? DEFAULT_CONTENT_CLASS;
}

export const isOwnProperty = (contentClass: string): boolean => contentClass === OWN_PROPERTY_CONTENT_CLASS;

// ---------------------------------------------------------------------------------------------
// The two blocker classes Wolf's ruling exempts, and NOTHING else. Both patterns are deliberately
// narrow and anchored on the vocabulary the engine itself emits: aggressionVector.ts raises
// `aggression_ceiling_missing`, evFloor.ts / monetization_strategy speak of the EV floor. A blocker
// that merely mentions "monetization" or "aggression" in passing is not waived — an over-broad waiver
// is the same defect as no blocker propagation at all, one indirection later.
export const EV_FLOOR_BLOCKER = /\bev[_ -]?floor\b|expected[_ -]?value[_ -]?floor|below[_ -]the[_ -]ev|does not (?:meet|clear) the (?:ev|expected value) floor/i;
export const AGGRESSION_CEILING_BLOCKER = /aggression[_ -]?ceiling/i;

export const WAIVER_RULE_ID = "own_property_ev_and_aggression_exemption";
const WAIVER_REASON =
  "Standing operator ruling (Wolf, 2026-08-12): own-property content is exempt from EV-floor and aggression-ceiling blockers by rule — an own property has no affiliate expected value to clear and no client-declared aggression ceiling to resolve against. Recorded here, not silently dropped.";

const isWaivableBlocker = (blocker: string): boolean => EV_FLOOR_BLOCKER.test(blocker) || AGGRESSION_CEILING_BLOCKER.test(blocker);

// Blocker identity for de-duplication: whitespace and case are presentation, not meaning (same rule
// publishPayload.ts's blockerKey uses; the first-seen wording is the one carried, never a re-worded
// merge that would rewrite an upstream node's own words).
const blockerKey = (blocker: string): string => blocker.trim().toLowerCase().replace(/\s+/g, " ");

// Collect every `blockers[]` entry from the supplied stage outputs, in the order given (the
// conductor's canonical node order), de-duplicated across nodes.
//
// Dedup identity is PREFIX-AWARE (run_1786549907145_hf4wgb): an aggregator node that echoes an
// upstream blocker prefixes it with its source ("contract_intelligence: aggression_ceiling_missing…"),
// which defeated a raw-string dedup and inflated 7 real blockers to 19. Identity therefore strips any
// repeated leading "<node-id>: " where <node-id> is a node in THIS collection — never an arbitrary
// "word:" prefix, because this node's own vocabulary legitimately starts blockers with codes like
// "client_validation_failed:". First-seen wording is still the one carried, never a re-worded merge.
export function collectSourcedBlockers(stageOutputs: Array<{ nodeId: string; output: unknown }>): SourcedBlocker[] {
  const nodeIds = new Set(stageOutputs.map(({ nodeId }) => nodeId.trim().toLowerCase()));
  const identity = (blocker: string): string => {
    let text = blocker;
    for (;;) {
      const match = /^([a-z0-9_.-]+):\s+/i.exec(text);
      if (!match || !nodeIds.has(match[1].toLowerCase())) return blockerKey(text);
      text = text.slice(match[0].length);
    }
  };
  const seen = new Set<string>();
  const collected: SourcedBlocker[] = [];
  for (const { nodeId, output } of stageOutputs) {
    if (!isObject(output)) continue;
    const blockers = Array.isArray(output.blockers) ? output.blockers : [];
    for (const entry of blockers) {
      if (!nonEmptyString(entry)) continue;
      const key = identity(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ nodeId, blocker: entry.trim() });
    }
  }
  return collected;
}

export type BlockerPartition = { blocking: SourcedBlocker[]; waived: WaivedBlocker[]; advisory: AdvisoryBlocker[] };

// W6.1 + W7 — the whole partition in one function, in a deliberate order:
//
//   1. THE WAIVER FIRST (W6.1). On own-property content the two exempt classes move to `waived`,
//      audited with the rule id. It runs first because it is the more specific rule and the one an
//      operator explicitly authorized: an EV-floor blocker on an own property should show up in the
//      audit trail as "waived under own_property_ev_and_aggression_exemption", naming the standing
//      ruling that excused it, not as a generic editorial advisory.
//   2. THEN THE CLASS (W7). Everything else is classified by the node that raised it
//      (blockerClassification.ts). INTEGRITY stays blocking. EDITORIAL becomes advisory — recorded,
//      never gating. Unrecognised sources are INTEGRITY, so a node nobody classified still blocks.
//
// `hardBlockerSources` is the project-level promotion list (publishingPolicy.hardBlockerSources) and
// is passed straight through to classifyBlockerSource, which consults it only for editorial sources —
// so a project can make this partition stricter and has no way to make it looser.
export function partitionBlockers(blockers: SourcedBlocker[], contentClass: string, hardBlockerSources: readonly string[] = []): BlockerPartition {
  const ownProperty = isOwnProperty(contentClass);
  const blocking: SourcedBlocker[] = [];
  const waived: WaivedBlocker[] = [];
  const advisory: AdvisoryBlocker[] = [];
  for (const entry of blockers) {
    if (ownProperty && isWaivableBlocker(entry.blocker)) {
      waived.push({ ...entry, rule: WAIVER_RULE_ID, reason: WAIVER_REASON });
      continue;
    }
    const classified = classifyBlockerSource(entry.nodeId, hardBlockerSources);
    if (classified.class === "editorial") advisory.push({ ...entry, class: classified.class, rationale: classified.why });
    else blocking.push(entry);
  }
  return { blocking, waived, advisory };
}

const describeBlocker = (entry: SourcedBlocker): string => `${entry.nodeId}: ${entry.blocker}`;

// ---------------------------------------------------------------------------------------------
// W1 + W7 — the mapping.
//
// decision:
//   readiness "no_go"                                    -> "no_go"   (the project's own checklist failed)
//   readiness "go" with unwaived INTEGRITY blockers       -> "blocked" (W6.1: a go with open blockers is
//                                                                      exactly the defect being fixed)
//   readiness "go", only EDITORIAL blockers               -> "go"      (W7: advisories never gate; they
//                                                                      are recorded in advisories[])
//   readiness "go", no unwaived blockers at all           -> "go"      (blockers: [] — schema-required)
// notes:     readiness.checklist[].detail, prefixed by the check that produced it, plus the class split
// blockers:  readiness.blockers + unwaived INTEGRITY upstream blockers (each named with its source node)
// advisories: unwaived EDITORIAL upstream blockers, with the rationale that demoted each one
export function buildPublicationDecision(params: {
  readiness: PublishReadinessResult;
  clientProjectId: string;
  contentClass: string;
  upstreamBlockers: SourcedBlocker[];
  // W7 — the project's promotion list (publishingPolicy.hardBlockerSources). Absent means the engine's
  // classification stands; it can only ever add hardness, never remove it.
  hardBlockerSources?: readonly string[];
  // W7 — appended verbatim to notes. The one caller that reads project policy uses this to record a
  // policy read it could not complete, so a decision never silently claims to have applied an override
  // it never saw.
  policyNotes?: readonly string[];
}): PublicationDecisionOutput {
  const { readiness, clientProjectId, contentClass } = params;
  const { blocking, waived, advisory } = partitionBlockers(params.upstreamBlockers, contentClass, params.hardBlockerSources ?? []);

  // The readiness checklist's own failures, named by check key exactly as the readiness hook names
  // them (they are keys, not prose — `Resolve: media_artifacts_verified` is how every readiness
  // surface already reports them). These are INTEGRITY by definition — the checklist asks whether the
  // artifact would render and validate, never whether it is good — so W7 never touches them.
  const readinessBlockers = readiness.blockers.map((key) => `publish_readiness: ${key}`);
  const upstreamBlockerLines = blocking.map(describeBlocker);
  const blockers = [...readinessBlockers, ...upstreamBlockerLines];

  const decision: PublicationDecision = readiness.status === "no_go" ? "no_go" : blockers.length ? "blocked" : "go";

  const notes = [
    `Decision computed deterministically by the conductor (publicationController.ts) from the project's own publish-readiness policy — the same function workflow.publish_readiness exposes, called engine-side. No model call.`,
    ...readiness.checklist.map((check) => `${check.key} [${check.status}]${check.detail ? `: ${check.detail}` : ""}`),
    `Content class: ${contentClass}${isOwnProperty(contentClass) ? " (own property — EV-floor and aggression-ceiling blockers are waived BY RULE and recorded in waivedBlockers, never dropped)" : " (the own-property EV-floor/aggression-ceiling waiver does not apply here; nothing is waived)"}.`,
    // W7: the class split, stated on every decision so an operator never has to guess whether a missing
    // blocker was demoted or dropped.
    `Blocker classes (blockerClassification.ts): ${blockers.length} hard (INTEGRITY — is the artifact real, valid, safe and renderable), ${advisory.length} advisory (EDITORIAL — is the piece any good). Editorial blockers are recorded, never gating; unrecognised sources are INTEGRITY (fail-closed)${(params.hardBlockerSources ?? []).length ? `; this project promotes ${[...(params.hardBlockerSources ?? [])].join(", ")} back to hard via publishingPolicy.hardBlockerSources` : ""}.`,
    ...(waived.length ? [`Waived under ${WAIVER_RULE_ID}: ${waived.map(describeBlocker).join(" | ")}`] : []),
    ...(advisory.length ? [`Advisory (editorial, non-gating — recorded in advisories[]): ${advisory.map(describeBlocker).join(" | ")}`] : []),
    ...(blocking.length ? [`Upstream INTEGRITY blockers carried into this decision: ${upstreamBlockerLines.join(" | ")}`] : ["No unwaived upstream integrity blockers were present on any completed stage output."]),
    ...(params.policyNotes ?? [])
  ];

  const nextAction = decision === "go"
    ? `publish_executor may proceed for ${clientProjectId} once the operator's durable publish decision (run.operatorPublishDecision, set via workflow.set_operator_publish_decision) reads "approved"; the engine gate re-checks both facts and performs no publish without them.${advisory.length ? ` ${advisory.length} editorial advisory blocker(s) were recorded in advisories[] and are deliberately not gating.` : ""}`
    : `Resolve before any publish: ${blockers.join(" | ") || readiness.requiredAction || "see blockers"}.`;

  const summary =
    `Deterministic publication decision for ${clientProjectId}: ${decision} ` +
    `(readiness ${readiness.status}, ${readiness.checklist.length} check(s), ${blockers.length} hard blocker(s), ${advisory.length} advisory blocker(s), ${waived.length} waived under standing rule, content class ${contentClass}). No model call.`;

  return {
    artifact: PUBLICATION_DECISION_ARTIFACT,
    summary,
    decision,
    state: decision === "go" ? "ready_for_publish_execution" : "blocked_for_publish_execution",
    blockers,
    waivedBlockers: waived,
    advisories: advisory,
    contentClass,
    checklist: readiness.checklist,
    nextAction,
    notes
  };
}

export type PublicationControllerSources = {
  projectId: string;
  clientProjectId: string;
  articleBody: unknown;
  // Every completed stage output in canonical node order, so blocker collection is ordered and the
  // source node of each blocker is knowable.
  stageOutputs: Array<{ nodeId: string; output: unknown }>;
  // Carriers for the explicit content-class field, most-authoritative first (executor passes the
  // run's initial input, then input_triage's output).
  contentClassCarriers: unknown[];
};

export type PublicationControllerDeps = {
  // W7 — how the project's publishingPolicy.hardBlockerSources promotion list is read. Defaulted to the
  // process registry rather than required from the caller, the same convention publisher.ts uses for
  // its own repositories (and the same one this module already relies on implicitly, since
  // evaluatePublishReadiness below is called with no deps at all). Injectable so tests exercise a
  // tenant override against a fake registry without touching the real one.
  projectRepository?: ProjectRepository;
};

// W7 — read the project's editorial->hard promotion list. Deliberately forgiving of an unreadable
// registry, and deliberately LOUD about it: the override can only ever ADD hardness, so failing to
// read it can never open a gate that was closed, but a decision that silently claims to have applied a
// tenant's policy when it never saw one is exactly the kind of quiet lie this module exists to avoid.
// The failure is therefore recorded in the decision's notes rather than swallowed or thrown (a throw
// would drop the whole run onto the ~$0.10 model path over a policy field almost nobody sets).
async function readHardBlockerSources(projectId: string, deps: PublicationControllerDeps): Promise<{ sources: string[]; notes: string[] }> {
  try {
    const config = await (deps.projectRepository ?? repositoryManager.getProjectRepository()).get(projectId);
    const declared = config?.publishingPolicy?.hardBlockerSources ?? [];
    return { sources: declared.filter(nonEmptyString).map((source) => source.trim()), notes: [] };
  } catch (error) {
    return {
      sources: [],
      notes: [`Project publishing policy could not be read for ${projectId} (${error instanceof Error ? error.message : String(error)}); the engine's default blocker classification was applied and any publishingPolicy.hardBlockerSources promotion this project declares was NOT applied. An override can only add hardness, so this never opened a gate.`]
    };
  }
}

// The one entry point executor.ts calls. Returns {ok:false} for every condition under which a
// deterministic decision would have to be invented, so the caller's single decision stays "use it, or
// fall through to the model path".
export async function runDeterministicPublicationController(sources: PublicationControllerSources, deps: PublicationControllerDeps = {}): Promise<PublicationControllerResult> {
  // The readiness function resolves the body from a runId when none is supplied; the conductor hands
  // it the in-memory article_body stage output instead, so the decision is computed from what THIS
  // dispatch is holding and no repository read can hand back a staler record.
  const evaluated = await evaluatePublishReadiness({
    projectId: sources.projectId,
    articleBody: sources.articleBody,
    // S3 item 7: the readiness content checks read brief_architect.mediaSlots and upstream blockers.
    stageOutputs: Object.fromEntries(sources.stageOutputs.map((entry) => [entry.nodeId, entry.output]))
  });
  if (!evaluated.available || !evaluated.readiness) {
    return {
      ok: false,
      code: "readiness_policy_unavailable",
      error: `project ${sources.projectId} declares no publish-readiness policy (evaluatePublishReadiness returned available:false); refusing to synthesize a publication decision from an absent checklist.`
    };
  }
  const contentClass = readContentClass(...sources.contentClassCarriers);
  const upstreamBlockers = collectSourcedBlockers(sources.stageOutputs);
  const policy = await readHardBlockerSources(sources.projectId, deps);
  return {
    ok: true,
    decision: buildPublicationDecision({
      readiness: evaluated.readiness,
      clientProjectId: sources.clientProjectId,
      contentClass,
      upstreamBlockers,
      hardBlockerSources: policy.sources,
      policyNotes: policy.notes
    })
  };
}
