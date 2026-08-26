// P0 (2026-08-10) — deterministic publish-authorization reading. Three related fail-closed checks,
// kept in ONE module so the publisher (publishRun) and the executor (publish-risk node dispatch)
// cannot drift apart:
//
//   §2.1 readPublicationDecision — refuse-by-default parsing of the publication_controller decision
//        record. The old posture was prompt-side ("execute unless the decision record explicitly
//        withholds"), which made silence, hedging, or a malformed record resolve to PUBLISH. This is
//        the inversion, in code: publish is authorized ONLY by an explicit, structurally-present
//        affirmative decision, and every other shape refuses with a recorded reason.
//
//   §2.2 isOperatorPublishWithheld — the ONE reader of the operator's durable VETO
//        (run.operatorPublishDecision === "withheld", set only by workflow.set_operator_publish_
//        decision). A withheld veto blocks publishRun and every publish-risk node regardless of any
//        other flag, in every mode, at every layer (ADR-2026-08-25-publish-autonomy invariant 2).
//
//   §2.3/§2.4 (T15.5, 2026-08-25, ADR-2026-08-25-publish-autonomy) resolvePublishAuthority — the ONE
//        authority reader, replacing the old isOperatorPublishApproved. Implements the six-row
//        precedence table (ADR §2.4): an explicit operator "withheld" or "approved" always wins;
//        absent a decision, a project's snapshotted autonomyMode ("autonomous" | "operator-gated")
//        decides. Resolved AT GATE-EVALUATION TIME from the run's own facts — never written back into
//        run.operatorPublishDecision, which holds only what an operator actually said (invariant 4).
//
//   §2.3/§2.27 enforcePublishExecutionEvidence — an "executed" publish_execution.v1 claim must carry
//        go-live evidence (verification.deployStatus === "ready" AND
//        verification.productionConfirmed === true, plus a result) and an approvalMatched that
//        matches the run's resolved publish authority. The publish_executor output schema enforces
//        the same shape (if/then on status), but schemas are store-overlayable — this deterministic
//        check holds even when the schema does not, downgrading the claim to "blocked". It also
//        refuses a FORGED authority claim (§8): a receipt may never assert an explicit operator
//        decision that run.operatorPublishDecision does not actually hold.

import type { WorkflowExecutionRecord } from "./executionTypes.js";

export const PUBLICATION_CONTROLLER_NODE_ID = "publication_controller";
export const PUBLICATION_DECISION_ARTIFACT = "publication_decision.v1";

// §2.2 — the ONE named field. Referenced by name in the publish_executor schema (approvalMatched's
// description) and in the setter/reader docs; grep for it before renaming anything.
export const OPERATOR_PUBLISH_DECISION_FIELD = "operatorPublishDecision" as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Locate the run's publication_controller decision record: the stage output is authoritative (it is
// what downstream nodes consume), with the node's own recorded output as the fallback for a record
// persisted before stage mirroring. Absent everywhere means the controller has not spoken — which
// refuses, never defaults to publish.
export const findPublicationDecision = (run: Pick<WorkflowExecutionRecord, "stageOutputs" | "nodes">): unknown =>
  run.stageOutputs?.[PUBLICATION_CONTROLLER_NODE_ID] ?? run.nodes.find((node) => node.nodeId === PUBLICATION_CONTROLLER_NODE_ID)?.output;

export type PublicationDecisionRead =
  | { authorized: true; decision: "go" }
  | { authorized: false; code: string; reason: string };

const refuse = (code: string, reason: string): PublicationDecisionRead => ({ authorized: false, code, reason });

// The affirmative shape, and the ONLY shape that authorizes a publish:
//   { artifact: "publication_decision.v1", decision: "go", blockers: [] (or absent) }
// Everything is read defensively — the controller's output schema gains decision/blockers/nextAction
// via MCP in parallel with this code, so no field is assumed to exist. Absent decision, an
// unrecognized value, a non-empty (or malformed) blockers list, a wrong artifact label, or a dry-run
// placeholder all refuse with a named reason. In particular the acceptance fixture
// {"artifact":"publication_decision.v1","summary":"Looks fine."} refuses: prose approval is not a
// decision.
export function readPublicationDecision(record: unknown): PublicationDecisionRead {
  let value = record;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return refuse("controller_decision_unparseable", "publication_controller output is a string that is not valid JSON; refusing to treat it as an authorization."); }
  }
  if (value === undefined || value === null) return refuse("controller_decision_missing", "no publication_controller decision record exists for this run; publish is refused until the controller explicitly decides \"go\".");
  if (!isPlainObject(value)) return refuse("controller_decision_unparseable", "publication_controller output is not an object; refusing to treat it as an authorization.");
  if (value.dryRun === true) return refuse("controller_decision_placeholder", "the publication_controller record is a dry-run/mock placeholder (dryRun: true), which can never authorize a publish.");
  if (value.artifact !== PUBLICATION_DECISION_ARTIFACT) return refuse("controller_decision_wrong_artifact", `the record's artifact is ${JSON.stringify(value.artifact)} instead of "${PUBLICATION_DECISION_ARTIFACT}"; refusing to treat it as a publication decision.`);
  const decision = typeof value.decision === "string" ? value.decision.trim().toLowerCase() : undefined;
  if (decision === undefined) return refuse("controller_decision_absent", "the decision record carries no `decision` field; an explicit decision: \"go\" is required — silence or prose approval refuses by default.");
  if (decision !== "go") return refuse("controller_decision_not_go", `the controller decided ${JSON.stringify(value.decision)}, not "go"; only an explicit "go" authorizes a publish.`);
  if ("blockers" in value) {
    if (!Array.isArray(value.blockers)) return refuse("controller_decision_blockers_malformed", "the decision record's `blockers` is not an array; refusing an ambiguous authorization.");
    if (value.blockers.length > 0) return refuse("controller_decision_blockers_present", `the controller decided "go" but still lists ${value.blockers.length} blocker(s); a go with open blockers is ambiguous and refuses.`);
  }
  return { authorized: true, decision: "go" };
}

// §2.2 — the ONE reader of the operator veto. "withheld" blocks publishRun's operator_not_withheld
// gate and the executor's publish-risk dispatch regardless of approved/live flags.
export const isOperatorPublishWithheld = (run: Pick<WorkflowExecutionRecord, "operatorPublishDecision">): boolean =>
  run.operatorPublishDecision === "withheld";

// T15.5 (2026-08-25, ADR-2026-08-25-publish-autonomy §2.3/§2.4) — THE authority resolver. Replaces
// isOperatorPublishApproved as the referent of publish_executor's `approvalMatched` and of every other
// "may this run publish" question. Six-row precedence, evaluated top to bottom, first match wins:
//
//   1. operatorPublishDecision === "withheld"                        -> HALT  operator_withheld
//   (rows 2-3, the project kill-switch / publishEnabled, are NOT this function's job — they are
//    re-evaluated LIVE elsewhere, e.g. publisher.ts isProjectPublishEnabled, per §2.5: a kill-switch a
//    snapshot could stale is not a kill-switch.)
//   4. operatorPublishDecision === "approved"                        -> PROCEED operator_explicit
//   5. decision absent AND snapshot.autonomyMode === "autonomous"    -> PROCEED policy_autonomous
//   6. decision absent AND autonomyMode is "operator-gated"/unset    -> HALT  operator_approval_absent
//
// Reads ONLY the run's own operator record and its publishingPolicySnapshot (captured once, at run
// creation) — never a live project read — so two runs of the same URL resolve identically regardless
// of a policy edit made between them (invariant 7). An explicit "withheld" is absolute: it halts in
// every mode, at every layer, and is never overridden, defaulted away, or expired (invariant 2).
export type PublishAuthority =
  | { authorized: true; source: "operator_explicit" | "policy_autonomous" }
  | { authorized: false; code: string; reason: string };

export function resolvePublishAuthority(
  run: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "publishingPolicySnapshot">
): PublishAuthority {
  // Row 1 — absolute, ahead of everything, including an "autonomous" project.
  if (run.operatorPublishDecision === "withheld") {
    return {
      authorized: false,
      code: "operator_withheld",
      reason: `the operator's durable publish decision for this run (run.${OPERATOR_PUBLISH_DECISION_FIELD}, set via workflow.set_operator_publish_decision) is "withheld"; nothing publishes until the operator replaces it.`
    };
  }
  // Row 4 — an operator's own explicit approval is sufficient authority in every mode.
  if (run.operatorPublishDecision === "approved") {
    return { authorized: true, source: "operator_explicit" };
  }
  // Rows 5/6 — no operator decision recorded. Authority now depends entirely on the run's snapshotted
  // autonomyMode; absent snapshot/mode resolves "operator-gated" (today's behavior, unchanged).
  const autonomyMode = run.publishingPolicySnapshot?.autonomyMode ?? "operator-gated";
  if (autonomyMode === "autonomous") {
    return { authorized: true, source: "policy_autonomous" };
  }
  return {
    authorized: false,
    code: "operator_approval_absent",
    reason: `the operator's durable publish decision for this run (run.${OPERATOR_PUBLISH_DECISION_FIELD}, set via workflow.set_operator_publish_decision) is ${JSON.stringify(run.operatorPublishDecision ?? null)}, not "approved", and this run's publishing policy snapshot is not autonomous; nothing publishes until the operator approves, withholds is replaced, or the project's autonomyMode is "autonomous".`
  };
}

// T2 (2026-08-13, run_1786557897658_elj34j) — §2.2's gates deliberately do not change: PASS and FAIL
// are still exactly the comparisons they always were. What changed is that operatorPublishDecision can
// have more than one SOURCE, and a receipt that says "approved" without naming which one authorized it
// can be misread as explicit operator sign-off when it was actually a standing default. This is the
// ONE describer every publish receipt (publishExecution.ts, publisher.ts) calls so that misreading
// can't happen; it never participates in gate PASS/FAIL, only in the reason text attached to a result.
// T15.5 — describes only a PRESENT run.operatorPublishDecision (unchanged), so it is silent under
// policy_autonomous authorization (invariant 4 keeps operatorPublishDecision itself absent then); that
// case is instead described by resolvePublishAuthority's own `source` and the publishAuthority receipt
// field (publishExecution.ts).
export const describeOperatorDecisionSource = (
  run: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "operatorDecisionSource">
): string | undefined => {
  if (!run.operatorPublishDecision) return undefined;
  if (run.operatorDecisionSource === "project_policy_default") {
    return `${run.operatorPublishDecision} (source: project_policy_default — a legacy pre-T15.5 project default, not an explicit operator action)`;
  }
  if (run.operatorDecisionSource === "policy_autonomous") {
    return `${run.operatorPublishDecision} (source: policy_autonomous, not an explicit operator action)`;
  }
  // Absent source on a present decision predates this field — "explicit" was the only source that
  // ever existed before it, so that is the correct (not merely convenient) fallback reading.
  return `${run.operatorPublishDecision} (source: explicit — set via workflow.set_operator_publish_decision)`;
};

export type PublishExecutionEvidenceResult = { output: unknown; downgraded: boolean; reasons: string[] };

// §2.3/§2.27, redefined by T15.5 (ADR §8) — deterministic post-check of a publish_execution.v1
// output. Anything other than an "executed" claim passes through untouched (blocked/skipped need no
// evidence, and a non-object is left for schema validation to reject). An "executed" claim without
// full evidence is DOWNGRADED to status "blocked" with the missing evidence appended to blockers —
// fail closed, never trust the claim — so it can never masquerade as a confirmed go-live in the run
// record or downstream nodes.
//
// approvalMatched's meaning is redefined, fail-closed character preserved: it used to mean "the
// operator's durable decision is approved" — a claim that is simply false under autonomy, which would
// force every autonomous publish to be downgraded. It now means "the authority this receipt claims
// matches the authority the run actually holds" — checked against resolvePublishAuthority, the SAME
// resolver the gate itself used. One new clause: a receipt's OWN `publishAuthority.source` claiming
// "operator_explicit" while run.operatorPublishDecision is not "approved" is a FORGED claim and
// downgrades regardless of anything else — no receipt may ever assert a human decided when no human
// did (invariant 6).
export function enforcePublishExecutionEvidence(
  output: unknown,
  run: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "publishingPolicySnapshot">
): PublishExecutionEvidenceResult {
  if (!isPlainObject(output) || output.status !== "executed") return { output, downgraded: false, reasons: [] };
  const reasons: string[] = [];
  const verification = isPlainObject(output.verification) ? output.verification : undefined;
  if (!verification || verification.deployStatus !== "ready" || verification.productionConfirmed !== true) {
    reasons.push("executed_without_go_live_evidence: status \"executed\" requires verification.deployStatus === \"ready\" AND verification.productionConfirmed === true — a queued or ready-but-undeployed build is not live.");
  }
  if (!isPlainObject(output.result)) {
    reasons.push("executed_without_result: status \"executed\" requires a `result` object recording the publish outcome.");
  }
  const authority = resolvePublishAuthority(run);
  if (output.approvalMatched !== true) {
    reasons.push("executed_without_approval_matched: status \"executed\" requires approvalMatched === true.");
  } else if (!authority.authorized) {
    reasons.push(`approval_matched_without_authority: approvalMatched claims this run's publish is authorized, but resolvePublishAuthority disagrees (${authority.code}: run.${OPERATOR_PUBLISH_DECISION_FIELD} is ${JSON.stringify(run.operatorPublishDecision ?? null)}, publishingPolicySnapshot.autonomyMode is ${JSON.stringify(run.publishingPolicySnapshot?.autonomyMode ?? null)}).`);
  }
  // §8 — the forged-receipt clause. Checked independently of `authority` above: a claim can be
  // internally "authorized" (e.g. the run really is autonomous) while still LYING about which source
  // authorized it, and that lie is exactly what this clause exists to catch.
  const claimedAuthority = isPlainObject(output.publishAuthority) ? output.publishAuthority : undefined;
  if (claimedAuthority?.source === "operator_explicit" && run.operatorPublishDecision !== "approved") {
    reasons.push(`forged_publish_authority_claim: publishAuthority.source claims "operator_explicit" but run.${OPERATOR_PUBLISH_DECISION_FIELD} is ${JSON.stringify(run.operatorPublishDecision ?? null)}, not "approved" — no receipt may assert a human decision that did not occur.`);
  }
  if (reasons.length === 0) return { output, downgraded: false, reasons };
  const blockers = Array.isArray(output.blockers) ? output.blockers : [];
  return { output: { ...output, status: "blocked", blockers: [...blockers, ...reasons] }, downgraded: true, reasons };
}
