// W6 item 3 (determinism program, 2026-08-12) — THE RESOLVED VECTOR IS ENGINE-COMPUTED.
//
// THE LIVE DEFECT. `resolved` + `resolvedBasis` are required on article_brief.v1, and the run that
// introduced them (run_1786468126136_ev9goe) shipped `resolved` UNCLAMPED: the contract prefetch runs
// on contract_intelligence, which sits AFTER brief_architect in the conductor sequence, so at the
// moment the brief was written no client ceiling existed anywhere in the run. The model filled the
// required field from the only vector it could see — the target — and the aggression_ceiling blocker
// was raised later, after the draft had already been written against an over-aggressive brief. The
// defect is not that the model lied; it is that the engine ASKED A MODEL for an arithmetic result it
// owns: resolved = min(ceiling, target), componentwise, every time, forever.
//
// WHAT THIS MODULE DOES. Wherever a node emits `resolved`, the engine recomputes it from the run's
// own facts and OVERWRITES what the model emitted, then rewrites `resolvedBasis` to say exactly what
// it computed from. A model value that already agreed is left byte-identical (no warning, no churn);
// a model value that disagreed is corrected and the disagreement is named as a run-visible warning,
// because a model emitting a resolved vector that is not min(ceiling, target) is the exact defect
// this exists to end.
//
// WHAT IT REFUSES TO DO. It never invents a ceiling. With no ceiling in the run there is nothing to
// clamp against, so the model's value is LEFT AS IT IS and a loud warning
// (`resolved_vector_unclamped:no_ceiling`) is stamped — the same loud-degradation convention
// contract_prefetch_failed uses. Silently deleting the field would fail the node's own schema on a
// defect the node did not cause; silently trusting it is what happened last time. The correct fix for
// that state is upstream (a contract that declares aggression_ceiling, and the prefetch running
// before the brief) — this module makes the absence visible rather than papering over it.
//
// TARGET FALLBACK. With a ceiling but no placement target (a run that never resolved a placement),
// the clamp still enforces the half it can prove: resolved ≤ ceiling, treating the model's own vector
// as the target. Weaker than min(ceiling, target) and recorded as such in the basis — but a resolved
// vector above the client's declared ceiling can never be correct, whatever the target was.
import { AGGRESSION_DIALS, type AggressionDial, type AggressionVector } from "./aggressionVector.js";

export type ResolvedVectorSources = {
  ceiling?: AggressionVector;
  target?: AggressionVector;
  // Where each vector came from, for the audit line. Free text: it is read by humans, not parsed.
  ceilingSource?: string;
  targetSource?: string;
};

export type ResolvedVectorClampResult = {
  output: unknown;
  // true when the engine wrote a `resolved` different from what the model emitted (or wrote one the
  // model omitted entirely).
  corrected: boolean;
  // Dials where the ceiling actually bit — resolved < target. Empty when the target was already under
  // the ceiling everywhere (still engine-computed, just numerically identical).
  clampedDials: AggressionDial[];
  // Warning codes for the node's execution record. Empty on a clean engine computation.
  warnings: string[];
  // The vector the engine wrote, absent when it could not compute one.
  resolved?: AggressionVector;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const readVector = (value: unknown): AggressionVector | undefined => {
  if (!isObject(value)) return undefined;
  const dials = AGGRESSION_DIALS.map((dial) => [dial, value[dial]] as const);
  if (!dials.every(([, dialValue]) => typeof dialValue === "number" && Number.isFinite(dialValue) && dialValue >= 0 && dialValue <= 1)) return undefined;
  return Object.fromEntries(dials) as AggressionVector;
};

// Does this output carry a resolved aggression vector at all? Keyed on the OUTPUT (and, secondarily,
// on the node's schema) rather than on a node id, because `resolved` is a field of article_brief.v1
// — whichever node emits that artifact owns the clamp, and the live schema that requires the field
// lives in the store, not in the code seed.
export function declaresResolvedVector(output: unknown, outputSchema?: unknown): boolean {
  if (isObject(output) && output.resolved !== undefined) return true;
  const properties = isObject(outputSchema) ? outputSchema.properties : undefined;
  return isObject(properties) && Object.prototype.hasOwnProperty.call(properties, "resolved");
}

// The declared JSON type of `resolvedBasis` on the node's own schema, so the engine writes a basis the
// node's schema accepts rather than a shape that would fail R-16 one line later. Unknown/undeclared
// defaults to a prose string, which is what every hand-written version of this field has been.
type BasisShape = "string" | "object" | "array";
const basisShapeOf = (outputSchema: unknown, emitted: unknown): BasisShape => {
  const properties = isObject(outputSchema) ? outputSchema.properties : undefined;
  const declared = isObject(properties) ? properties.resolvedBasis : undefined;
  const declaredType = isObject(declared) ? declared.type : undefined;
  if (declaredType === "object" || declaredType === "array" || declaredType === "string") return declaredType;
  if (Array.isArray(emitted)) return "array";
  if (isObject(emitted)) return "object";
  return "string";
};

const prose = (params: { ceiling?: AggressionVector; target?: AggressionVector; resolved: AggressionVector; clamped: AggressionDial[]; sources: ResolvedVectorSources }): string => {
  const vector = (label: string, value: AggressionVector | undefined): string => value ? `${label}: ${AGGRESSION_DIALS.map((dial) => `${dial}=${value[dial]}`).join(", ")}` : `${label}: not available to this run`;
  return [
    "Engine-computed (src/agent/workspace/resolvedVectorClamp.ts): resolved = min(ceiling, target) componentwise. This field is never model-authored.",
    vector("ceiling", params.ceiling) + (params.sources.ceilingSource ? ` [${params.sources.ceilingSource}]` : ""),
    vector("target", params.target) + (params.sources.targetSource ? ` [${params.sources.targetSource}]` : ""),
    vector("resolved", params.resolved),
    params.clamped.length
      ? `The client ceiling BOUND the target on: ${params.clamped.join(", ")}.`
      : "The target was at or under the ceiling on every dial; the ceiling did not bind."
  ].join(" ");
};

// The clamp. Pure: takes an emitted output and the run's vectors, returns a new output (copy-on-write
// — the model's own object is never mutated under it) plus what changed and why.
export function applyResolvedVectorClamp(output: unknown, sources: ResolvedVectorSources, outputSchema?: unknown): ResolvedVectorClampResult {
  if (!isObject(output) || !declaresResolvedVector(output, outputSchema)) return { output, corrected: false, clampedDials: [], warnings: [] };
  const emitted = readVector(output.resolved);
  const { ceiling } = sources;

  if (!ceiling) {
    // Nothing to clamp against. Leave the model's value exactly as it is and say so loudly — this is
    // the state the live defect was found in, and it must never again look like a clean run.
    return {
      output,
      corrected: false,
      clampedDials: [],
      warnings: [output.resolved === undefined ? "resolved_vector_unclamped:no_ceiling_and_no_value" : "resolved_vector_unclamped:no_ceiling"]
    };
  }

  // min(ceiling, target). With no placement target, the model's own vector stands in as the target so
  // the ceiling half of the rule is still enforced.
  const target = sources.target ?? emitted;
  const warnings: string[] = [];
  if (!sources.target) warnings.push(emitted ? "resolved_vector_clamped_without_target" : "resolved_vector_unclamped:no_target_and_no_value");
  if (!target) {
    // Ceiling but neither a target nor a usable emitted vector: the engine has nothing to resolve.
    return { output, corrected: false, clampedDials: [], warnings };
  }

  const resolved = Object.fromEntries(AGGRESSION_DIALS.map((dial) => [dial, Math.min(ceiling[dial], target[dial])])) as AggressionVector;
  const clampedDials = AGGRESSION_DIALS.filter((dial) => resolved[dial] < target[dial]);
  const corrected = !emitted || AGGRESSION_DIALS.some((dial) => emitted[dial] !== resolved[dial]);
  if (corrected && output.resolved !== undefined) warnings.push(`resolved_vector_corrected:${AGGRESSION_DIALS.filter((dial) => !emitted || emitted[dial] !== resolved[dial]).join(",")}`);

  const basisText = prose({ ceiling, target: sources.target, resolved, clamped: clampedDials, sources });
  const shape = basisShapeOf(outputSchema, output.resolvedBasis);
  const resolvedBasis = shape === "object"
    ? { method: "engine_min_ceiling_target", formula: "resolved = min(ceiling, target) componentwise", ceiling, ...(sources.target ? { target: sources.target } : {}), clampedDials, ceilingSource: sources.ceilingSource, targetSource: sources.targetSource, note: basisText }
    : shape === "array" ? [basisText] : basisText;

  return { output: { ...output, resolved, resolvedBasis }, corrected, clampedDials, warnings, resolved };
}

// Where the run's vectors come from, in priority order:
//   1. THIS dispatch's own aggression resolution (the executor computed it from this dispatch's
//      prefetch plus placement_resolver's target — the freshest and most authoritative pair),
//   2. the deterministic contract_intelligence artifact's resolvedAggression (the same prefetch, one
//      hop later), for a node dispatched after contract_intelligence ran,
//   3. placement_resolver's stage output for the target alone, for a node dispatched BEFORE
//      contract_intelligence — the topology the live defect happened in.
// Never a model's retyped vector from an arbitrary stage output.
export function readResolvedVectorSources(params: {
  resolution?: { ok: boolean; resolved?: AggressionVector; ceiling?: AggressionVector; target?: AggressionVector };
  reducedCeiling?: unknown;
  stageOutputs?: Record<string, unknown>;
}): ResolvedVectorSources {
  const sources: ResolvedVectorSources = {};
  if (params.resolution?.ok) {
    sources.ceiling = params.resolution.ceiling;
    sources.target = params.resolution.target;
    sources.ceilingSource = "this dispatch's contract prefetch";
    sources.targetSource = "placement_resolver (this run)";
  }
  if (!sources.ceiling) {
    const fromContract = readVector(params.reducedCeiling);
    if (fromContract) { sources.ceiling = fromContract; sources.ceilingSource = "this dispatch's contract prefetch"; }
  }
  const intelligence = params.stageOutputs?.contract_intelligence;
  const carried = isObject(intelligence) && isObject(intelligence.resolvedAggression) ? (intelligence.resolvedAggression as Record<string, unknown>) : undefined;
  if (!sources.ceiling && carried) {
    const ceiling = readVector(carried.ceiling);
    if (ceiling) { sources.ceiling = ceiling; sources.ceilingSource = "contract_intelligence.resolvedAggression (deterministic, from the same prefetch)"; }
  }
  if (!sources.target && carried) {
    const target = readVector(carried.target);
    if (target) { sources.target = target; sources.targetSource = "contract_intelligence.resolvedAggression (deterministic, from the same prefetch)"; }
  }
  if (!sources.target) {
    const placement = params.stageOutputs?.placement_resolver;
    const target = isObject(placement) && placement.dryRun !== true ? readVector(placement.target) : undefined;
    if (target) { sources.target = target; sources.targetSource = "placement_resolver stage output"; }
  }
  return sources;
}

// The prompt-side half: a node whose output carries `resolved` is TOLD the engine owns it, in the
// same dispatch that takes it over (runContext.enginePolicies) — so the model does not spend a turn
// deriving a number that is about to be overwritten, and the seeded prompt and the actual behaviour
// cannot drift apart.
export const ENGINE_RESOLVED_VECTOR_POLICY =
  "The RESOLVED aggression vector (resolved / resolvedBasis) is computed by the engine as min(client ceiling, placement target) componentwise and written onto your output after you return. Do not derive, guess, or copy a resolved vector yourself — anything you emit in those fields is overwritten.";
