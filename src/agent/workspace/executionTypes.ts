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
export type NodeDispatchClaim = { dispatchedAt: string; timeoutMs: number };

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
export type ApprovalRequired = {
  nodeId: string;
  type: "approval_required";
  reason: string;
  requestedAt: string;
  pending?: boolean;
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
  status: ExecutionStatus;
  currentNodeId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  nodes: NodeExecutionState[];
  artifacts: ExecutionArtifact[];
  errors: string[];
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
  // ONLY through publishDecision.isOperatorPublishWithheld / isOperatorPublishApproved, consumed by
  // publishRun's "operator_not_withheld" gate and the executor's publish-risk dispatch guard.
  // "withheld" is a durable operator veto: it blocks workflow.publish_run and every publish-risk
  // node regardless of approved/live flags until the operator replaces it. "approved" is the durable
  // operator approval an "executed" publish_execution.v1 claim must match (its approvalMatched
  // field refers to exactly this record). Absent means no operator decision has been recorded;
  // absence never authorizes anything by itself. Preserved across workflow.reset_run.
  operatorPublishDecision?: "approved" | "withheld";
  // T2 (2026-08-13, run_1786557897658_elj34j) — WHICH source wrote operatorPublishDecision.
  // "explicit" is the ONLY source that existed before this field: an operator's own
  // workflow.set_operator_publish_decision call. "project_policy_default" means run creation applied
  // the owning project's publishingPolicy.operatorDefault === "approved" (executor.ts
  // applyOperatorPublishPolicyDefault) — nobody made an explicit call for THIS run. The setter always
  // writes "explicit", so a later explicit call (approved OR withheld) overwrites a policy default's
  // source along with its decision; a withheld veto is source "explicit" by construction — the
  // policy default never produces "withheld". Absent alongside a present operatorPublishDecision
  // means the record predates this field and is treated as "explicit" (publishDecision.ts
  // describeOperatorDecisionSource), since explicit was the only source that ever existed then.
  operatorDecisionSource?: "explicit" | "project_policy_default";
};
