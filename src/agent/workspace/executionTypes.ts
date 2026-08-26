// R-18 — "paused" exists because "blocked" had come to mean three unrelated things: a publish-approval
// hold (approvalsRequired populated), a budget hold (budgetBlock populated), and an operator pressing
// pause (neither populated). An operator-paused run was therefore only distinguishable from a
// publish-held one by the ABSENCE of both markers, which is not a signal anyone should have to read.
// workflow.pause_run now reports "paused"; resume_run returns the run to "queued" as before.
// W4 — "skipped" is a NODE status: the conductor evaluated a declarative skip predicate
// (skipPredicates.ts) BEFORE dispatching the node and decided it had nothing to contribute to this
// run, so nothing was dispatched and nothing was charged. It is deliberately its own status rather
// than a completed-with-empty-output: a skipped node produced no artifact and asserted nothing, and a
// reader of the run must be able to tell "the conductor decided this was unnecessary" from "this ran
// and had nothing to say" — the latter is exactly the $0.06 research call W4 exists to stop paying
// for. Downstream, a skipped node counts as SATISFIED-with-absent for dependency purposes (executor:
// findNextRunnableNode / dependenciesReached), never as a failure and never as a blocker. A run never
// takes this status; only a node does.
export const executionStatuses = ["queued", "running", "paused", "completed", "failed", "blocked", "cancelled", "skipped"] as const;
export type ExecutionStatus = typeof executionStatuses[number];
// A paused run is intentionally halted alongside completed/failed/blocked/cancelled runs until a
// caller explicitly resumes it. This is the single status set shared by executor and job drivers.
export const haltedExecutionStatuses = ["blocked", "cancelled", "completed", "failed", "paused"] as const satisfies readonly ExecutionStatus[];
export const HALTED_EXECUTION_STATUSES = new Set<ExecutionStatus>(haltedExecutionStatuses);

// Per-call audit stub for the controlled-tool calls a node execution made. ToolExecutor's full audit
// records live in process memory and die with the serverless invocation (why tool.list_executions
// returned [] for every past conductor run); these stubs are persisted with the node state so a run's
// tool activity is diagnosable after the fact — metadata only, never payloads.
export type NodeToolCallRecord = { toolId: string; toolExecutionId?: string; status: "success" | "denied" | "error"; errorCode?: string; durationMs?: number };

// Stamped by the executor's claim-save at the moment a node is handed to a runner, BEFORE the model
// loop starts. This is the run record's heartbeat: while a node is genuinely in flight the persisted
// record shows it "running" with this marker, and once now() has passed dispatchedAt + timeoutMs +
// margin the driver provably died mid-node (the runner's own timeout would have finished it first) —
// which is how an operator tells "stalled" from "working" instead of watching status:"running"
// forever. A stale dispatch is reclaimed to queued on the next advance, so the run stays resumable.
export type NodeDispatchClaim = { dispatchedAt: string; timeoutMs: number; driver?: RunDriver; projectEndpointConfigured?: boolean };

// S1 (chat-path, 2026-08-17) — WHICH driver dispatched a node, and whether the run's project MCP
// endpoint was configured in that driver's environment at that moment. Four drivers advance runs
// (the HTTP run_all/run_node loops, the HTTP retry, the scheduled continuation tick, and the Cloud
// Run conductor job) and each runs in its own environment; a node that failed with a project
// connection error is only diagnosable if the record says which of the four ran it and what that
// process could see. Stamped on the in-flight claim (state.dispatch) and copied to state.lastDispatch
// so it survives the claim's release on completion.
export type RunDriver = "http_run_all" | "http_retry_node" | "continuation_tick" | "cloud_run_job";
export type NodeDispatchProvenance = { dispatchedAt: string; driver: RunDriver; projectEndpointConfigured: boolean };

// W4 — the audit record of a skip. Written by the executor at the moment it decides NOT to dispatch,
// carrying the predicate that fired verbatim (it is data, so it round-trips) plus the facts it fired
// on. This is what makes gating auditable rather than merely cheap: months later, "why did this run
// have no emotional_resonance review" is answered by the record on the node itself, not reconstructed
// from a policy document and a guess about which content class the run declared.
export type NodeSkipRecord = {
  reason: string;
  predicate?: Record<string, unknown>;
  basis?: string[];
  evaluatedAt: string;
};

export type NodeExecutionState = {
  nodeId: string;
  status: ExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  errors?: string[];
  warnings?: string[];
  produces?: string[];
  toolCalls?: NodeToolCallRecord[];
  dispatch?: NodeDispatchClaim;
  // The most recent dispatch's provenance (driver + project endpoint visibility); survives completion.
  lastDispatch?: NodeDispatchProvenance;
  // Present only on a node whose status is "skipped" (W4).
  skip?: NodeSkipRecord;
  // Set when an operator explicitly retried a node the conductor had skipped: the retry IS the
  // operator saying "run this one", so the predicate is not re-evaluated on the next dispatch. Durable
  // (a retry that only cleared the skip record would be re-skipped immediately, forever).
  skipOverride?: boolean;
};

// R-18 — `pending` distinguishes the two moments a publish gate is knowable:
//   pending === true  — LOOK-AHEAD. The previous node just finished and the next dependency-ready node
//                       is publish-risk. Nothing has been attempted, no publication_decision.v1 has
//                       been emitted, and the run still reports status "running". Before this existed,
//                       approvalsRequired was [] here, so a run parked one step before the publish gate
//                       was indistinguishable from a run still working — invisible to the UI and to an
//                       operator, which is exactly what R-18 recorded.
//   pending absent    — ATTEMPTED. Someone called an advance on the publish-risk node without approval;
//                       the gate refused, the run is "blocked", and the node carries its
//                       publication_decision.v1 "blocked" output as the audit record.
// A look-ahead entry is replaced (not duplicated) by the attempted entry for the same node.
//
// T15.7 (ADR-2026-08-25-publish-autonomy §5) — `source` names the PublishAuthority that produced this
// entry, present on the ADVISORY shape: `pending` absent/false AND `source: "policy_autonomous"` means
// the node PROCEEDED under the project's autonomous policy (no operator spoke) rather than having been
// refused — an autonomous publish must stay exactly as visible in this feed as a gated one, so it gets
// its own entry naming the authority that let it through, distinct from the "attempted, refused"
// meaning `pending` absent otherwise carries. Absent `source` on a `pending`-absent entry keeps its
// pre-T15.7 meaning: a real refusal, recorded before autonomy existed to author anything else here.
export type ApprovalRequired = {
  nodeId: string;
  type: "approval_required";
  reason: string;
  requestedAt: string;
  pending?: boolean;
  source?: "operator_explicit" | "policy_autonomous";
  // T5 (2026-08-26) — the STABLE, addressable id of the gate this entry represents, resolved from
  // gateRegistry.ts by (run.workflowId, nodeId). nodeId alone is not an address: three workflows
  // share the tail's node ids, so "hold publish_executor" could not mean "hold clone's" without also
  // meaning "hold the article path's". This is what a future manual-approval mode targets to hold ONE
  // gate rather than a whole run, which is the difference between a mode an operator will actually
  // use and one they will not. Optional only for records that predate this field and for a
  // (workflow, node) pair the registry does not declare — a state the conformance test forbids for
  // any registered workflow.
  gateId?: string;
};

// Set when the conductor halts a run because its configured per-run cost ceiling (budgetUsd) has
// been reached. The run enters status "blocked" (the nearest existing blocked state) WITHOUT the
// pending node being started — it stays queued and is never partially charged — so raising the
// ceiling and resuming continues exactly where it paused. Distinct from an approval block: no
// ApprovalRequired entry is minted, and this marker is what tells a caller/dashboard the pause is
// "for budget" rather than "for approval".
export type RunBudgetBlock = {
  blockedAt: string;
  budgetUsd: number;
  spentUsdEstimate: number;
  // The dependency-ready node that would have run next (and would have crossed the ceiling).
  nextNodeId?: string;
  reason: string;
};

export type ExecutionArtifact = {
  id: string;
  nodeId: string;
  type: string;
  value: unknown;
  createdAt: string;
};

// A late-stage entrypoint: a node whose output is supplied up front so the run enters directly at
// that node's downstream successors. The entrypoint node and all its ancestors start seeded as
// completed (never re-run), while the nodes after it run normally. Persisted on the run so reset
// rebuilds the same seeded starting state instead of a full run.
export type WorkflowEntrypoint = {
  nodeId: string;
  output: unknown;
};

export type WorkflowExecutionRecord = {
  runId: string;
  workflowId: string;
  projectId: string;
  // R-9: the join key between a platform workflow record and this workspace run — without it, the
  // learning corpus sees outcomes with no method (it can see a run happened and see a platform-side
  // event happened, with no way to prove they are the same request). Generated once at run creation
  // (buildInitialRun) and copied onto every usage record the run produces; never authored by a node
  // or the operator — that is the DIFFERENT, human-supplied requestId publish_payload emits per
  // publish attempt (req_<flow>_<topic>_<yyyymmdd>_<nn>), which this does not replace.
  requestId?: string;
  // S3 (2026-08-25, run_1787656120374_18bobg) — THE OPERATOR-SUPPLIED PUBLISH REQUEST ID, and a
  // DIFFERENT IDENTIFIER FROM `requestId` ABOVE. `requestId` is the platform/workspace join key: it is
  // generated once at run creation and exists so a workspace run and a platform workflow record can be
  // proven to be the same request. THIS field is the publish contract's own id
  // (req_<flow>_<topic>_<yyyymmdd>_<nn>) that publish_payload/publish_executor stamp on a published
  // client object — authored by a human, never by the engine. The two are stored separately, and must
  // stay separate, because putting the join key on a publish would put the wrong identifier on a live
  // client object; nothing anywhere falls back from one to the other, in either direction.
  //
  // WHY IT EXISTS AT ALL. In a full run this id is authored by exactly one node, artifact_plan, and
  // lifted into run context from its stage output (buildRunContext, runContext.ts). A late-stage
  // entrypoint run seeds artifact_plan as completed-and-skipped, so it authors nothing, the run
  // context carries no requestId, and the run could never publish — publish_executor refuses with
  // publish_request_id_absent, which is exactly what run_1787656120374_18bobg (dr-lurie) did with a
  // controller "go", an operator "approved" and all five publisher gates passing.
  //
  // WHO WRITES IT: two writers, and only two.
  //   1. workflow.start_dry_run, after validating the supplied id against the project's declared
  //      objectDialect.requestIdPattern (see resolvePublishRequestId in mcp/workspace/tools.ts — a
  //      malformed id is refused before the run is created).
  //   2. T4 — the conductor, at the exact moment artifact_plan SKIPS on no_media_slots. A text-only
  //      run skips its only author by design and would otherwise hit the same publish_request_id_absent
  //      dead end a seeded run hits, for the same structural reason. The authored id carries the flow
  //      segment `conductor` so it is distinguishable from an operator's, is proven against the
  //      project's own pattern before it is stored, and never overwrites an id already on the run.
  // workflow.reset_run carries it across a reset, because a reset retries the SAME publish request,
  // not a new one.
  // WHO READS IT: buildRunContext, and only buildRunContext, as the FALLBACK behind
  // stageOutputs.artifact_plan.requestId — so a run that really authored an id always wins, and the
  // stored one is what a seeded run has instead. Everything downstream (publish_payload's
  // deterministic builder, publish_executor's engine path) already reads runContext.requestId and
  // needs no knowledge of this field at all: there is one lift point, not one per consumer.
  //
  // Optional by design: absent means the run has no publish id and publish_executor's refusal stands
  // exactly as before. It is never defaulted, and never inherited from `requestId` — that field is the
  // platform/workspace join key, and stamping it on a live client object would be worse than not
  // publishing. The single authoring path is writer (2) above, at one predicate, on one node.
  publishRequestId?: string;
  status: ExecutionStatus;
  currentNodeId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  nodes: NodeExecutionState[];
  artifacts: ExecutionArtifact[];
  errors: string[];
  // Run-level, non-fatal, deduplicated by value. Today: `driver_env_missing:<VAR>` written by a
  // background driver (continuation tick / conductor job) that declined to dispatch because the
  // run's project MCP endpoint env var was not set in its process (driverEnvPreflight.ts).
  warnings?: string[];
  approvalsRequired: ApprovalRequired[];
  initialInput?: unknown;
  stageOutputs: Record<string, unknown>;
  dryRun: true;
  executionMode?: "mock" | "openai";
  // Monotonic revision used for optimistic concurrency control. A read carries the stored `rev`;
  // a save only succeeds when the stored `rev` still matches, then increments it. This makes the
  // read-mutate-write cycle for a run atomic so overlapping calls can never re-run a completed node
  // or regress `currentNodeId`. Absent (undefined) is treated as 0 for records written before this
  // field existed.
  rev?: number;
  // Set when the run started from a late-stage entrypoint (a supplied node output). Retained so a
  // reset rebuilds the identical seeded starting state rather than a full ideation-to-publish run.
  entrypoint?: WorkflowEntrypoint;
  // Optional per-run cost ceiling in USD. Default OFF: undefined means no gate and behavior is
  // unchanged. When set, the conductor halts the run before dispatching any node once the run's
  // accrued (actual+estimated) model cost reaches this ceiling. Persisted on the run so a reset
  // rebuilds the same ceiling.
  budgetUsd?: number;
  // Present only while the run is paused for budget (see RunBudgetBlock). Cleared the moment the
  // run advances past the budget check (e.g. after the ceiling is raised and the run resumes).
  budgetBlock?: RunBudgetBlock;
  // P0 §2.2 — THE operator publish veto/approval field: ONE named field, ONE setter, ONE reader.
  // Set ONLY by workflow.set_operator_publish_decision (executor.setOperatorPublishDecision); read
  // ONLY through publishDecision.isOperatorPublishWithheld / resolvePublishAuthority, consumed by
  // publishRun's gates and the executor's publish-risk dispatch guard.
  // "withheld" is a durable operator veto: it blocks workflow.publish_run and every publish-risk
  // node regardless of approved/live flags until the operator replaces it. "approved" is the durable
  // operator approval an "executed" publish_execution.v1 claim must match (its approvalMatched
  // field refers to exactly this record). Absent means no operator decision has been recorded;
  // absence never authorizes anything by itself. Preserved across workflow.reset_run.
  //
  // T15.5 (2026-08-25, ADR-2026-08-25-publish-autonomy §2.2, invariant 4) — NOTHING but this setter
  // ever writes this field, in ANY mode, including "autonomous": autonomy is resolved at
  // gate-evaluation time from publishingPolicySnapshot below and is NEVER stamped here. A policy
  // default that fabricates an operator record ("operatorDefault" pre-T15.5) is the exact defect
  // this invariant closes.
  operatorPublishDecision?: "approved" | "withheld";
  // T2 (2026-08-13, run_1786557897658_elj34j) — WHICH source wrote operatorPublishDecision.
  // "explicit" is the ONLY source the setter ever writes (T15.5 removed the one other writer,
  // applyOperatorPublishPolicyDefault). "project_policy_default" is LEGACY ONLY: a run persisted
  // before T15.5 whose operatorPublishDecision was pre-seeded "approved" by the owning project's
  // now-removed publishingPolicy.operatorDefault. "policy_autonomous" is reserved for the same
  // reason — a run's OWN operatorDecisionSource can in practice never carry it (invariant 4 keeps
  // operatorPublishDecision itself absent under autonomy, so there is nothing here to describe), but
  // the literal is kept legal so a legacy or foreign record naming it fails no stricter than any
  // other known source. The autonomous-authorization story lives on the GATE/RECEIPT side instead —
  // see publishDecision.PublishAuthority and publishExecution.ts's publishAuthority receipt field.
  // Absent alongside a present operatorPublishDecision means the record predates this field and is
  // treated as "explicit" (publishDecision.ts describeOperatorDecisionSource), since explicit was
  // the only source that ever existed then.
  operatorDecisionSource?: "explicit" | "project_policy_default" | "policy_autonomous";
  // T15.5 (2026-08-25, ADR-2026-08-25-publish-autonomy §2.5) — the publishing-policy facts this run
  // needs to resolve publish authority IDENTICALLY on every re-evaluation, captured ONCE at run
  // creation (executor.ts buildInitialRun / startDryRun) and preserved across workflow.reset_run
  // exactly like operatorPublishDecision above. publishDecision.resolvePublishAuthority reads ONLY
  // this snapshot for autonomyMode — never a live project read — so a policy edit made after a run
  // starts can never change that run's resolution, and two runs of the same URL resolve identically
  // (invariant 7). Absent (a run predating T15.5) resolves autonomyMode as "operator-gated" — today's
  // behavior, unchanged.
  publishingPolicySnapshot?: PublishingPolicySnapshot;
  // T15.6 (2026-08-25, ADR-2026-08-25-publish-autonomy §4.3) — release_executor's idempotency ledger,
  // keyed by `${runId}:${requestId}` (releaseExecution.ts releaseLedgerKey). THE correctness property
  // this exists for: once release_executor has reached a TERMINAL answer for a key (skipped, executed,
  // or a real failure), it never calls release_to_production or deploy_status again for that key — a
  // retry, a stale-dispatch reclaim, or a continuation tick all get the SAME result back. Deliberately
  // its OWN field, separate from stageOutputs/node.output: retryNode clears those on a node retry, and
  // a release must stay released across a retry of the node that reports it. A "pending" entry means
  // release_to_production already succeeded (so it is never called again) but deploy_status has not
  // yet confirmed — the next dispatch polls once more rather than re-releasing.
  releaseLedger?: Record<string, ReleaseLedgerEntry>;
};

// T15.6 (2026-08-25, ADR-2026-08-25-publish-autonomy §4.3) — see WorkflowExecutionRecord.releaseLedger
// above and releaseExecution.ts for the module that reads and writes it.
export type ReleaseLedgerEntry =
  | { status: "terminal"; requestId: string; performedAt: string; output: Record<string, unknown> }
  | { status: "pending"; requestId: string; performedAt: string; releaseId?: string; deployedSha?: string; attempts: number };

// T15.5 (2026-08-25, ADR-2026-08-25-publish-autonomy §2.5) — see WorkflowExecutionRecord.
// publishingPolicySnapshot above. `publishEnabled` rides along for audit/UI completeness (ADR §2.5's
// parenthetical); the actual publishEnabled/env-kill-switch gate stays a LIVE read (publisher.ts
// isProjectPublishEnabled) by design, because a kill-switch a snapshot could stale is not a
// kill-switch.
export type PublishingPolicySnapshot = {
  autonomyMode: "autonomous" | "operator-gated";
  publishEnabled: boolean;
  // T15.11 (2026-08-25, #190; ADR-2026-08-25-publish-autonomy §6.3) — this run's CHARTERED
  // publishable object types, resolved from publishableTypeCharter.resolvePublishableTypeCharter(run.
  // workflowId) and captured here ONCE at run creation, for the identical determinism reason
  // autonomyMode is snapshotted above: buildObjectPublishPlan (objectPublishExecution.ts) reads ONLY
  // this field, never the live charter, so a code-level charter change landing between run creation
  // and publish_payload's dispatch can never alter an in-flight run's outcome (invariant 7). Absent
  // only for a run that predates T15.11; buildObjectPublishPlan falls back to its own
  // OBJECT_PUBLISHABLE_TYPES default (page, navigation) in that case — today's exact pre-T15.11
  // behavior, unchanged.
  publishableTypes?: readonly string[];
};
