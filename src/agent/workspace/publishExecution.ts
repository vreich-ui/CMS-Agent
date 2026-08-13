// W2a (determinism program, 2026-08-12; docs/plan/WORK-ORDER-2026-08-12-determinism.md) — the
// deterministic FAIL-CLOSED half of publish_executor.
//
// WHAT THE GATE IS. Two comparisons the engine already owns (publishDecision.ts), and nothing else:
//   1. the run's publication_controller record is an EXPLICIT decision:"go" — readPublicationDecision,
//      refuse-by-default: silence, prose approval, hedging, a wrong artifact label, a dry-run
//      placeholder, or a "go" carrying open blockers all refuse;
//   2. the operator's durable publish decision is EXACTLY "approved" — isOperatorPublishApproved over
//      run.operatorPublishDecision, the one named field with one setter and one reader.
// Neither is a judgment call, and neither has ever needed prose reasoning to evaluate. This node is
// the ONE node that can mutate a live site, so its refusal path is the last place a model turn
// belongs: on run_1786468126136_ev9goe the model spent a turn re-reading the two facts through stage
// tools and correctly blocked on "operatorPublishDecision absent (expected approved)" with zero side
// effects. This module reproduces that outcome bit-for-bit, for $0, with zero client calls.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not publish. When the gate PASSES, this module returns
// {ok:false, code:"gate_passed_execution_not_deterministic"} and the executor falls through to the
// model path unchanged. That is a deliberate scope decision, not an oversight:
//   - the engine's existing publish path (publisher.ts publishRun) requires an operator-supplied
//     requestId (req_<flow>_<topic>_<yyyymmdd>_<nn>), refuses bodies carrying media, and — by board
//     decision B2 — NEVER releases: "releasing to production is a SEPARATE gate whose verb must
//     appear nowhere in this file";
//   - but publish_executor's own schema (and enforcePublishExecutionEvidence) only admits
//     status:"executed" with verification.deployStatus === "ready" AND productionConfirmed === true —
//     evidence that can only come from the release-and-verify sequence publishRun structurally does
//     not perform.
// So an engine-side "executed" built on publishRun could never satisfy the evidence rule and would be
// downgraded to "blocked" by the very check that exists to catch an unevidenced claim. Landing the
// approved path deterministically therefore means building a release+verification tail inside the
// conductor — a large, live-site-mutating change that does not belong in the same commit as a
// refusal path. The fail-closed half lands here; the approved path stays on the model until that tail
// is built and reviewed on its own.
//
// SAFETY. Same contract as every other deterministic path: the caller validates this output against
// the node's OWN outputSchema and falls through to the model dispatch on any failure. And it is
// evaluated AFTER the executor's publish-refusal block, never before — a deterministic path must
// never be the thing that skips a gate.

import { describeOperatorDecisionSource, findPublicationDecision, isOperatorPublishApproved, readPublicationDecision, OPERATOR_PUBLISH_DECISION_FIELD } from "./publishDecision.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";

export const PUBLISH_EXECUTION_ARTIFACT = "publish_execution.v1";

export type PublishExecutionGate = {
  passed: boolean;
  controllerGo: boolean;
  operatorApproved: boolean;
  // One reason per closed gate, in gate order. Empty when the gate passed.
  reasons: string[];
  // T2 (run_1786557897658_elj34j) — WHICH source produced operatorApproved's underlying decision
  // ("explicit" | "project_policy_default"), so a receipt reader can never mistake a project default
  // for an operator's own act. Undefined when no decision is recorded at all. Purely descriptive:
  // never read by gate PASS/FAIL logic above.
  operatorDecisionSource?: string;
};

export type BlockedPublishExecution = {
  artifact: typeof PUBLISH_EXECUTION_ARTIFACT;
  summary: string;
  status: "blocked";
  clientProjectId: string;
  clientObjectType: string;
  contractSource: Record<string, unknown>;
  approvalMatched: false;
  publishPolicyChecked: true;
  blockers: string[];
  notes: string[];
};

export type PublishExecutionResult =
  | { ok: true; output: BlockedPublishExecution }
  | { ok: false; code: string; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// THE gate. Both comparisons are exact-match reads of existing engine facts — no parsing of prose, no
// inference, no defaulting. Fail-closed: anything that is not an explicit affirmative is a refusal
// with the reason recorded.
export function evaluatePublishExecutionGate(run: Pick<WorkflowExecutionRecord, "stageOutputs" | "nodes" | "operatorPublishDecision" | "operatorDecisionSource">): PublishExecutionGate {
  const decision = readPublicationDecision(findPublicationDecision(run));
  const operatorApproved = isOperatorPublishApproved(run);
  const reasons: string[] = [
    ...(decision.authorized ? [] : [`publication_decision_not_affirmative (${decision.code}): ${decision.reason}`]),
    ...(operatorApproved ? [] : [`operator_approval_absent: the operator's durable publish decision for this run (run.${OPERATOR_PUBLISH_DECISION_FIELD}, set via workflow.set_operator_publish_decision) is ${JSON.stringify(run.operatorPublishDecision ?? null)}, not "approved"; nothing publishes until it is.`])
  ];
  return { passed: decision.authorized && operatorApproved, controllerGo: decision.authorized, operatorApproved, reasons, operatorDecisionSource: describeOperatorDecisionSource(run) };
}

// The envelope facts a publish_execution.v1 record must carry. Taken verbatim from upstream (the
// publish candidate, then the controller's decision record, then article_body) — never invented: a
// publish record naming a client object type nobody upstream declared is worse than no record.
export type PublishExecutionEnvelope = { clientObjectType: string; contractSource: Record<string, unknown> };

export function readPublishExecutionEnvelope(...carriers: unknown[]): PublishExecutionEnvelope | undefined {
  let clientObjectType: string | undefined;
  let contractSource: Record<string, unknown> | undefined;
  for (const carrier of carriers) {
    if (!isObject(carrier)) continue;
    if (clientObjectType === undefined && nonEmptyString(carrier.clientObjectType)) clientObjectType = carrier.clientObjectType.trim();
    if (contractSource === undefined && isObject(carrier.contractSource)) contractSource = carrier.contractSource;
  }
  return clientObjectType && contractSource ? { clientObjectType, contractSource } : undefined;
}

export type BlockedPublishExecutionSources = {
  clientProjectId: string;
  envelope: PublishExecutionEnvelope;
  gate: PublishExecutionGate;
};

// The fail-closed record. Deliberately shaped like the one the model produced on the live run:
// status "blocked", approvalMatched false, publishPolicyChecked true, one blocker per closed gate.
export function buildBlockedPublishExecution(sources: BlockedPublishExecutionSources): BlockedPublishExecution {
  const { gate } = sources;
  return {
    artifact: PUBLISH_EXECUTION_ARTIFACT,
    summary:
      `Publish refused fail-closed by the engine gate for ${sources.clientProjectId}/${sources.envelope.clientObjectType}: ` +
      `controller decision ${gate.controllerGo ? "go" : "not \"go\""}, operator publish decision ${gate.operatorApproved ? "approved" : "not \"approved\""}` +
      // T2 — an "approved" decision names its source here, so this summary can never be misread as
      // an explicit operator sign-off when it was actually a project's publishingPolicy default.
      `${gate.operatorApproved && gate.operatorDecisionSource ? ` (${gate.operatorDecisionSource})` : ""}. ` +
      `No client tool was called, no object was created, patched, published or released. No model call.`,
    status: "blocked",
    clientProjectId: sources.clientProjectId,
    clientObjectType: sources.envelope.clientObjectType,
    contractSource: sources.envelope.contractSource,
    approvalMatched: false,
    publishPolicyChecked: true,
    blockers: gate.reasons,
    notes: [
      "Evaluated deterministically by the conductor (publishExecution.ts): the publish gate is two exact comparisons over existing run facts — an explicit publication_controller decision:\"go\" and run.operatorPublishDecision === \"approved\" — and both are read through the single shared reader (publishDecision.ts) that publishRun's own gates use, so the node and the publisher cannot drift apart.",
      "Zero side effects: this path performs no client call whatsoever, so a refusal cannot half-publish.",
      "To proceed: record the operator decision with workflow.set_operator_publish_decision (approved) and/or resolve the blockers the publication_controller decision names, then retry this node."
    ]
  };
}

// The one entry point executor.ts calls. Returns {ok:true} ONLY for the refusal path; a passing gate
// and a missing envelope both return {ok:false} so the caller's single decision stays "use it, or fall
// through to the model path".
export function runDeterministicPublishExecutor(params: {
  run: Pick<WorkflowExecutionRecord, "stageOutputs" | "nodes" | "operatorPublishDecision" | "operatorDecisionSource">;
  clientProjectId: string;
  envelopeCarriers: unknown[];
}): PublishExecutionResult {
  const gate = evaluatePublishExecutionGate(params.run);
  if (gate.passed) {
    return {
      ok: false,
      code: "gate_passed_execution_not_deterministic",
      error: "the publish gate passed (controller \"go\" + operator \"approved\"); engine-side publish EXECUTION (create/validate/patch/publish + release + go-live verification) is not implemented deterministically, so the approved path stays on the model path by design."
    };
  }
  const envelope = readPublishExecutionEnvelope(...params.envelopeCarriers);
  if (!envelope) {
    return {
      ok: false,
      code: "publish_envelope_absent",
      error: "no upstream output carries both a clientObjectType and a contractSource object; a publish_execution.v1 record cannot be assembled without inventing the envelope facts it must name."
    };
  }
  return { ok: true, output: buildBlockedPublishExecution({ clientProjectId: params.clientProjectId, envelope, gate }) };
}
