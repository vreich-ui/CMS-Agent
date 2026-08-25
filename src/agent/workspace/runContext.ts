// W3 part 3 (determinism program, 2026-08-12) — run-level client context, injected once by the
// conductor instead of echoed through six nodes' prompts and outputs.
//
// WHY THIS EXISTS. `clientProjectId`, `clientObjectType` and `contractSource` are RUN FACTS: the
// first is run.projectId, the other two are whatever the contract prefetch actually fetched. Yet six
// nodes carry them as model-typed prose — contract_intelligence, article_body, artifact_plan,
// publish_payload and publish_executor name all three in their prompt AND their output schema, and
// publication_controller reads contractSource in its prompt. Every one of those echoes is a chance
// for a model to retype a fact the engine already holds exactly: a truncated fingerprint, a
// pluralized object type, a contractSource re-typed as prose instead of carried as the provenance
// object it is. The live symptom was cheap to see (article_body's envelope re-typed downstream at
// publish_payload for $2.73) and expensive to trust.
//
// WHAT THIS DOES. Two halves of the same idea:
//   1. buildRunContext + renderRunContextInstruction — the facts are assembled ONCE per dispatch and
//      delivered to every node, in the node's input (`runContext`) and as a compact block in the
//      runner's system instructions. A node no longer has to reconstruct them from a dependency's
//      output, and a node with no contract dependency at all can still name its client correctly.
//   2. applyRunContextEnvelope — where a node's OWN output schema still declares these fields (this
//      PR deliberately does NOT remove them; that is a re-seed topology change), the ENGINE fills
//      them from run context after the model returns. The engine's value wins: it is the same value
//      the prefetch fetched, so a model that retyped it was, at best, right by accident.
//
// WHAT THIS DOES NOT DO. It never invents a value. A field is filled only when the run genuinely
// knows it (prefetched contract, or the deterministic contract_intelligence artifact that was built
// from that prefetch); an unknown field is left exactly as the model emitted it, so a node whose
// schema requires it still fails R-16 rather than passing on an engine-fabricated envelope.
import type { ReducedContract } from "./contractReduction.js";

export type RunContext = {
  clientProjectId: string;
  clientObjectType?: string;
  contractSource?: Record<string, unknown>;
  requestId?: string;
  // Policies the ENGINE is enforcing for THIS dispatch, stated to the model so it does not spend its
  // own budget doing something the conductor has already taken over (W3: article_body's validator
  // loop). Delivered here rather than written into the node's seeded prompt on purpose — the live
  // workspace is store-sourced, so a seed-only prompt edit would not reach a real run until a
  // re-seed, while the engine's own behaviour changes the moment this code ships. The prompt and the
  // behaviour therefore cannot drift apart: the same code that runs the loop says that it runs it.
  enginePolicies?: string[];
  // T2 (2026-08-13, run_1786557897658_elj34j) — THE live bug this field fixes. run.operatorPublishDecision
  // is set via workflow.set_operator_publish_decision (or, now, a project's publishingPolicy.operatorDefault
  // at run creation), but before this it was never echoed into a node's OWN run context — only the
  // executor's pre-dispatch guard (executor.ts) and publisher.ts read it directly off the run record. On
  // run_1786557897658_elj34j the publish_executor node's model dispatch had no way to see the field at
  // all and incorrectly claimed it was absent when it was actually set. Echoing it here (present only when
  // the run actually has a decision — never invented) is what lets any node's OWN reasoning agree with the
  // engine's gates instead of re-deriving (or mis-deriving) the same fact blind.
  operatorPublishDecision?: "approved" | "withheld";
  // WHICH source produced operatorPublishDecision — see publishDecision.describeOperatorDecisionSource.
  // Present only alongside operatorPublishDecision, so a node can distinguish an explicit operator act
  // from a standing project default without guessing.
  operatorDecisionSource?: "explicit" | "project_policy_default";
};

export const RUN_CONTEXT_ENVELOPE_FIELDS = ["clientProjectId", "clientObjectType", "contractSource"] as const;
export type RunContextEnvelopeField = (typeof RUN_CONTEXT_ENVELOPE_FIELDS)[number];

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export type BuildRunContextParams = {
  clientProjectId: string;
  // Engine-owned policies for THIS dispatch (see RunContext.enginePolicies). Empty for the nodes the
  // engine has taken nothing over for, and therefore absent from their instructions entirely.
  enginePolicies?: string[];
  // This dispatch's own prefetch, when the node declared one — the freshest and most authoritative
  // source, because it is the fetch the run actually performed.
  reducedContract?: Pick<ReducedContract, "clientObjectType" | "contractSource"> | undefined;
  // Every completed stage output of the run. Only contract_intelligence is read: it is the node whose
  // artifact IS the contract envelope (and, since Session D, is itself built deterministically from
  // the same prefetch), so reading it is reading the prefetch one hop later — not trusting an
  // arbitrary node's retyping.
  stageOutputs?: Record<string, unknown> | undefined;
  // T2 — echoed verbatim from run.operatorPublishDecision / run.operatorDecisionSource. See
  // RunContext.operatorPublishDecision for why this exists.
  operatorPublishDecision?: "approved" | "withheld";
  operatorDecisionSource?: "explicit" | "project_policy_default";
  // S3 (2026-08-25, run_1787656120374_18bobg) — the run's own stored publish request id, echoed
  // verbatim from WorkflowExecutionRecord.publishRequestId, used ONLY as the fallback below when no
  // node authored one. Deliberately NOT WorkflowExecutionRecord.requestId: see the comment on the
  // fallback in buildRunContext, and executionTypes.ts, which says in as many words that the two
  // identifiers are different things.
  publishRequestId?: string;
};

export function buildRunContext(params: BuildRunContextParams): RunContext {
  const context: RunContext = { clientProjectId: params.clientProjectId };
  if (params.enginePolicies?.length) context.enginePolicies = params.enginePolicies;

  // The PUBLISH request id (req_<flow>_<topic>_<yyyymmdd>_<nn>), authored once by artifact_plan and
  // copied downstream by publish_payload and publish_executor today. Deliberately NOT
  // WorkflowExecutionRecord.requestId, which is the platform/workspace join key (executionTypes.ts
  // says so in as many words) — conflating the two would put the wrong identifier on a publish.
  //
  // TWO SOURCES, IN THIS ORDER, AND NEVER A THIRD.
  //   1. stageOutputs.artifact_plan.requestId — the AUTHORED id. Unchanged, and always first: a run
  //      whose artifact_plan really ran and really named an id publishes under that id, full stop.
  //   2. params.publishRequestId — S3 (2026-08-25, run_1787656120374_18bobg). The id the operator
  //      supplied at workflow.start_dry_run, stored on the run as its own field.
  //
  // WHY (2) EXISTS. `workflow.start_dry_run` supports a late-stage entrypoint (`entrypoint:
  // "article_body"` plus a supplied `articleBody`) that seeds the entry node and every ancestor as
  // completed so the run skips ideation/research/drafting — the cheap path for exercising publish
  // mechanics without burning tokens. artifact_plan is one of those ancestors, and it is seeded as
  // `{seeded:true, skipped:true, reason:"late_stage_entry"}` with no stage output at all, so source
  // (1) is empty for such a run BY CONSTRUCTION and the run was structurally incapable of publishing:
  // on run_1787656120374_18bobg (dr-lurie) the controller said "go", the operator said "approved",
  // all five publisher gates passed, and publish_executor still refused with
  // publish_request_id_absent because nothing in the run held an id.
  //
  // WHY THE FALLBACK LIVES HERE AND NOT AT THE PUBLISHER. runContext.requestId is already the ONE
  // lift point for this id: the executor passes it to publish_payload's deterministic builder and to
  // publish_executor's engine path, and renders it into every node's instructions. Resolving the
  // fallback at the publisher instead would fix only the publisher — the run context would stay
  // empty, so publish_payload would keep emitting a payload with its optional `requestId` field
  // missing, and the publish candidate an operator reviews would not name the id the publish is
  // actually made under. One lift point, one answer, every consumer.
  //
  // AND NEVER run.requestId. That field is the platform/workspace join key; falling back to it would
  // stamp the wrong identifier on a live client object, which is worse than not publishing. Absent
  // stays absent here — publish_executor's publish_request_id_absent refusal is the correct outcome
  // for a run nobody gave an id to, and nothing in this file mints one.
  const plan = params.stageOutputs?.artifact_plan;
  if (isObject(plan) && nonEmptyString(plan.requestId)) context.requestId = plan.requestId.trim();
  else if (nonEmptyString(params.publishRequestId)) context.requestId = params.publishRequestId.trim();

  const prefetched = params.reducedContract;
  if (prefetched && nonEmptyString(prefetched.clientObjectType)) context.clientObjectType = prefetched.clientObjectType;
  if (prefetched && isObject(prefetched.contractSource)) context.contractSource = prefetched.contractSource;

  const intelligence = params.stageOutputs?.contract_intelligence;
  if (isObject(intelligence)) {
    if (context.clientObjectType === undefined && nonEmptyString(intelligence.clientObjectType)) context.clientObjectType = intelligence.clientObjectType;
    if (context.contractSource === undefined && isObject(intelligence.contractSource)) context.contractSource = intelligence.contractSource;
  }
  // T2 — echoed only when the run actually has a decision (never invented, same discipline as every
  // other field here). This is what fixes run_1786557897658_elj34j: the field existed on the run
  // record all along, it just never reached a node's own input.
  if (params.operatorPublishDecision !== undefined) {
    context.operatorPublishDecision = params.operatorPublishDecision;
    if (params.operatorDecisionSource !== undefined) context.operatorDecisionSource = params.operatorDecisionSource;
  }
  return context;
}

// The runners' view of the context: it arrives inside the node's delivered input (the executor puts
// it there), so a runner reads it back rather than being handed a second, separately-plumbed copy
// that could disagree with what the node was actually given.
export const readRunContext = (input: unknown): RunContext | undefined => {
  if (!isObject(input)) return undefined;
  const context = input.runContext;
  return isObject(context) && nonEmptyString(context.clientProjectId) ? (context as RunContext) : undefined;
};

// The prompt-side half. Deliberately compact: this text is paid for on EVERY turn of EVERY node's
// agent loop, so it states the facts and the one rule that matters (do not re-derive them), and it
// summarizes contractSource by its provenance keys rather than inlining the whole object — the full
// object already travels in the node's input, where it costs one serialization, not one per turn.
export function renderRunContextInstruction(context: RunContext | undefined): string {
  if (!context) return "";
  const source = context.contractSource;
  const provenance = isObject(source)
    ? [nonEmptyString(source.tool) ? `tool=${source.tool}` : "", nonEmptyString(source.fetchedAtISO) ? `fetchedAt=${source.fetchedAtISO}` : "", nonEmptyString(source.fingerprint) ? `fingerprint=${source.fingerprint}` : ""].filter(Boolean).join(", ")
    : "";
  return [
    "Run context (established by the conductor for this run — authoritative, do not re-derive, re-fetch, or restate differently):",
    `- clientProjectId: ${context.clientProjectId}`,
    context.clientObjectType ? `- clientObjectType: ${context.clientObjectType}` : "- clientObjectType: not yet established for this run",
    context.contractSource ? `- contractSource: delivered in your input under runContext.contractSource${provenance ? ` (${provenance})` : ""}` : "- contractSource: not yet established for this run",
    ...(context.requestId ? [`- requestId: ${context.requestId}`] : []),
    // T2 (run_1786557897658_elj34j) — stated explicitly so a publish-risk node's own reasoning never
    // has to guess or claim absence: this is the SAME fact the engine's publish gates already read.
    ...(context.operatorPublishDecision ? [`- operatorPublishDecision: ${context.operatorPublishDecision} (source: ${context.operatorDecisionSource ?? "explicit"})`] : []),
    "These values are carried onto your output by the engine where your schema declares them; you do not need to spend a turn copying them from a dependency.",
    ...(context.enginePolicies?.length ? ["Engine-owned for this dispatch (do not do these yourself):", ...context.enginePolicies.map((policy) => `- ${policy}`)] : [])
  ].join("\n");
}

export type RunContextEnvelopeResult = {
  output: unknown;
  // Fields the engine wrote because the model omitted them — the echo it no longer has to perform.
  filled: RunContextEnvelopeField[];
  // Fields the model DID emit but differently from the run's own fact. These are the interesting
  // ones: a corrected field is direct evidence of the retyping defect this workstream exists to end,
  // so the caller stamps a run-visible warning rather than silently winning the disagreement.
  corrected: RunContextEnvelopeField[];
};

const declaresProperty = (outputSchema: unknown, field: string): boolean => {
  if (!isObject(outputSchema)) return false;
  const properties = outputSchema.properties;
  return isObject(properties) && Object.prototype.hasOwnProperty.call(properties, field);
};

// Engine-echo of the envelope fields onto a model-produced output. Applied to whatever a node
// emitted, immediately before the executor's R-16 output-schema gate, so a node whose schema REQUIRES
// these fields is satisfied by the engine's value rather than by the model's memory of it.
export function applyRunContextEnvelope(output: unknown, context: RunContext | undefined, outputSchema: unknown): RunContextEnvelopeResult {
  if (!context || !isObject(output)) return { output, filled: [], corrected: [] };
  const filled: RunContextEnvelopeField[] = [];
  const corrected: RunContextEnvelopeField[] = [];
  let next: Record<string, unknown> | undefined;
  for (const field of RUN_CONTEXT_ENVELOPE_FIELDS) {
    const value = context[field];
    if (value === undefined) continue;
    if (!declaresProperty(outputSchema, field)) continue;
    const emitted = (output as Record<string, unknown>)[field];
    if (emitted === undefined) filled.push(field);
    else if (JSON.stringify(emitted) !== JSON.stringify(value)) corrected.push(field);
    else continue;
    next = next ?? { ...(output as Record<string, unknown>) };
    next[field] = value;
  }
  return { output: next ?? output, filled, corrected };
}
