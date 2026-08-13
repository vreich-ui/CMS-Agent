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
//   §2.2 isOperatorPublishWithheld / isOperatorPublishApproved — the ONE reader of the operator's
//        durable publish decision (run.operatorPublishDecision, set only by
//        workflow.set_operator_publish_decision). A withheld veto blocks publishRun and every
//        publish-risk node regardless of any other flag.
//
//   §2.3/§2.27 enforcePublishExecutionEvidence — an "executed" publish_execution.v1 claim must carry
//        go-live evidence (verification.deployStatus === "ready" AND
//        verification.productionConfirmed === true, plus a result) and an approvalMatched that
//        matches the operator's durable decision. The publish_executor output schema enforces the
//        same shape (if/then on status), but schemas are store-overlayable — this deterministic
//        check holds even when the schema does not, downgrading the claim to "blocked".

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

// §2.27 — the referent of publish_executor's `approvalMatched`: it matches (or fails to match) THIS
// durable operator record, nothing else.
export const isOperatorPublishApproved = (run: Pick<WorkflowExecutionRecord, "operatorPublishDecision">): boolean =>
  run.operatorPublishDecision === "approved";

// T2 (2026-08-13, run_1786557897658_elj34j) — §2.2's gates (above) deliberately do not change: PASS
// and FAIL are still exactly the two comparisons they always were. What changed is that
// operatorPublishDecision now has TWO possible sources — an explicit workflow.set_operator_publish_
// decision call, or a project's publishingPolicy.operatorDefault applied at run creation — and a
// receipt that says "approved" without naming which one authorized it can be misread as explicit
// operator sign-off when it was actually a standing project default. This is the ONE describer every
// publish receipt (publishExecution.ts, publisher.ts) calls so that misreading can't happen; it never
// participates in gate PASS/FAIL, only in the reason text attached to the result.
export const describeOperatorDecisionSource = (
  run: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "operatorDecisionSource">
): string | undefined => {
  if (!run.operatorPublishDecision) return undefined;
  // Absent source on a present decision predates this field — "explicit" was the only source that
  // ever existed before it, so that is the correct (not merely convenient) fallback reading.
  return run.operatorDecisionSource === "project_policy_default"
    ? `${run.operatorPublishDecision} (source: project_policy_default — the project's publishingPolicy.operatorDefault, not an explicit operator action)`
    : `${run.operatorPublishDecision} (source: explicit — set via workflow.set_operator_publish_decision)`;
};

export type PublishExecutionEvidenceResult = { output: unknown; downgraded: boolean; reasons: string[] };

// §2.3/§2.27 — deterministic post-check of a publish_execution.v1 output. Anything other than an
// "executed" claim passes through untouched (blocked/skipped need no evidence, and a non-object is
// left for schema validation to reject). An "executed" claim without full evidence is DOWNGRADED to
// status "blocked" with the missing evidence appended to blockers — fail closed, never trust the
// claim — so it can never masquerade as a confirmed go-live in the run record or downstream nodes.
export function enforcePublishExecutionEvidence(output: unknown, run: Pick<WorkflowExecutionRecord, "operatorPublishDecision">): PublishExecutionEvidenceResult {
  if (!isPlainObject(output) || output.status !== "executed") return { output, downgraded: false, reasons: [] };
  const reasons: string[] = [];
  const verification = isPlainObject(output.verification) ? output.verification : undefined;
  if (!verification || verification.deployStatus !== "ready" || verification.productionConfirmed !== true) {
    reasons.push("executed_without_go_live_evidence: status \"executed\" requires verification.deployStatus === \"ready\" AND verification.productionConfirmed === true — a queued or ready-but-undeployed build is not live.");
  }
  if (!isPlainObject(output.result)) {
    reasons.push("executed_without_result: status \"executed\" requires a `result` object recording the publish outcome.");
  }
  if (output.approvalMatched !== true) {
    reasons.push("executed_without_approval_matched: status \"executed\" requires approvalMatched === true.");
  } else if (!isOperatorPublishApproved(run)) {
    reasons.push(`approval_matched_without_operator_record: approvalMatched claims the operator's durable publish decision (run.${OPERATOR_PUBLISH_DECISION_FIELD}, set via workflow.set_operator_publish_decision) is "approved", but it is ${JSON.stringify(run.operatorPublishDecision ?? null)}.`);
  }
  if (reasons.length === 0) return { output, downgraded: false, reasons };
  const blockers = Array.isArray(output.blockers) ? output.blockers : [];
  return { output: { ...output, status: "blocked", blockers: [...blockers, ...reasons] }, downgraded: true, reasons };
}
