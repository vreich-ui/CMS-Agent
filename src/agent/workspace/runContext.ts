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
};

export function buildRunContext(params: BuildRunContextParams): RunContext {
  const context: RunContext = { clientProjectId: params.clientProjectId };
  if (params.enginePolicies?.length) context.enginePolicies = params.enginePolicies;

  // The PUBLISH request id (req_<flow>_<topic>_<yyyymmdd>_<nn>), authored once by artifact_plan and
  // copied downstream by publish_payload and publish_executor today. Deliberately NOT
  // WorkflowExecutionRecord.requestId, which is the platform/workspace join key (executionTypes.ts
  // says so in as many words) — conflating the two would put the wrong identifier on a publish.
  const plan = params.stageOutputs?.artifact_plan;
  if (isObject(plan) && nonEmptyString(plan.requestId)) context.requestId = plan.requestId.trim();

  const prefetched = params.reducedContract;
  if (prefetched && nonEmptyString(prefetched.clientObjectType)) context.clientObjectType = prefetched.clientObjectType;
  if (prefetched && isObject(prefetched.contractSource)) context.contractSource = prefetched.contractSource;

  const intelligence = params.stageOutputs?.contract_intelligence;
  if (isObject(intelligence)) {
    if (context.clientObjectType === undefined && nonEmptyString(intelligence.clientObjectType)) context.clientObjectType = intelligence.clientObjectType;
    if (context.contractSource === undefined && isObject(intelligence.contractSource)) context.contractSource = intelligence.contractSource;
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
