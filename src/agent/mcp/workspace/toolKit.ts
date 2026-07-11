// Shared tool-definition helpers for the workspace MCP tool modules. Lives in its own module so
// tools.ts, changesTools.ts, and constellationTools.ts can all use them without import cycles.
import { z, ZodError, type ZodTypeAny } from "zod";
import { workspaceActorKinds, workspaceChangeSources } from "../../workspace/changeTypes.js";

export type JsonSchema = Record<string, unknown>;
export type WorkspaceTool = {
  name: string;
  description: string;
  zodSchema: ZodTypeAny;
  inputSchema: JsonSchema;
  execute: (input: unknown) => Promise<unknown>;
};

export const objectSchema = (properties: JsonSchema = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const ok = (data: unknown) => ({ ok: true, data });
export const tool = (definition: WorkspaceTool) => definition;
export const toolError = (error: unknown) => error instanceof ZodError ? { ok: false, error: { code: "validation_error", issues: error.issues } } : { ok: false, error: { code: "tool_error", message: error instanceof Error ? error.message : "Unknown error" } };

export const workspaceActorSchema = z.object({ kind: z.enum(workspaceActorKinds), id: z.string().min(1).optional(), label: z.string().min(1).optional() }).strict();
export const mutationMeta = {
  expectedWorkspaceVersion: z.number().int().nonnegative().optional(),
  baseRevisionId: z.string().min(1).optional(),
  actor: z.union([z.string().min(1), workspaceActorSchema]).optional(),
  source: z.enum(workspaceChangeSources).optional(),
  summary: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  correlation: z.object({ runId: z.string().min(1).optional(), requestId: z.string().min(1).optional() }).strict().optional()
};
const actorJson = { oneOf: [{ type: "string", minLength: 1 }, { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: [...workspaceActorKinds] }, id: { type: "string" }, label: { type: "string" } } }] };
export const metaJson = { expectedWorkspaceVersion: { type: "integer", minimum: 0 }, baseRevisionId: { type: "string" }, actor: actorJson, source: { type: "string", enum: [...workspaceChangeSources] }, summary: { type: "string" }, reason: { type: "string" }, correlation: { type: "object", additionalProperties: false, properties: { runId: { type: "string" }, requestId: { type: "string" } } } };
