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
// SAFETY. This is a fast path, not the only path: the caller (executor.ts) validates the built record
// against the node's OWN outputSchema and falls through to the model dispatch on any failure, exactly
// as the contract_intelligence / publish_payload deterministic paths do. It also refuses to decide at
// all when the project has no readiness policy (`available: false`) — an invented decision from a
// missing checklist is precisely the failure mode this module exists to remove.

import { evaluatePublishReadiness } from "./publisher.js";
import type { PublishReadinessResult } from "../projects/projectHooks.js";

export const PUBLICATION_DECISION_ARTIFACT = "publication_decision.v1";

// The three decisions the node's (store-side) outputSchema admits. "go" additionally requires an EMPTY
// blockers array — the schema enforces it with an if/then, publishDecision.readPublicationDecision
// enforces it again at the publish gate, and this module never emits a "go" carrying a blocker.
export type PublicationDecision = "go" | "no_go" | "blocked";

// An upstream blocker with the node that raised it, so a waiver (or a hard block) can always name its
// source. Order is the conductor's node order, not object-key order — determinism includes ordering.
export type SourcedBlocker = { nodeId: string; blocker: string };

export type WaivedBlocker = SourcedBlocker & { rule: string; reason: string };

export type PublicationDecisionOutput = {
  artifact: typeof PUBLICATION_DECISION_ARTIFACT;
  summary: string;
  decision: PublicationDecision;
  state: "ready_for_publish_execution" | "blocked_for_publish_execution";
  blockers: string[];
  waivedBlockers: WaivedBlocker[];
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
export function readContentClass(...carriers: unknown[]): string {
  for (const carrier of carriers) {
    for (const value of [carrier, isObject(carrier) ? carrier.contentSource : undefined]) {
      const declared = readContentClassFrom(value);
      if (declared !== undefined) return OWN_PROPERTY_VALUES.has(declared) ? OWN_PROPERTY_CONTENT_CLASS : declared;
    }
  }
  return DEFAULT_CONTENT_CLASS;
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
export function collectSourcedBlockers(stageOutputs: Array<{ nodeId: string; output: unknown }>): SourcedBlocker[] {
  const seen = new Set<string>();
  const collected: SourcedBlocker[] = [];
  for (const { nodeId, output } of stageOutputs) {
    if (!isObject(output)) continue;
    const blockers = Array.isArray(output.blockers) ? output.blockers : [];
    for (const entry of blockers) {
      if (!nonEmptyString(entry)) continue;
      const key = blockerKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ nodeId, blocker: entry.trim() });
    }
  }
  return collected;
}

export type BlockerPartition = { blocking: SourcedBlocker[]; waived: WaivedBlocker[] };

// W6.1's whole rule in one function: on own-property content the two exempt classes move to
// `waived` (audited, with the rule id); everything else stays blocking. Off own-property content
// nothing is waived at all.
export function partitionBlockers(blockers: SourcedBlocker[], contentClass: string): BlockerPartition {
  if (!isOwnProperty(contentClass)) return { blocking: [...blockers], waived: [] };
  const blocking: SourcedBlocker[] = [];
  const waived: WaivedBlocker[] = [];
  for (const entry of blockers) {
    if (isWaivableBlocker(entry.blocker)) waived.push({ ...entry, rule: WAIVER_RULE_ID, reason: WAIVER_REASON });
    else blocking.push(entry);
  }
  return { blocking, waived };
}

const describeBlocker = (entry: SourcedBlocker): string => `${entry.nodeId}: ${entry.blocker}`;

// ---------------------------------------------------------------------------------------------
// W1 — the mapping.
//
// decision:
//   readiness "no_go"                                   -> "no_go"   (the project's own checklist failed)
//   readiness "go" with unwaived upstream blockers       -> "blocked" (W6.1: a go with open blockers is
//                                                                     exactly the defect being fixed)
//   readiness "go", no unwaived blockers                 -> "go"      (blockers: [] — schema-required)
// notes:     readiness.checklist[].detail, prefixed by the check that produced it
// blockers:  readiness.blockers + unwaived upstream blockers (each named with its source node)
export function buildPublicationDecision(params: {
  readiness: PublishReadinessResult;
  clientProjectId: string;
  contentClass: string;
  upstreamBlockers: SourcedBlocker[];
}): PublicationDecisionOutput {
  const { readiness, clientProjectId, contentClass } = params;
  const { blocking, waived } = partitionBlockers(params.upstreamBlockers, contentClass);

  // The readiness checklist's own failures, named by check key exactly as the readiness hook names
  // them (they are keys, not prose — `Resolve: media_artifacts_verified` is how every readiness
  // surface already reports them).
  const readinessBlockers = readiness.blockers.map((key) => `publish_readiness: ${key}`);
  const upstreamBlockerLines = blocking.map(describeBlocker);
  const blockers = [...readinessBlockers, ...upstreamBlockerLines];

  const decision: PublicationDecision = readiness.status === "no_go" ? "no_go" : blockers.length ? "blocked" : "go";

  const notes = [
    `Decision computed deterministically by the conductor (publicationController.ts) from the project's own publish-readiness policy — the same function workflow.publish_readiness exposes, called engine-side. No model call.`,
    ...readiness.checklist.map((check) => `${check.key} [${check.status}]${check.detail ? `: ${check.detail}` : ""}`),
    `Content class: ${contentClass}${isOwnProperty(contentClass) ? " (own property — EV-floor and aggression-ceiling blockers are waived BY RULE and recorded in waivedBlockers, never dropped)" : " (no blocker class is exempt; every upstream blocker hard-blocks)"}.`,
    ...(waived.length ? [`Waived under ${WAIVER_RULE_ID}: ${waived.map(describeBlocker).join(" | ")}`] : []),
    ...(blocking.length ? [`Upstream blockers carried into this decision: ${upstreamBlockerLines.join(" | ")}`] : ["No unwaived upstream blockers were present on any completed stage output."])
  ];

  const nextAction = decision === "go"
    ? `publish_executor may proceed for ${clientProjectId} once the operator's durable publish decision (run.operatorPublishDecision, set via workflow.set_operator_publish_decision) reads "approved"; the engine gate re-checks both facts and performs no publish without them.`
    : `Resolve before any publish: ${blockers.join(" | ") || readiness.requiredAction || "see blockers"}.`;

  const summary =
    `Deterministic publication decision for ${clientProjectId}: ${decision} ` +
    `(readiness ${readiness.status}, ${readiness.checklist.length} check(s), ${blockers.length} blocker(s), ${waived.length} waived under standing rule, content class ${contentClass}). No model call.`;

  return {
    artifact: PUBLICATION_DECISION_ARTIFACT,
    summary,
    decision,
    state: decision === "go" ? "ready_for_publish_execution" : "blocked_for_publish_execution",
    blockers,
    waivedBlockers: waived,
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

// The one entry point executor.ts calls. Returns {ok:false} for every condition under which a
// deterministic decision would have to be invented, so the caller's single decision stays "use it, or
// fall through to the model path".
export async function runDeterministicPublicationController(sources: PublicationControllerSources): Promise<PublicationControllerResult> {
  // The readiness function resolves the body from a runId when none is supplied; the conductor hands
  // it the in-memory article_body stage output instead, so the decision is computed from what THIS
  // dispatch is holding and no repository read can hand back a staler record.
  const evaluated = await evaluatePublishReadiness({ projectId: sources.projectId, articleBody: sources.articleBody });
  if (!evaluated.available || !evaluated.readiness) {
    return {
      ok: false,
      code: "readiness_policy_unavailable",
      error: `project ${sources.projectId} declares no publish-readiness policy (evaluatePublishReadiness returned available:false); refusing to synthesize a publication decision from an absent checklist.`
    };
  }
  const contentClass = readContentClass(...sources.contentClassCarriers);
  const upstreamBlockers = collectSourcedBlockers(sources.stageOutputs);
  return { ok: true, decision: buildPublicationDecision({ readiness: evaluated.readiness, clientProjectId: sources.clientProjectId, contentClass, upstreamBlockers }) };
}
