import { z } from "zod";

// T15.32 (#208; ADR-2026-08-25-structure-studio §5.1) — the "template" artifact type: a finished
// template's LEDGER FACT (what the studio actually minted, published, and — for a cross-tenant
// instantiation — attached to this tenant), never a model's re-derivation of one. The record's shape
// rides inside `artifacts[].value` (typed here, but NOT enforced by memoryEnvelopeSchema's own loose
// `value: z.unknown()`) so no existing consumer of the envelope breaks: a reader that predates
// "template" still sees a well-formed MemoryEnvelope, just with one more artifact type it does not
// recognize and can ignore.
export const templateArtifactValueSchema = z.object({
  templateId: z.string().min(1),
  version: z.number().int().positive(),
  objectType: z.enum(["section_template", "template", "pdf_template"]),
  // The object this template produced IN THIS TENANT — the minted recipe's own objectId on a
  // clone-driven write, or the platform's object_instantiate_* result's objectId on a cross-tenant
  // instantiation into a RECEIVING tenant (ADR §5.2).
  instantiatedObjectId: z.string().min(1),
  // Read back verbatim from the library record's own TemplateProvenance (templateLibraryTypes.ts) —
  // never re-derived. See templateProvenance.ts for what "stateable" means for each field.
  provenance: z.object({
    sourceUrl: z.string().min(1),
    captureRunId: z.string().min(1).optional(),
    engineHashes: z.record(z.string(), z.string()),
    standardsPack: z.string().min(1)
  })
}).strict();

export type TemplateArtifactValue = z.infer<typeof templateArtifactValueSchema>;

// ADR §5.1: `{id: "<templateId>@<version>", type: "template", ...}` — the artifact id a template
// record is stored and looked up under. Pure string join; used identically by the writer (to mint the
// id) and the idempotency check (to recognize a re-recorded id) so the two can never disagree.
export const buildTemplateArtifactId = (templateId: string, version: number): string => `${templateId}@${version}`;

export const memoryEnvelopeSchema = z.object({
  schemaVersion: z.literal("agent.memory.v1"),
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  updatedAt: z.string().datetime().optional(),
  facts: z.array(z.object({
    key: z.string().min(1),
    value: z.unknown(),
    confidence: z.number().min(0).max(1),
    source: z.enum(["user", "agent", "tool", "human_review"])
  })).default([]),
  preferences: z.record(z.string(), z.unknown()).default({}),
  openLoops: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["open", "resolved"]),
    description: z.string().min(1),
    nextAction: z.string().optional()
  })).default([]),
  artifacts: z.array(z.object({
    id: z.string().min(1),
    // "template" added T15.32 (#208; ADR-2026-08-25-structure-studio §5.1).
    type: z.enum(["brief", "draft", "published_url", "report", "template"]),
    uri: z.string().url().optional(),
    value: z.unknown().optional()
  })).default([])
});

export type MemoryEnvelope = z.infer<typeof memoryEnvelopeSchema>;

export function normalizeMemoryEnvelope(input: unknown, defaults: { projectId: string; userId?: string; threadId?: string }): MemoryEnvelope {
  const parsed = memoryEnvelopeSchema.parse(input ?? { schemaVersion: "agent.memory.v1" });
  return {
    ...parsed,
    projectId: parsed.projectId ?? defaults.projectId,
    userId: parsed.userId ?? defaults.userId,
    threadId: parsed.threadId ?? defaults.threadId,
    // ADR §5.3 — LEDGER fact, stamped on every normalize call. Memory sits outside the determinism
    // boundary FOR THIS REASON, which is exactly why clientMemoryStore.ts's write is a side effect a
    // run's own stage output must never read back: normalizeMemoryEnvelope is not pure, deliberately,
    // and nothing downstream of a run's hashed/emitted output may call it or consume its result.
    updatedAt: new Date().toISOString()
  };
}
