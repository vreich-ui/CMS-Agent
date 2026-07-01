import { z } from "zod";
import { memoryEnvelopeSchema } from "../memory/memoryEnvelope.js";
import type { AgentRequest } from "./types.js";

export const agentRequestSchema = z.object({
  projectId: z.string().min(1),
  workflow: z.enum(["content_creation", "publish_only", "refresh_existing_content"]).optional(),
  threadId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  dryRun: z.boolean().optional().default(true),
  input: z.string().min(1),
  memory: memoryEnvelopeSchema.optional()
});

export function validateRequest(body: unknown): AgentRequest {
  return agentRequestSchema.parse(body);
}
