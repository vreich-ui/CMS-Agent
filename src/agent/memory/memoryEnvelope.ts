import { z } from "zod";

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
    type: z.enum(["brief", "draft", "published_url", "report"]),
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
    updatedAt: new Date().toISOString()
  };
}
