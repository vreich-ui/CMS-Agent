// Session D (2026-08, improvement phase) — the deterministic half of contract_intelligence.
//
// WHY THIS EXISTS. contract_intelligence historically ran $10.87 of $20.95 total spend (52%) because
// it re-fetched and re-sent the raw client contract across its own agent turns. PR #93/#95 fixed the
// re-sending by having the conductor fetch-and-reduce the contract ONCE, deterministically, before the
// node runs (contractPrefetch.ts / contractReduction.ts) — that alone dropped the measured cost to
// ~$0.134/run (node-limits audit, v258). What's left after that fix is a model call whose entire job,
// per its own prompt, is "this is a validation and pass-through step, not a discovery one": sanity-check
// the already-reduced contract, rename a few fields, write a summary sentence, and surface anything
// unmapped. None of that requires judgment a program cannot make — it requires exactly the field
// mapping this module performs.
//
// WHAT THIS DOES NOT DO. It does not reshape the reduced contract into anything cleverer than what
// reduceContract already extracted. In particular it deliberately DROPS the separate `mediaPolicy`
// field earlier (model-produced) outputs carried alongside `mediaConvention` — the rubric review that
// authored this node's evaluation rubric flagged that duplication by name as a fidelity risk ("a
// derived duplicate that contradicts its source field"), and the fix is not to carry two copies of the
// same fact, it is to carry one. It also does not invent a client-specific idConventions.object/.nodes
// split some earlier LLM outputs performed — inventing a partitioning scheme not present in the raw
// reduced data is exactly what the rubric's no_invented_client_rules criterion exists to catch.
//
// SAFETY. This is a fast path, not the only path. buildDeterministicContractIntelligence's caller
// (executor.ts) validates its result against the node's own outputSchema before using it, and falls
// back to the normal model dispatch on any validation failure — a mapping bug degrades to "spend the
// $0.134" rather than "the run fails" or "a malformed artifact ships".
import type { ReducedContract } from "./contractReduction.js";

export type ContractIntelligenceOutput = {
  artifact: "contract_intelligence.v1";
  summary: string;
  clientProjectId: string;
  clientObjectType: string;
  contractSource: unknown;
  bodySchema?: unknown;
  idConventions: { source: string; conventions: ReducedContract["idConventions"] };
  mediaConvention: ReducedContract["mediaConvention"];
  taxonomy: ReducedContract["taxonomy"] & { unknownTermsBlock: boolean };
  constraints: ReducedContract["constraints"];
  publishPolicy?: unknown;
  /** The contract's four-dial aggression ceiling, carried through when the reduction found a complete one. */
  ceiling?: { claim_strength: number; urgency: number; emotional_agitation: number; cta_density: number };
  contract_findings: string[];
  assumptions: string[];
  blockers: string[];
  notes: string[];
};

/**
 * The aggression ceiling, carried from the reduction rather than left to the model.
 *
 * WHY. The node's LIVE outputSchema (the workspace-store overlay live runs are dispatched with, not
 * the canonical definition in nodes.ts) requires `ceiling` on any output whose `blockers` array is
 * empty. This mapper never emitted one, so its artifact failed that check on EVERY live dispatch —
 * `contract_intelligence_deterministic_invalid:$.ceiling is required` — and fell through to the model
 * path this module exists to avoid. It cost the ~$0.134/run the fast path was written to save, and it
 * left the field to a model that omitted it on 5 of 7 attempts in run_1787492010814_kxdbeb, blocking
 * publication behind output_validation_failed each time.
 *
 * The value was never missing: contractReduction.ts extracts it into `reduced.aggressionCeiling`.
 *
 * ALL FOUR DIALS, each a finite number in 0..1, or nothing. A partial ceiling is not a ceiling, and
 * this mapper does not decide what a missing one means: it omits the field and the artifact fails the
 * live schema exactly as it does today, falling through to the model — whose own prompt and blocker
 * criteria own the "an absent ceiling is a BLOCKER, never a default" judgment. That keeps this change
 * to the case it is about (a contract that HAS a ceiling) and leaves the fast path's documented
 * safety property intact: a mapping that cannot produce a valid artifact degrades to spending the
 * $0.134, never to a fabricated blocker or a malformed artifact.
 */
export const AGGRESSION_DIALS = ["claim_strength", "urgency", "emotional_agitation", "cta_density"] as const;

const readAggressionCeiling = (value: unknown): ContractIntelligenceOutput["ceiling"] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const dials: Record<string, number> = {};
  for (const dial of AGGRESSION_DIALS) {
    const raw = record[dial];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return undefined;
    dials[dial] = raw;
  }
  return dials as ContractIntelligenceOutput["ceiling"];
};

const truncateForNote = (value: unknown, max = 200): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const bodySchemaRequiredFields = (bodySchema: unknown): string[] => {
  if (!bodySchema || typeof bodySchema !== "object") return [];
  const required = (bodySchema as Record<string, unknown>).required;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
};

// The output schema types bodySchema/publishPolicy as `{type: "object", additionalProperties: true}` —
// not required, but ALSO not nullable. contractReduction.ts can hand back `null` for either when the
// raw contract was silent (extractBodySchema/extractPublishPolicy both `?? null`), and reduceContract's
// own type signature confirms both are optional in practice even where the declared TS type says
// `unknown`. Passing `null` through would fail "type: object" — omitting the key entirely is what the
// schema actually allows, and matches the node's own "state silence as an assumption" policy better
// than a fabricated empty object would.
const orOmit = <T,>(value: T | null | undefined): T | undefined => (value === null || value === undefined ? undefined : value);

export function buildDeterministicContractIntelligence(reduced: ReducedContract, clientProjectId: string): ContractIntelligenceOutput {
  const blockingConstraints = reduced.constraints.filter((entry) => entry.severity && /block/i.test(entry.severity));
  const unknownTermsBlock = reduced.taxonomy.blockingConstraints.length > 0;
  const requiredBodyFields = bodySchemaRequiredFields(reduced.bodySchema);
  const publishPolicyRecord = reduced.publishPolicy && typeof reduced.publishPolicy === "object" ? reduced.publishPolicy as Record<string, unknown> : undefined;

  const contract_findings: string[] = [
    `Contract fetched via ${(reduced.contractSource as { tool?: string })?.tool ?? "unknown tool"} at ${(reduced.contractSource as { fetchedAtISO?: string })?.fetchedAtISO ?? "unknown time"} for object type ${reduced.clientObjectType}; deterministic pass-through, no re-fetch and no model call.`,
    reduced.bodySchema
      ? `Body schema present as a JSON Schema object${requiredBodyFields.length ? `; required top-level fields: ${requiredBodyFields.join(", ")}` : ""}.`
      : "No body schema was present in the fetched contract — downstream nodes have no structural shape to validate against and should treat this as a gap, not assume a generic shape.",
    `${reduced.constraints.length} structural constraint(s) declared; ${blockingConstraints.length} carry a blocking severity.`,
    `Taxonomy: unknown terms ${unknownTermsBlock ? "BLOCK" : "do not block"} writes${reduced.taxonomy.blockingConstraints.length ? ` (constraint id(s): ${reduced.taxonomy.blockingConstraints.map((c) => c.id).join(", ")})` : ""}.`,
    publishPolicyRecord
      ? `Publish policy: gated=${String(publishPolicyRecord.gated ?? "unstated")}, requires_approval=${String(publishPolicyRecord.requires_approval ?? publishPolicyRecord.requiresApproval ?? "unstated")}.`
      : "No publish policy was present in the fetched contract."
  ];

  const assumptions: string[] = [
    "This output was built deterministically from the conductor's contract prefetch (contractReduction.ts) — no discovery call was made by this node, and nothing here was inferred beyond what the reduced contract itself states.",
    "idConventions is carried as the flat list the reduction extracted (entries whose id matches /id|slug/i in the contract's own constraints); no client-specific grouping was invented on top of it."
  ];
  if (!reduced.idConventions.length) assumptions.push("No id/slug-pattern constraints were found in the fetched contract's constraints array; downstream nodes have no declared id convention to follow and should say so rather than assume one.");

  const notes: string[] = [];
  if (reduced.unmapped && Object.keys(reduced.unmapped).length) {
    for (const [key, value] of Object.entries(reduced.unmapped)) {
      notes.push(`Unmapped contract data preserved for downstream attention: ${key} = ${truncateForNote(value)}`);
    }
  }

  const summary =
    `Live prefetched contract for ${clientProjectId}/${reduced.clientObjectType} was present and used directly ` +
    `(deterministic pass-through, no model call). ${reduced.constraints.length} structural constraint(s), ` +
    `${blockingConstraints.length} blocking. Taxonomy unknown-terms-block: ${unknownTermsBlock}. ` +
    `Publish gated: ${publishPolicyRecord ? String(publishPolicyRecord.gated ?? "unstated") : "unstated"}.`;

  const ceiling = readAggressionCeiling(reduced.aggressionCeiling);

  return {
    artifact: "contract_intelligence.v1",
    summary,
    clientProjectId,
    clientObjectType: reduced.clientObjectType,
    contractSource: reduced.contractSource,
    ...(orOmit(reduced.bodySchema) !== undefined ? { bodySchema: reduced.bodySchema } : {}),
    idConventions: { source: "prefetchedContract.idConventions (deterministic 1:1 carry-through, no invented grouping)", conventions: reduced.idConventions },
    mediaConvention: reduced.mediaConvention,
    taxonomy: { ...reduced.taxonomy, unknownTermsBlock },
    constraints: reduced.constraints,
    ...(orOmit(reduced.publishPolicy) !== undefined ? { publishPolicy: reduced.publishPolicy } : {}),
    ...(ceiling ? { ceiling } : {}),
    contract_findings,
    assumptions,
    blockers: [],
    notes
  };
}
