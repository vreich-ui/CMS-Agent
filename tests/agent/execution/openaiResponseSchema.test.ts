import { describe, expect, it } from "vitest";
import { buildDtcPublishingNodeCorrection } from "../../../scripts/dtcPublishingNodeCorrections.js";
import { responseFormatLintNotes } from "../../../scripts/seedNodesFromWorkspace.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import {
  OPENAI_INCOMPATIBLE_ROOT_KEYWORDS,
  deriveOpenAIResponseSchema,
  openAiIncompatibleRootKeywords,
  openAiResponseSchemaLint
} from "../../../src/agent/execution/openaiResponseSchema.js";

const HANDOFF_NODES = ["research", "draft_writer", "trust_factual", "review_aggregator"] as const;
const byId = (id: string) => structuredClone(listWorkspaceNodes().find((node) => node.id === id)!);
const corrected = (id: string) => { const node = byId(id); return { ...node, ...buildDtcPublishingNodeCorrection(node) }; };

// The shape OpenAI actually accepts for a response_format json_schema root. Anything here is what
// the 400 ("schema must not have allOf at the top level") was complaining about.
const rootKeywordsOf = (schema: unknown) => Object.keys(schema as Record<string, unknown>).filter((key) => (OPENAI_INCOMPATIBLE_ROOT_KEYWORDS as readonly string[]).includes(key));

describe("OpenAI response_format derivation (B1)", () => {
  it.each(HANDOFF_NODES)("%s: the DTC contract's root invariants are stripped from what OpenAI is sent", (id) => {
    const full = corrected(id).outputSchema as Record<string, any>;
    // Guard the premise: if the corrections script stops emitting root rules this test is vacuous.
    expect(full.allOf?.length).toBeGreaterThan(0);

    const derived = deriveOpenAIResponseSchema(full);
    expect(derived.stripped).toContain("allOf");
    expect(rootKeywordsOf(derived.schema)).toEqual([]);
    // The part OpenAI CAN enforce must survive intact — this is the whole point of deriving rather
    // than falling back to an open object.
    expect((derived.schema as any).type).toBe("object");
    expect(Object.keys((derived.schema as any).properties)).toEqual(Object.keys(full.properties));
    expect((derived.schema as any).required).toEqual(full.required);
  });

  it.each(HANDOFF_NODES)("%s: the full schema still enforces the invariant post-turn", (id) => {
    const full = corrected(id).outputSchema;
    const artifact = (byId(id).outputSchema as any).properties.artifact.const;
    const blocked = {
      artifact,
      summary: "CMS-Agent offline test.",
      advisories: [],
      ...(id === "research"
        ? { evidenceStatus: "unavailable", sources: [], findings: [] }
        : id === "draft_writer"
          ? { draftStatus: "blocked", proposedTitle: "Pending evidence", draftSections: [], sourceClaimNotes: [], nextStep: { action: "Await evidence", destination: null, rationale: "Source unavailable" } }
          : id === "trust_factual"
            ? { verdict: "blocked", coverageNote: "Draft cannot be verified.", claimReviews: [] }
            : { reviewStatus: "blocked", revisions: [], unresolvedConflicts: [], buildInstructions: [] })
    };
    // Blocked-with-a-blocker passes; the same output with the blocker dropped is exactly what the
    // root rule exists to refuse, and it must still be refused after B1.
    expect(validateOutput({ ...blocked, blockers: ["evidence unavailable"] }, full).ok).toBe(true);
    expect(validateOutput({ ...blocked, blockers: [] }, full).ok).toBe(false);
    // ...and it is NOT refused by the reduced schema, which is why the reduction is a warning.
    expect(validateOutput({ ...blocked, blockers: [] }, deriveOpenAIResponseSchema(full).schema).ok).toBe(true);
  });

  it("leaves a schema with no root combinator byte-identical (and unreferenced)", () => {
    const clean = { type: "object", required: ["artifact"], properties: { artifact: { const: "research_brief.v1" }, notes: { type: "array", items: { type: "string" } } } };
    const derived = deriveOpenAIResponseSchema(clean);
    expect(derived.stripped).toEqual([]);
    expect(derived.schema).toBe(clean);
  });

  it("strips every refused root keyword, never a nested one, and never mutates the input", () => {
    const schema = {
      type: "object",
      properties: { status: { enum: ["ready", "blocked"] }, nested: { anyOf: [{ type: "string" }, { type: "null" }] } },
      allOf: [{ if: { required: ["status"] }, then: { required: ["blockers"] } }],
      oneOf: [{ required: ["a"] }],
      not: { required: ["b"] },
      enum: [{ a: 1 }]
    };
    const frozen = structuredClone(schema);
    const derived = deriveOpenAIResponseSchema(schema);
    expect(derived.stripped).toEqual(["allOf", "oneOf", "not", "enum"]);
    expect(rootKeywordsOf(derived.schema)).toEqual([]);
    // Nested combinators are fine for the API and are the schema's real content — keep them.
    expect((derived.schema as any).properties.nested.anyOf).toHaveLength(2);
    expect((derived.schema as any).properties.status.enum).toEqual(["ready", "blocked"]);
    expect(schema).toEqual(frozen);
  });

  it("falls back to an open object when the root held nothing but a combinator", () => {
    const derived = deriveOpenAIResponseSchema({ oneOf: [{ type: "object" }, { type: "array" }] });
    expect(derived.schema).toEqual({ type: "object", additionalProperties: true });
  });

  it("ignores non-object schemas rather than inventing a complaint", () => {
    expect(openAiIncompatibleRootKeywords(true)).toEqual([]);
    expect(openAiIncompatibleRootKeywords(undefined)).toEqual([]);
    expect(deriveOpenAIResponseSchema(true).schema).toBe(true);
  });
});

describe("OpenAI response_format lint (B1)", () => {
  it("warns on a root combinator and stays silent on a clean schema", () => {
    expect(openAiResponseSchemaLint({ type: "object", allOf: [{ required: ["x"] }] })).toMatch(/root-level allOf/);
    expect(openAiResponseSchemaLint({ type: "object", properties: {} })).toBeUndefined();
  });

  it("names the offending nodes for the nodes:update drift gate", () => {
    const nodes = listWorkspaceNodes().map((node) => ({ ...node, ...buildDtcPublishingNodeCorrection(node) })) as any;
    const notes = responseFormatLintNotes(nodes);
    for (const id of HANDOFF_NODES) expect(notes.some((note) => note.startsWith(`${id}: `))).toBe(true);
  });
});
