// W2b (determinism program, 2026-08-12; docs/plan/WORK-ORDER-2026-08-12-determinism.md) — the
// deterministic learning_recorder.
//
// WHY THIS EXISTS. learning_recorder's job is to write down what the run DID: which nodes ran, which
// were blocked or failed, what the publish gate decided, what it cost. Every one of those is a
// structured fact already sitting on the run record and the usage ledger — the node was paying a model
// to read them back and paraphrase them, which is both a cost line and an accuracy risk (a paraphrase
// can be wrong about a fact the record states exactly).
//
// FULLY TEMPLATED. No model call, and no nano-model free-text field either (the work order lists that
// as optional; a templated observation set that is exactly true beats a fluent one that might not be).
// Every string this module emits is derived from a value on the run record or the usage summary.
//
// The gate events are the point of the record: the publication decision (with its blockers and any
// blockers WAIVED under the standing own-property rule — W6.1's audit trail lands here too), the
// operator's durable publish decision, the publish executor's status, approval holds, and budget
// halts. Those are the facts an operator or a later analysis actually goes looking for.
//
// SAFETY. Same contract as every other deterministic path: the caller validates the built record
// against the node's OWN outputSchema and falls through to the model dispatch on any failure.

import type { ModelUsageSummary } from "../observability/modelUsageTypes.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "./executionTypes.js";

export const LEARNING_OBSERVATIONS_ARTIFACT = "learning_observations.v1";

export type NodeRunFact = {
  nodeId: string;
  status: ExecutionStatus;
  durationMs?: number;
  costUsdEstimate?: number;
  warnings?: string[];
  errors?: string[];
  // True when the node completed with no usage record at all — i.e. it ran on a deterministic engine
  // path (contract_intelligence, placement_resolver, publish_payload, publication_controller,
  // publish_executor's refusal, this node) and cost $0. The determinism program's own scoreboard.
  deterministic?: boolean;
};

export type GateEventFact = { event: string; detail: string };

export type LearningObservationsOutput = {
  artifact: typeof LEARNING_OBSERVATIONS_ARTIFACT;
  summary: string;
  runId: string;
  runStatus: ExecutionStatus;
  observations: string[];
  nodeFacts: NodeRunFact[];
  gateEvents: GateEventFact[];
  cost: { actualUsd: number | null; estimatedUsd: number | null; totalUsd: number | null; recordCount: number | null; source: string };
  blockers: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  notes: string[];
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter(nonEmptyString).map((entry) => entry.trim()) : []);

const round2 = (value: number): number => Math.round(value * 100) / 100;

// Per-node facts in the run record's own node order (which is the conductor's canonical order), with
// the usage ledger's per-node cost joined on. A node with no usage record and a completed status is
// reported as deterministic — that is a FACT of the ledger, not an inference about how it ran.
export function buildNodeFacts(run: Pick<WorkflowExecutionRecord, "nodes">, usage?: ModelUsageSummary): NodeRunFact[] {
  return run.nodes
    .filter((node) => node.status !== "queued")
    .map((node) => {
      const bucket = usage?.byNode?.[node.nodeId];
      return {
        nodeId: node.nodeId,
        status: node.status,
        ...(node.durationMs === undefined ? {} : { durationMs: node.durationMs }),
        ...(bucket ? { costUsdEstimate: round2(bucket.costUsdEstimate) } : {}),
        ...(node.warnings?.length ? { warnings: [...node.warnings] } : {}),
        ...(node.errors?.length ? { errors: [...node.errors] } : {}),
        ...(usage && !bucket && node.status === "completed" ? { deterministic: true } : {})
      };
    });
}

// The gate events, in the order they matter to an operator reading the record cold.
export function buildGateEvents(run: Pick<WorkflowExecutionRecord, "stageOutputs" | "approvalsRequired" | "operatorPublishDecision" | "budgetBlock">): GateEventFact[] {
  const events: GateEventFact[] = [];

  const decision = run.stageOutputs?.publication_controller;
  if (isObject(decision)) {
    const value = nonEmptyString(decision.decision) ? decision.decision : "(no decision field)";
    const blockers = stringArray(decision.blockers);
    events.push({ event: "publication_decision", detail: `publication_controller decided ${JSON.stringify(value)} with ${blockers.length} blocker(s)${blockers.length ? `: ${blockers.join(" | ")}` : ""}.` });
    // W6.1 audit trail: a waiver that is not written down is not a waiver.
    const waived = Array.isArray(decision.waivedBlockers) ? decision.waivedBlockers : [];
    if (waived.length) {
      const described = waived.map((entry) => (isObject(entry) ? `${String(entry.nodeId ?? "unknown")}: ${String(entry.blocker ?? "")} [rule ${String(entry.rule ?? "unnamed")}]` : String(entry)));
      events.push({ event: "blockers_waived", detail: `${waived.length} blocker(s) waived by standing rule and recorded on the decision: ${described.join(" | ")}.` });
    }
    // W7 (2026-08-25) audit trail, same principle one class over: an editorial blocker that did NOT
    // stop the publish is exactly the thing an operator reading the record cold needs to see, because
    // it is the one class of objection the decision deliberately declined to enforce. Silently absent
    // from the run record, "advisory" would be indistinguishable from "dropped".
    const advisories = Array.isArray(decision.advisories) ? decision.advisories : [];
    if (advisories.length) {
      const described = advisories.map((entry) => (isObject(entry) ? `${String(entry.nodeId ?? "unknown")}: ${String(entry.blocker ?? "")}` : String(entry)));
      events.push({ event: "blockers_advisory", detail: `${advisories.length} editorial blocker(s) recorded as advisory and deliberately not gating (blockerClassification.ts): ${described.join(" | ")}.` });
    }
    if (nonEmptyString(decision.contentClass)) events.push({ event: "content_class", detail: `Run content class: ${decision.contentClass}.` });
  } else {
    events.push({ event: "publication_decision", detail: "no publication_controller decision record exists on this run (the run did not reach the controller, or it produced no stage output)." });
  }

  events.push({
    event: "operator_publish_decision",
    detail: run.operatorPublishDecision
      ? `run.operatorPublishDecision is ${JSON.stringify(run.operatorPublishDecision)} (set via workflow.set_operator_publish_decision).`
      : "run.operatorPublishDecision is absent; absence never authorizes a publish."
  });

  const execution = run.stageOutputs?.publish_executor;
  if (isObject(execution)) {
    const blockers = stringArray(execution.blockers);
    events.push({ event: "publish_execution", detail: `publish_executor reported status ${JSON.stringify(execution.status ?? null)}, approvalMatched ${JSON.stringify(execution.approvalMatched ?? null)}${blockers.length ? `, blockers: ${blockers.join(" | ")}` : ""}.` });
  } else {
    events.push({ event: "publish_execution", detail: "publish_executor produced no stage output on this run (refused upstream, never reached, or publishing happened outside node execution)." });
  }

  for (const approval of run.approvalsRequired ?? []) {
    events.push({ event: approval.pending ? "approval_pending" : "approval_required", detail: `${approval.nodeId}: ${approval.reason}` });
  }
  if (run.budgetBlock) {
    events.push({ event: "budget_halt", detail: `${run.budgetBlock.reason} (ceiling $${run.budgetBlock.budgetUsd}, spent $${run.budgetBlock.spentUsdEstimate}${run.budgetBlock.nextNodeId ? `, next node ${run.budgetBlock.nextNodeId}` : ""}).` });
  }
  return events;
}

// Every blocker the run's own stage outputs carry, named with the node that raised it. Deliberately
// NOT de-duplicated against the publication decision's own list: this node records what each node
// said, and the decision record separately records what the controller did about it.
export function collectRunBlockers(run: Pick<WorkflowExecutionRecord, "nodes" | "stageOutputs">): string[] {
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const node of run.nodes) {
    const output = run.stageOutputs?.[node.nodeId] ?? node.output;
    if (!isObject(output)) continue;
    for (const blocker of stringArray(output.blockers)) {
      const key = `${node.nodeId}:${blocker.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blockers.push(`${node.nodeId}: ${blocker}`);
    }
  }
  return blockers;
}

export type LearningRecordSources = {
  run: Pick<WorkflowExecutionRecord, "runId" | "status" | "nodes" | "stageOutputs" | "approvalsRequired" | "operatorPublishDecision" | "budgetBlock" | "errors">;
  // Omitted when the usage ledger could not be read; cost fields then report null (never zero — an
  // unread ledger is "unknown", and conflating it with "$0" is exactly the fabrication class this
  // program exists to remove).
  usage?: ModelUsageSummary;
  usageError?: string;
};

export function buildLearningObservations(sources: LearningRecordSources): LearningObservationsOutput {
  const { run, usage } = sources;
  const nodeFacts = buildNodeFacts(run, usage);
  const gateEvents = buildGateEvents(run);
  const blockers = collectRunBlockers(run);

  const completed = nodeFacts.filter((fact) => fact.status === "completed");
  const failed = nodeFacts.filter((fact) => fact.status === "failed");
  const blocked = nodeFacts.filter((fact) => fact.status === "blocked");
  const deterministic = nodeFacts.filter((fact) => fact.deterministic);
  const warned = nodeFacts.filter((fact) => (fact.warnings?.length ?? 0) > 0);

  const cost = usage
    ? { actualUsd: round2(usage.actualCostUsdEstimate), estimatedUsd: round2(usage.estimatedCostUsdEstimate), totalUsd: round2(usage.totalCostUsdEstimate), recordCount: usage.recordCount, source: "usage ledger (summarizeModelUsage over this runId) — measured, never estimated by a model" }
    : { actualUsd: null, estimatedUsd: null, totalUsd: null, recordCount: null, source: `usage ledger unavailable (${sources.usageError ?? "no reason reported"}); cost is reported as unknown rather than as zero` };

  const observations = [
    `Run ${run.runId} ended with status ${run.status}: ${completed.length} node(s) completed, ${blocked.length} blocked, ${failed.length} failed, of ${nodeFacts.length} that were dispatched or seeded.`,
    ...(usage
      ? [`Measured model spend for this run: $${cost.actualUsd} actual + $${cost.estimatedUsd} estimated across ${usage.recordCount} usage record(s). ${deterministic.length} completed node(s) produced NO usage record at all — they ran on deterministic engine paths at $0.`]
      : [`Model spend could not be read from the usage ledger (${sources.usageError ?? "no reason reported"}); no cost figure is asserted here.`]),
    ...failed.map((fact) => `Node ${fact.nodeId} FAILED: ${(fact.errors ?? ["no error recorded"]).join("; ")}.`),
    ...blocked.map((fact) => `Node ${fact.nodeId} was BLOCKED — an expected safety state when a gate refuses, not a defect by itself.`),
    ...warned.map((fact) => `Node ${fact.nodeId} carried warning(s): ${(fact.warnings ?? []).join("; ")}.`),
    ...(run.errors?.length ? [`Run-level errors recorded: ${run.errors.join("; ")}.`] : []),
    ...gateEvents.map((event) => `[${event.event}] ${event.detail}`)
  ];

  const summary =
    `Deterministic run record for ${run.runId} (status ${run.status}): ${completed.length}/${nodeFacts.length} node(s) completed, ` +
    `${blocked.length} blocked, ${failed.length} failed, ${blockers.length} blocker(s) raised upstream, ${gateEvents.length} gate event(s), ` +
    `spend ${usage ? `$${cost.actualUsd} actual` : "unknown (ledger unavailable)"}. Templated from the run record and the usage ledger. No model call.`;

  return {
    artifact: LEARNING_OBSERVATIONS_ARTIFACT,
    summary,
    runId: run.runId,
    runStatus: run.status,
    observations,
    nodeFacts,
    gateEvents,
    cost,
    blockers,
    assumptions: [
      "Every statement here is a value read from the run record or the model-usage ledger; nothing is inferred, summarized by a model, or estimated.",
      "A completed node with no usage record is reported as having run deterministically — that is a property of the ledger, which deterministic engine paths deliberately never write to (the R-20 rule: a $0 event stays $0).",
      "Blocked nodes are recorded as safety states, not failures: the publish gates are designed to refuse."
    ],
    unresolvedQuestions: [
      ...(failed.length ? [`Why did ${failed.map((fact) => fact.nodeId).join(", ")} fail? The record carries the error codes; root cause is not inferable from the run record alone.`] : []),
      ...(blockers.length ? ["Which of the upstream blockers recorded here are systematic (a schema/contract gap) versus specific to this request? Not decidable from one run."] : []),
      ...(usage ? [] : ["What did this run cost? The usage ledger was unreadable at record time."])
    ],
    notes: [
      "Recorded deterministically by the conductor (learningRecord.ts): fully templated over structured run facts — stage outputs, node statuses, durations, warnings, gate events and the measured usage ledger. No model call, no free-text generation.",
      "Gate events are the audited part of this record: the publication decision and any blockers waived under a standing rule are written down verbatim here as well as on the decision itself, so the waiver survives even if the decision record is later re-read out of context."
    ]
  };
}
