/**
 * OpenAI-safe response_format derivation (B1).
 *
 * WHY THIS FILE EXISTS
 *
 * The Responses API rejects a json_schema whose ROOT carries a combinator or a root-level
 * enum/const:
 *
 *   400 Invalid schema for response_format 'research_output': schema must not have allOf at the
 *   top level.
 *
 * The four DTC handoff contracts (research, draft_writer, trust_factual, review_aggregator) express
 * their real invariants exactly that way — "evidenceStatus unavailable REQUIRES a blocker",
 * "draftStatus ready REQUIRES section copy" — as top-level `allOf: [{if,then,else}, ...]` added by
 * scripts/dtcPublishingNodeCorrections.ts on 2026-09-09. Every live `research` dispatch on the
 * OpenAI path then failed at the first request, Sep 9-13, before the model saw a single token.
 *
 * Deleting the invariants from the store "fixed" it by giving up the invariant. This module fixes
 * the mechanism instead: the schema SENT to OpenAI is derived from the node's schema by dropping the
 * keywords the API refuses at the root, while `node.outputSchema` — combinators and all — stays
 * whole for post-turn validation in outputValidator.ts, which implements allOf/anyOf/oneOf/not and
 * if/then/else at every depth.
 *
 * The invariants are not lost on the model side either: OpenAINodeRunner serializes the FULL
 * `node.outputSchema` into the prompt payload, so the model still reads the conditional rules as
 * part of its instructions. Only the machine-enforced response_format is reduced.
 *
 * DELIBERATELY A PLAIN STRIP, NOT A MERGE. Folding `allOf` members up into the root would carry a
 * little more machine-enforced structure, at the cost of having to reconcile conflicting `required`
 * / `properties` between branches — a silent-corruption risk in exchange for constraints the
 * post-turn validator already enforces exactly. Nested combinators are untouched: only the ROOT is
 * a problem for the API.
 */

/** Root-level keywords the Responses API refuses in a response_format json_schema. */
export const OPENAI_INCOMPATIBLE_ROOT_KEYWORDS = ["allOf", "anyOf", "oneOf", "if", "then", "else", "not", "enum", "const"] as const;

export type OpenAIIncompatibleRootKeyword = (typeof OPENAI_INCOMPATIBLE_ROOT_KEYWORDS)[number];

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Root-level keywords in `schema` that OpenAI will reject, in declaration order. Empty for a schema
 * that is already safe (and for anything that is not a plain object — a boolean schema or a missing
 * one is nothing to warn about here; the store's own validateJsonSchema owns that complaint).
 */
export function openAiIncompatibleRootKeywords(schema: unknown): OpenAIIncompatibleRootKeyword[] {
  if (!isPlainObject(schema)) return [];
  return OPENAI_INCOMPATIBLE_ROOT_KEYWORDS.filter((keyword) => schema[keyword] !== undefined);
}

export type DerivedResponseSchema = {
  /** The schema to send as response_format. Never the same object as the input. */
  schema: unknown;
  /** Root keywords removed, in declaration order. Empty when nothing was stripped. */
  stripped: OpenAIIncompatibleRootKeyword[];
};

/**
 * Derive the response_format schema for `schema`. The input is never mutated; when nothing needs
 * stripping the original object is returned as-is so the no-combinator path (every node but the
 * four handoff contracts) is byte-identical to what it sent before this existed.
 */
export function deriveOpenAIResponseSchema(schema: unknown): DerivedResponseSchema {
  const stripped = openAiIncompatibleRootKeywords(schema);
  if (!stripped.length) return { schema, stripped };
  const reduced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!(OPENAI_INCOMPATIBLE_ROOT_KEYWORDS as readonly string[]).includes(key)) reduced[key] = value;
  }
  // A schema whose whole shape lived in the stripped combinator (no type, no properties left) would
  // derive to `{}` — which OpenAI accepts and which constrains nothing, so the model gets no shape
  // at all. Fail loud-but-open instead: declare an open object, the same fallback normalizeNode uses
  // for a node with no schema, so the dispatch still runs and the post-turn validator still judges it.
  if (reduced.type === undefined && reduced.properties === undefined) return { schema: { ...reduced, type: "object", additionalProperties: true }, stripped };
  return { schema: reduced, stripped };
}

/** One-line, greppable warning for a run record. */
export const responseSchemaStripWarning = (nodeId: string, stripped: readonly string[]) => `response_format_root_keywords_stripped:${nodeId}:${stripped.join(",")}`;

/**
 * Advisory lint text for an authoring surface (nodes:update, workspace.update_node_output_schema).
 * Returns undefined when the schema is fine. WARN-NEVER-BLOCK: a schema carrying these keywords is
 * legal and is enforced in full post-turn — the author just needs to know the API will not enforce
 * them for it.
 */
export function openAiResponseSchemaLint(schema: unknown, label = "outputSchema"): string | undefined {
  const stripped = openAiIncompatibleRootKeywords(schema);
  if (!stripped.length) return undefined;
  return `${label}: root-level ${stripped.join(", ")} ${stripped.length === 1 ? "is" : "are"} rejected by OpenAI response_format and will be stripped from the schema sent to the model (the invariants are still enforced post-turn by outputValidator, and the full schema is still shown to the model in the prompt). Nest them under a property, or accept model-side non-enforcement.`;
}
