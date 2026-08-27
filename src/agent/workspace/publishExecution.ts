// W2a (determinism program, 2026-08-12; docs/plan/WORK-ORDER-2026-08-12-determinism.md) — the
// deterministic FAIL-CLOSED half of publish_executor.
//
// WHAT THE GATE IS. Two comparisons the engine already owns (publishDecision.ts), and nothing else:
//   1. the run's publication_controller record is an EXPLICIT decision:"go" — readPublicationDecision,
//      refuse-by-default: silence, prose approval, hedging, a wrong artifact label, a dry-run
//      placeholder, or a "go" carrying open blockers all refuse;
//   2. the run's publish authority is AUTHORIZED — resolvePublishAuthority over run.
//      operatorPublishDecision and run.publishingPolicySnapshot, the one authority reader (T15.5,
//      ADR-2026-08-25-publish-autonomy §2.4): an operator's own explicit "approved" is always
//      sufficient, and — new in T15.5 — an absent decision is ALSO sufficient when the project's
//      autonomyMode policy (snapshotted onto the run at creation) is "autonomous". An explicit
//      "withheld" still always refuses, in every mode.
// Neither is a judgment call, and neither has ever needed prose reasoning to evaluate. This node is
// the ONE node that can mutate a live site, so its refusal path is the last place a model turn
// belongs: on run_1786468126136_ev9goe the model spent a turn re-reading the two facts through stage
// tools and correctly blocked on "operatorPublishDecision absent (expected approved)" with zero side
// effects. This module reproduces that outcome bit-for-bit, for $0, with zero client calls.
//
// TWO HALVES, TWO OPT-INS (T4, Wave 2a, 2026-08-13). The fail-closed half below is unchanged. The
// approved half — the ENGINE performing the publish rather than a model — is at the bottom of this
// file (runEnginePublishExecution) and is a SEPARATE opt-in on the same flag
// (metadata.publishExecutorDeterministic === "execute"; see readPublishExecutorDeterministicMode).
// runDeterministicPublishExecutor, the gate-only entry point, still returns
// {ok:false, code:"gate_passed_execution_not_deterministic"} on a passing gate so a node that opted
// into the GATE only keeps falling through to the model path exactly as before. The reasoning
// recorded when that was the only behaviour is kept verbatim below, because half of it still holds —
// the engine path publishes, but it still never claims a go-live:
//   - the engine's existing publish path (publisher.ts publishRun) requires an operator-supplied
//     requestId (req_<flow>_<topic>_<yyyymmdd>_<nn>), refuses bodies carrying media, and — by board
//     decision B2 — NEVER releases: "releasing to production is a SEPARATE gate whose verb must
//     appear nowhere in this file";
//   - but publish_executor's own schema (and enforcePublishExecutionEvidence) only admits
//     status:"executed" with verification.deployStatus === "ready" AND productionConfirmed === true —
//     evidence that can only come from the release-and-verify sequence publishRun structurally does
//     not perform.
// So an engine-side "executed" built on publishRun could never satisfy the evidence rule and would be
// downgraded to "blocked" by the very check that exists to catch an unevidenced claim.
//
// T4 accepts that conclusion rather than working around it: the engine path publishes and then
// records status "blocked" with publishCommitted:true and a named go_live_unconfirmed blocker — the
// same record enforcePublishExecutionEvidence would have produced from an "executed" claim carrying
// this evidence. What T4 removes is the MODEL re-deriving the sequence, not the release gate. The
// release+verification tail remains unbuilt and is still its own change.
//
// SAFETY. The GATE-only path keeps the contract every other deterministic path has: the caller
// validates this output against the node's OWN outputSchema and falls through to the model dispatch
// on any failure. The EXECUTE path deliberately breaks that one clause and only that one — after a
// sequence that may already have written to a live site, "fall through to the model" means a second
// publish attempt by a caller that cannot see what the first one did, so it fails to a typed blocker
// with the node left blocked instead (see runEnginePublishExecution). Both are evaluated AFTER the
// executor's publish-refusal block, never before — a deterministic path must never be the thing that
// skips a gate.

import { describeOperatorDecisionSource, findPublicationDecision, readPublicationDecision, resolvePublishAuthority, type PublishAuthority } from "./publishDecision.js";
import { publishRun, type PublisherDeps, type PublishResult, type PublishStep } from "./publisher.js";
import { findDeep } from "../projects/toolResultSearch.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";
import type { PublishObjectOrigin } from "../projects/projectHooks.js";

export const PUBLISH_EXECUTION_ARTIFACT = "publish_execution.v1";

export type PublishExecutionGate = {
  passed: boolean;
  controllerGo: boolean;
  // Kept as the two-exact-comparisons gate shape's second half: true iff resolvePublishAuthority
  // authorized this run (operator explicit approval, OR — T15.5 — the project's autonomyMode policy).
  // The name predates autonomy; the value is now "authorized", not literally "an operator approved".
  operatorApproved: boolean;
  // One reason per closed gate, in gate order. Empty when the gate passed.
  reasons: string[];
  // T2 (run_1786557897658_elj34j) — WHICH source produced operatorApproved's underlying decision
  // ("explicit" | "project_policy_default" | "policy_autonomous"), so a receipt reader can never
  // mistake a policy default for an operator's own act. Undefined when no decision is recorded at
  // all. Purely descriptive: never read by gate PASS/FAIL logic above.
  operatorDecisionSource?: string;
  // T15.5 (ADR §2.3) — the resolved PublishAuthority's own `source`, present only when authorized:
  // "operator_explicit" (an operator's own decision) or "policy_autonomous" (autonomyMode policy,
  // no operator spoke). This is the field the publishAuthority receipt (below) is built from.
  authoritySource?: "operator_explicit" | "policy_autonomous";
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
  // T15.5 (ADR §8) — structural statement of which authority this run holds (never which authority
  // let a BLOCKED record through, since none did); see publishAuthorityReceipt.
  publishAuthority: PublishAuthorityReceipt;
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
// with the reason recorded. T15.5 (ADR §3): this stays the two-exact-comparisons shape it always was —
// an explicit controller "go" AND an authorized publish decision — autonomy changes only HOW the
// second comparison resolves (resolvePublishAuthority, publishDecision.ts), never that it exists.
export function evaluatePublishExecutionGate(run: Pick<WorkflowExecutionRecord, "stageOutputs" | "nodes" | "operatorPublishDecision" | "operatorDecisionSource" | "publishingPolicySnapshot">): PublishExecutionGate {
  const decision = readPublicationDecision(findPublicationDecision(run));
  const authority: PublishAuthority = resolvePublishAuthority(run);
  const reasons: string[] = [
    ...(decision.authorized ? [] : [`publication_decision_not_affirmative (${decision.code}): ${decision.reason}`]),
    ...(authority.authorized ? [] : [`${authority.code}: ${authority.reason}`])
  ];
  return {
    passed: decision.authorized && authority.authorized,
    controllerGo: decision.authorized,
    operatorApproved: authority.authorized,
    reasons,
    operatorDecisionSource: describeOperatorDecisionSource(run),
    ...(authority.authorized ? { authoritySource: authority.source } : {})
  };
}

// T15.5 (ADR §8) — the publishAuthority receipt: an autonomous publish must never read as a human
// one, and this is the structural (not merely prose) statement of which authority let a publish
// through. `operatorDecision` is run.operatorPublishDecision VERBATIM — null is null, never omitted,
// so a reader can always tell "no operator record" apart from "operator said X".
export type PublishAuthorityReceipt = {
  mode: "autonomous" | "operator-gated";
  source: "operator_explicit" | "policy_autonomous" | null;
  operatorDecision: "approved" | "withheld" | null;
};

// Exported for releaseExecution.ts: release_executor's own "executed" claim carries the SAME receipt
// shape, over the SAME run, so a reader never sees two different renderings of one run's authority.
export const publishAuthorityReceipt = (
  run: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "publishingPolicySnapshot">,
  gate: PublishExecutionGate
): PublishAuthorityReceipt => ({
  mode: run.publishingPolicySnapshot?.autonomyMode ?? "operator-gated",
  source: gate.authoritySource ?? null,
  operatorDecision: run.operatorPublishDecision ?? null
});

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
  // T15.5 — optional so a caller constructing a record from a gate alone (e.g. a unit test) still
  // gets a defined publishAuthority (operator-gated, no source, no operator decision) rather than a
  // required-field break.
  run?: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "publishingPolicySnapshot">;
};

// The fail-closed record. Deliberately shaped like the one the model produced on the live run:
// status "blocked", approvalMatched false, publishPolicyChecked true, one blocker per closed gate.
export function buildBlockedPublishExecution(sources: BlockedPublishExecutionSources): BlockedPublishExecution {
  const { gate } = sources;
  return {
    artifact: PUBLISH_EXECUTION_ARTIFACT,
    summary:
      `Publish refused fail-closed by the engine gate for ${sources.clientProjectId}/${sources.envelope.clientObjectType}: ` +
      `controller decision ${gate.controllerGo ? "go" : "not \"go\""}, publish authority ${gate.operatorApproved ? "authorized" : "not authorized"}` +
      // T2/T15.5 — an authorized decision names its source here, so this summary can never be misread
      // as an explicit operator sign-off when it was actually a policy default (project or autonomy).
      `${gate.operatorApproved && gate.operatorDecisionSource ? ` (${gate.operatorDecisionSource})` : ""}. ` +
      `No client tool was called, no object was created, patched, published or released. No model call.`,
    status: "blocked",
    clientProjectId: sources.clientProjectId,
    clientObjectType: sources.envelope.clientObjectType,
    contractSource: sources.envelope.contractSource,
    approvalMatched: false,
    publishPolicyChecked: true,
    publishAuthority: publishAuthorityReceipt(sources.run ?? {}, gate),
    blockers: gate.reasons,
    notes: [
      "Evaluated deterministically by the conductor (publishExecution.ts): the publish gate is two exact comparisons over existing run facts — an explicit publication_controller decision:\"go\" and the run's resolved publish authority (publishDecision.resolvePublishAuthority: an explicit operator approval, or the project's autonomyMode policy) — and both are read through the single shared reader (publishDecision.ts) that publishRun's own gates use, so the node and the publisher cannot drift apart.",
      "Zero side effects: this path performs no client call whatsoever, so a refusal cannot half-publish.",
      "To proceed: record the operator decision with workflow.set_operator_publish_decision (approved), enable the project's autonomyMode policy, and/or resolve the blockers the publication_controller decision names, then retry this node."
    ]
  };
}

// The one entry point executor.ts calls. Returns {ok:true} ONLY for the refusal path; a passing gate
// and a missing envelope both return {ok:false} so the caller's single decision stays "use it, or fall
// through to the model path".
export function runDeterministicPublishExecutor(params: {
  run: Pick<WorkflowExecutionRecord, "stageOutputs" | "nodes" | "operatorPublishDecision" | "operatorDecisionSource" | "publishingPolicySnapshot">;
  clientProjectId: string;
  envelopeCarriers: unknown[];
}): PublishExecutionResult {
  const gate = evaluatePublishExecutionGate(params.run);
  if (gate.passed) {
    return {
      ok: false,
      code: "gate_passed_execution_not_deterministic",
      error: "the publish gate passed (controller \"go\" + publish authorized); engine-side publish EXECUTION (create/validate/patch/publish + release + go-live verification) is not implemented deterministically, so the authorized path stays on the model path by design."
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
  return { ok: true, output: buildBlockedPublishExecution({ clientProjectId: params.clientProjectId, envelope, gate, run: params.run }) };
}

// ── T4 (Wave 2a, 2026-08-13) — the ENGINE-EXECUTED half ─────────────────────────────────────────
//
// WHY. On run_1786557897658_elj34j this node's model dispatch failed twice, both times by re-deriving
// a fact the engine already held: once it blocked claiming operatorPublishDecision was absent when the
// run carried it (never injected into node context — Wave 1 T2), once it re-read the
// publication_controller record from a DIFFERENT run, run_1786468126136, through stage.get_output
// (Wave 1 T1). A PASSED gate then handed that same model the publish SEQUENCE to re-derive as well.
// It does not any more: on the "execute" opt-in the engine performs the publish by calling
// publisher.ts's publishRun as a direct FUNCTION call — the same server-side sequence
// workflow.publish_run drives (create -> checkout -> validate -> patch -> publish -> checkin, in the
// project's OWN dialect via its executePublish hook), never over MCP transport and never through a
// model. ONE implementation, two callers; nothing about the sequence is reimplemented here.
//
// WHY publishRun WHOLE, rather than a factored-out inner sequence: its gate layer is not overhead on
// this path, it is defense in depth. publishRun re-checks the project kill-switch
// (publishingPolicy.publishEnabled / <CLIENT>_PUBLISH_ENABLED), the operator veto, the controller
// decision, the request-id contract, the article_body body contract, the project's readiness policy
// and the media refusal — over the PERSISTED run record, independently of anything this module read.
// The publish gate here is strictly STRONGER than publishRun's (it demands operatorPublishDecision
// === "approved", where publishRun only demands "not withheld"), so calling it adds checks and
// relaxes none.

export type PublishExecutorDeterministicMode = "off" | "gate" | "execute";

// The opt-in, read from the node's own metadata exactly like every sibling deterministic route reads
// its flag (contractIntelligenceDeterministic, publishPayloadDeterministic,
// publicationControllerDeterministic, learningRecorderDeterministic — all `=== true`). The one
// extension T4 makes is that THIS flag is tri-state, because this node has two separable halves:
//   absent / anything else -> "off"     : no deterministic path at all; model dispatch, as before.
//   true                   -> "gate"    : today's semantics, unchanged — deterministic REFUSAL only.
//   "execute"              -> "execute" : gate + engine-side execution of the publish sequence.
// Fail-closed on the unrecognised value: a typo'd flag is "off" (the model path), never a broader
// authorization than the operator wrote down.
export const readPublishExecutorDeterministicMode = (metadata?: Record<string, unknown>): PublishExecutorDeterministicMode => {
  const flag = metadata?.publishExecutorDeterministic;
  if (flag === "execute") return "execute";
  return flag === true ? "gate" : "off";
};

// A typed, named refusal — never prose-only state. `step` is the sequence step that actually failed
// (a client tool name where one failed, otherwise the phase that refused), and `clientError` is the
// CLIENT's own error text carried verbatim, never re-worded: on the live failures the engine's
// paraphrase of a client error was consistently less useful than the client's own sentence.
export type PublishExecutionBlocker = { code: string; step: string; message: string; clientError?: string };

export const renderPublishExecutionBlocker = (blocker: PublishExecutionBlocker): string =>
  `${blocker.code} at ${blocker.step}: ${blocker.message}${blocker.clientError ? ` Client error: ${blocker.clientError}` : ""}`;

// What the run can prove happened. Every field is READ from the sequence's own outputs — the object
// id from the hook's outcome, commit/revision from the client's publish result, digests carried
// through from publish_payload, the tool sequence from the steps publishRun actually recorded. A fact
// the client did not state is ABSENT here, never defaulted: an invented receipt is worse than none.
export type PublishExecutionReceipts = {
  // Absent only on the one refusal that exists BECAUSE it is absent (publish_request_id_absent).
  requestId?: string;
  // The client object this publish addressed. Present on a COMMITTED publish and — since 2026-08-27
  // — on a FAILED one too, whenever the sequence got far enough to create or adopt an object before
  // it stopped: run_1787862284296_x53xz0 created the object, died at object_checkout, and named
  // nothing, so the run read "Nothing was published" for an article that was sitting on the client
  // and could only be found by hand. An id is recorded here exactly when the sequence proved one.
  objectId?: string;
  // Where that id came from: "created" here, "adopted_existing" (this run re-entered over the object
  // its own request id already named), or "conductor_shell". Absent when the hook did not say.
  objectOrigin?: PublishObjectOrigin;
  commitSha?: string;
  contentRevision?: string | number;
  publishedTime: string | null;
  artifactDigests: string[];
  // The tools that ACTUALLY ran, in the order they ran — derived from publishRun's steps, NOT from
  // the project's declared publishToolSequence (which is a plan, i.e. what was expected).
  toolSequence: string[];
  steps: PublishStep[];
};

export type ExecutedPublishExecution = {
  artifact: typeof PUBLISH_EXECUTION_ARTIFACT;
  summary: string;
  // T15.6 (ADR-2026-08-25-publish-autonomy §4.4) — "published_pending_release" replaces the old
  // "blocked" + go_live_unconfirmed workaround for a COMMITTED publish: publishRun committed the
  // export (board B2: it never releases), and release_executor — a separate, downstream tail node —
  // performs the release and produces the real "executed" claim. "blocked" now means what it says: the
  // publish itself did not complete.
  status: "blocked" | "published_pending_release";
  clientProjectId: string;
  clientObjectType: string;
  contractSource: Record<string, unknown>;
  approvalMatched: boolean;
  // T2's field, recorded NEXT TO approvalMatched so a receipt reader can never take a project-policy
  // default for an explicit operator sign-off.
  operatorDecisionSource?: string;
  // T15.5 (ADR §8) — see publishAuthorityReceipt / BlockedPublishExecution.publishAuthority.
  publishAuthority: PublishAuthorityReceipt;
  publishPolicyChecked: true;
  // The one bit that separates "nothing happened" from "a live site was mutated". Read it before
  // retrying anything.
  publishCommitted: boolean;
  approvedAction: Record<string, unknown>;
  clientValidation?: Record<string, unknown>;
  result?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  receipts: PublishExecutionReceipts;
  // Present only on a NON-committed record — a real failure. A committed publish is
  // "published_pending_release", not blocked, and names nothing here (see buildEnginePublishExecution).
  blocker?: PublishExecutionBlocker;
  blockers: string[];
  notes: string[];
};

// The publish request id. NEVER generated here: publishRun's request-id contract says the id is
// operator-supplied (publishPayload.ts makes the same refusal — "does not invent a requestId ... the
// upstream plan never named"), so an absent id is a blocker, not a value to mint.
export const readPublishRequestId = (...carriers: unknown[]): string | undefined => {
  for (const carrier of carriers) {
    if (isObject(carrier) && nonEmptyString(carrier.requestId)) return carrier.requestId.trim();
  }
  return undefined;
};

// Artifact references carried through from publish_payload (nearest carrier wins), and the digests
// they already state. Carried, never computed: this node has no way to hash a client-side artifact,
// and a digest it derived itself would be evidence about nothing.
const DIGEST_KEYS = ["digest", "sha256", "sha", "checksum", "content_digest", "contentDigest"];

export const readArtifactReferences = (...carriers: unknown[]): Record<string, unknown>[] => {
  for (const carrier of carriers) {
    if (isObject(carrier) && Array.isArray(carrier.artifactReferences)) return carrier.artifactReferences.filter(isObject);
  }
  return [];
};

export const readArtifactDigests = (references: Record<string, unknown>[]): string[] =>
  references.map((reference) => DIGEST_KEYS.map((key) => reference[key]).find(nonEmptyString)).filter(nonEmptyString);

// Commit sha / content revision, read from the CLIENT's own publish result. Tolerant key search for
// the same reason findLockToken/findObjectId are (toolResultSearch.ts): the result envelope shape is
// the client's, not ours, and varies by tenant and transport. Absent stays absent.
const findCommitSha = (result: unknown): string | undefined =>
  findDeep(result, (key, child) => /^(commit_sha|commitSha|commit|revision_sha)$/.test(key) && nonEmptyString(child)) as string | undefined;

const findContentRevision = (result: unknown): string | number | undefined =>
  findDeep(result, (key, child) => /^(content_revision|contentRevision)$/.test(key) && (typeof child === "number" || nonEmptyString(child))) as string | number | undefined;

export type EnginePublishExecutionSources = {
  clientProjectId: string;
  envelope: PublishExecutionEnvelope;
  gate: PublishExecutionGate;
  receipts: PublishExecutionReceipts;
  // Present exactly when publishCommitted is false — a committed publish has nothing to name as a
  // blocker; see ExecutedPublishExecution.blocker.
  blocker?: PublishExecutionBlocker;
  publishCommitted: boolean;
  artifactSet: Record<string, unknown>[];
  extraBlockers?: string[];
  result?: unknown;
  clientValidation?: unknown;
  // T15.5 — see BlockedPublishExecutionSources.run.
  run?: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "publishingPolicySnapshot">;
};

// The engine-execution record. status is ALWAYS "blocked" and that is not a placeholder: publishRun
// commits the export and never releases (board B2), so verification.deployStatus "ready" +
// productionConfirmed true — the evidence enforcePublishExecutionEvidence requires of an "executed"
// claim — cannot be produced by this path. `publishCommitted` carries the fact the status cannot, and
// the summary leads with it so no reader can skim past a live mutation.
export function buildEnginePublishExecution(sources: EnginePublishExecutionSources): ExecutedPublishExecution {
  const { receipts, blocker, gate } = sources;
  const ran = receipts.toolSequence.length;
  return {
    artifact: PUBLISH_EXECUTION_ARTIFACT,
    summary: sources.publishCommitted
      ? `PUBLISH COMMITTED by the engine for ${sources.clientProjectId}/${sources.envelope.clientObjectType}` +
        `${receipts.objectId ? ` (object ${receipts.objectId})` : ""} via ${ran} client call(s) [${receipts.toolSequence.join(" -> ")}], request ${receipts.requestId ?? "(none)"}. ` +
        `Go-live is NOT yet confirmed — release_executor performs the release and production verification next, downstream in the shared tail (board decision B2: this stage never releases) — so this record is "published_pending_release", not "executed". No model call.`
      : `Publish did NOT complete for ${sources.clientProjectId}/${sources.envelope.clientObjectType}: stopped at ${blocker?.step ?? "unknown"} (${blocker?.code ?? "unknown"}) after ${ran} client call(s)` +
        `${ran ? ` [${receipts.toolSequence.join(" -> ")}]` : ""}. Nothing was published.` +
        // The object a failed sequence LEFT BEHIND, named in the first sentence a human reads. Without
        // it, run_1787862284296_x53xz0 read as "Nothing was published" for an object that existed.
        `${receipts.objectId ? ` A client object DOES exist for this request (${receipts.objectId}, ${receipts.objectOrigin ?? "created"}) and is unpublished; a retry re-enters on that object rather than creating another.` : ""}` +
        ` No model call.`,
    status: sources.publishCommitted ? "published_pending_release" : "blocked",
    clientProjectId: sources.clientProjectId,
    clientObjectType: sources.envelope.clientObjectType,
    contractSource: sources.envelope.contractSource,
    approvalMatched: gate.operatorApproved,
    ...(gate.operatorDecisionSource ? { operatorDecisionSource: gate.operatorDecisionSource } : {}),
    publishAuthority: publishAuthorityReceipt(sources.run ?? {}, gate),
    publishPolicyChecked: true,
    publishCommitted: sources.publishCommitted,
    approvedAction: {
      ...(receipts.objectId ? { clientObjectId: receipts.objectId } : {}),
      ...(receipts.requestId ? { requestId: receipts.requestId } : {}),
      publicationAction: "object_publish",
      ...(sources.artifactSet.length ? { artifactSet: sources.artifactSet } : {})
    },
    ...(isObject(sources.clientValidation) ? { clientValidation: sources.clientValidation } : {}),
    ...(isObject(sources.result) ? { result: sources.result } : {}),
    // Recorded ONLY on a committed publish, and it records what was NOT done here. deployStatus and
    // productionConfirmed are deliberately absent rather than false-y placeholders: THIS node made no
    // deploy observation at all — release_executor is what produces those — and an absent observation
    // must not read as a negative one.
    ...(sources.publishCommitted
      ? { verification: { deployAware: false, goLiveConfirmed: false, requiredChecks: ["production_deploy_confirmed", "target_commit_served", "page_and_media_verification"] } }
      : {}),
    receipts,
    ...(blocker ? { blocker } : {}),
    blockers: blocker ? [renderPublishExecutionBlocker(blocker), ...(sources.extraBlockers ?? [])] : (sources.extraBlockers ?? []),
    notes: [
      "Executed by the conductor (publishExecution.ts) as a direct function call into publisher.ts publishRun — the SAME sequence workflow.publish_run drives, in the project's own dialect, with no MCP transport hop and no model turn. The gate that authorized it is the two exact comparisons at the top of this module, and publishRun re-checked its own five gates (including the per-project publishEnabled kill-switch) over the persisted run before calling anything.",
      `receipts.toolSequence is what ACTUALLY ran, in order, taken from the steps publishRun recorded — not the project's declared publishToolSequence, which is a plan.${sources.publishCommitted ? "" : " The sequence stopped at the first failure; no later step was attempted."}`,
      ...(receipts.objectOrigin === "adopted_existing"
        ? [`RE-ENTRY, not a first attempt: object_create was refused "already exists" (409) and the object this request already names (${receipts.objectId}) was adopted and carried through the rest of the sequence. An earlier attempt of this run created it.`]
        : []),
      ...(sources.publishCommitted
        ? ["A client object EXISTS and was published. Do not re-run this node to \"finish\" the publish: release_executor performs the release exactly once, downstream in the tail — retrying THIS node would drive the create step again."]
        : receipts.objectId
          ? [`A client object EXISTS but was NOT published: ${receipts.objectId} (${receipts.objectOrigin ?? "created"}). The sequence created or adopted it and then stopped, so this run mutated the client without publishing. A retry does NOT create a second object — on a dialect that mints the object id from the request id the create is refused "already exists" and the sequence re-enters on this same object.`]
          : [])
    ]
  };
}

// The result the executor branches on. `nodeBlocked` says what the NODE state must be — a gate
// refusal COMPLETES the node (it produced its artifact; the publish is what is blocked, exactly as
// the live run recorded it), an execution failure leaves it BLOCKED. `ok:false` is returned ONLY
// before any client call is possible, so the caller can never read it as "a publish may have
// happened".
export type EnginePublishExecutionResult =
  | { ok: true; output: ExecutedPublishExecution | BlockedPublishExecution; nodeBlocked: boolean; warnings: string[] }
  | { ok: false; code: string; error: string };

export type EnginePublishExecutionParams = {
  run: Pick<WorkflowExecutionRecord, "runId" | "projectId" | "stageOutputs" | "nodes" | "operatorPublishDecision" | "operatorDecisionSource" | "publishingPolicySnapshot">;
  clientProjectId: string;
  envelopeCarriers: unknown[];
  requestId?: string;
  publishedTime?: string | null;
  deps?: PublisherDeps;
  // Injected by tests so the sequence runs against a stubbed project adapter and never a live site.
  publish?: typeof publishRun;
};

const lastFailedStep = (steps: PublishStep[]): PublishStep | undefined => [...steps].reverse().find((step) => !step.ok);

export async function runEnginePublishExecution(params: EnginePublishExecutionParams): Promise<EnginePublishExecutionResult> {
  const gate = evaluatePublishExecutionGate(params.run);
  // Envelope BEFORE gate-pass handling and before any call: a publish whose receipt cannot be written
  // is a publish nobody can audit, so an absent envelope refuses the whole path rather than executing
  // and then failing to record it.
  const envelope = readPublishExecutionEnvelope(...params.envelopeCarriers);
  if (!envelope) {
    return {
      ok: false,
      code: "publish_envelope_absent",
      error: "no upstream output carries both a clientObjectType and a contractSource object; a publish_execution.v1 record cannot be assembled without inventing the envelope facts it must name, so the engine refuses to publish rather than publish unrecorded."
    };
  }
  // Gate closed: the fail-closed record, bit-for-bit what the gate-only path produces. Zero calls.
  if (!gate.passed) {
    return { ok: true, output: buildBlockedPublishExecution({ clientProjectId: params.clientProjectId, envelope, gate, run: params.run }), nodeBlocked: false, warnings: ["no_publication_performed"] };
  }

  const artifactSet = readArtifactReferences(...params.envelopeCarriers);
  const artifactDigests = readArtifactDigests(artifactSet);
  const publishedTime = params.publishedTime ?? null;
  // THE PUBLISH REQUEST ID, resolved in strict precedence order, and DELIBERATELY UNCHANGED by S3:
  //
  //   1. params.requestId  — runContext.requestId, passed down by the executor. buildRunContext lifts
  //                          it from artifact_plan (the ONE node that authors this id), falling back
  //                          to the run's operator-supplied publishRequestId when artifact_plan
  //                          authored none — which on a seeded late-stage run is always.
  //   2. envelope carriers — publication_controller / publish_payload / article_body.
  //   3. absent            — publish_request_id_absent below. Never a mint.
  //
  // S3 (2026-08-25, run_1787656120374_18bobg) fixed a seeded run that could not publish, and did NOT
  // add a fourth source here. It could have: the run record is in hand (params.run) and it now carries
  // publishRequestId. But reading it here would resolve the id for the publisher ALONE — the run
  // context would stay empty, publish_payload would keep omitting its optional `requestId`, and the
  // candidate an operator reviews would not name the id the publish is actually made under. The lift
  // therefore happens once, in buildRunContext, and arrives here through step 1 like any authored id.
  const requestId = nonEmptyString(params.requestId) ? params.requestId.trim() : readPublishRequestId(...params.envelopeCarriers);
  const receiptsFor = (steps: PublishStep[], extra: Partial<PublishExecutionReceipts> = {}): PublishExecutionReceipts =>
    ({ ...(requestId ? { requestId } : {}), publishedTime, artifactDigests, toolSequence: steps.map((step) => step.tool), steps, ...extra });
  const blocked = (blocker: PublishExecutionBlocker, receipts: PublishExecutionReceipts, extraBlockers?: string[]): EnginePublishExecutionResult => ({
    ok: true,
    output: buildEnginePublishExecution({ clientProjectId: params.clientProjectId, envelope, gate, receipts, blocker, publishCommitted: false, artifactSet, extraBlockers, run: params.run }),
    nodeBlocked: true,
    // Run-visible and specific: the blocker's own code, plus how many client calls DID land. A
    // partially-executed sequence must never be summarised as "no publication performed".
    warnings: [
      `publish_execution_blocked:${blocker.code}`,
      // A created-but-unpublished object is the single most actionable fact a failed publish can
      // carry, so it is run-visible and not only inside the record.
      ...(receipts.objectId ? [`publish_left_client_object:${receipts.objectId}`] : []),
      ...(receipts.steps.length ? [`publish_partial_client_writes:${receipts.steps.length}`] : ["no_publication_performed"])
    ]
  });

  if (!requestId) {
    return blocked({
      code: "publish_request_id_absent",
      step: "request_id",
      message: `no upstream output and no run context carries a publish requestId (req_<flow>_<topic>_<yyyymmdd>_<nn>). The id is operator-supplied by contract and is never minted here, so ${params.clientProjectId} is not published; supply it on artifact_plan/publish_payload — or, for a late-stage entrypoint run whose artifact_plan is seeded and authors none, start the run with workflow.start_dry_run's publishRequestId — and retry this node.`
    }, receiptsFor([]));
  }

  let result: PublishResult;
  try {
    // live is the publisher's EXPLICIT-intent flag, and this call is that explicit intent: the engine
    // only reaches this line with a controller "go" AND a resolved publish authority already proven
    // above (evaluatePublishExecutionGate). `approved` is passed for backward compatibility only
    // (T15.5, ADR §7: deprecated as an authority input at publisher.ts's own gate, which re-derives
    // authorization from the SAME run independently). Every other gate — the project kill-switch, the
    // operator veto, the controller decision again, the request-id contract, the body contract, the
    // readiness policy, the media refusal — is publishRun's own and is deliberately left to it.
    //
    // No `readiness` input is supplied on purpose: verifiedMediaRefs is the operator's evidence that
    // pdf-tool materialized each artifact, and an engine that hands itself that evidence has waived
    // the check. A media-carrying body therefore blocks here (publishRun refuses one outright), which
    // is the fail-closed direction.
    result = await (params.publish ?? publishRun)(
      { runId: params.run.runId, projectId: params.run.projectId, requestId, approved: true, live: true, publishedTime },
      params.deps ?? {}
    );
  } catch (error) {
    // publishRun throws only for an unresolvable run or projectId — both before any client call.
    return blocked({ code: "publish_run_unavailable", step: "publish_run", message: "the engine could not start the publish sequence; nothing was called.", clientError: error instanceof Error ? error.message : String(error) }, receiptsFor([]));
  }

  if (result.published) {
    const commitSha = findCommitSha(result.result);
    const contentRevision = findContentRevision(result.result);
    const receipts = receiptsFor(result.steps, {
      ...(result.objectId ? { objectId: result.objectId } : {}),
      ...(result.objectOrigin ? { objectOrigin: result.objectOrigin } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(contentRevision !== undefined ? { contentRevision } : {})
    });
    return {
      ok: true,
      output: buildEnginePublishExecution({
        clientProjectId: params.clientProjectId,
        envelope,
        gate,
        receipts,
        publishCommitted: true,
        artifactSet,
        result: result.result,
        clientValidation: result.clientValidation,
        run: params.run
        // No `blocker` here (T15.6, ADR §4.4): the client object was created, patched and published
        // (see receipts) — publishRun commits the export and, by board decision B2, never releases.
        // That is no longer an unevidenced "blocked" workaround; it is the honest intermediate status
        // "published_pending_release", and release_executor — downstream in the shared tail — performs
        // the release and produces the real "executed" claim with go-live evidence.
      }),
      nodeBlocked: false,
      warnings: ["publish_committed_pending_release"]
    };
  }

  if (result.mode === "dry_run") {
    // publishRun's own gates closed AFTER this module's gate passed. The one that can legitimately
    // differ is the per-project kill-switch (publishingPolicy.publishEnabled / <CLIENT>_PUBLISH_ENABLED
    // = false), which is an operator's per-batch stop and is never relaxed here. Zero client calls.
    const closed = result.gates.gates.filter((entry) => !entry.passed);
    return blocked(
      { code: "publish_gate_closed", step: "publisher_gates", message: `publishRun refused before any client call: ${closed.map((entry) => entry.name).join(", ") || "gates not satisfied"}. ${result.reason}` },
      receiptsFor(result.steps),
      closed.map((entry) => `${entry.name}: ${entry.reason ?? "gate not satisfied"}`)
    );
  }

  if (result.mode === "blocked_for_publish_execution") {
    return blocked(
      { code: "publish_readiness_no_go", step: "publish_readiness", message: `${params.run.projectId}'s own publish-readiness policy returned NO-GO before any client call. ${result.blocked.requiredAction}` },
      receiptsFor(result.steps),
      result.readiness.blockers.map((entry) => `readiness_${entry}`)
    );
  }

  // mode "error". A step that FAILED is the precise answer and carries the client's own words;
  // publishRun's `call` throws on the first !ok result, so the failing step is also the LAST step
  // recorded and nothing after it ran. When every recorded step succeeded, the sequence refused
  // between calls (an unresolvable id/lock/version, a rejected request id, an invalid body, a media
  // body, a project with no publish hook) and the error's own code prefix names that phase.
  const failed = lastFailedStep(result.steps);
  return blocked(
    failed
      ? { code: "publish_step_failed", step: failed.tool, message: `the publish sequence stopped at ${failed.tool} and no later step was attempted; ${result.steps.length} client call(s) ran in total.${result.objectId ? ` A client object EXISTS for this request (${result.objectId}) and is unpublished.` : ""}`, clientError: failed.error ?? result.error }
      : { code: "publish_sequence_error", step: /^[a-z0-9_]+(?=:)/.exec(result.error)?.[0] ?? "publish_sequence", message: `the publish sequence did not complete; ${result.steps.length} client call(s) ran in total.${result.objectId ? ` A client object EXISTS for this request (${result.objectId}) and is unpublished.` : ""}`, clientError: result.error },
    // THE OBJECT A FAILED PUBLISH LEFT BEHIND. publishRun carries it out of the throw (see its
    // PublishResult "error" variant); recording it here is what lets approvedAction.clientObjectId
    // name the object on a blocked record, so a human — and a re-entering retry — can find it.
    receiptsFor(result.steps, {
      ...(result.objectId ? { objectId: result.objectId } : {}),
      ...(result.objectOrigin ? { objectOrigin: result.objectOrigin } : {})
    })
  );
}
