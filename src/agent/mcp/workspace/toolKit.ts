// Shared tool-definition helpers for the workspace MCP tool modules. Lives in its own module so
// tools.ts, changesTools.ts, and constellationTools.ts can all use them without import cycles.
import { z, ZodError, type ZodTypeAny } from "zod";
import { workspaceActorKinds, workspaceChangeSources } from "../../workspace/changeTypes.js";
import { WorkspaceToolError } from "../../workspace/workspaceErrors.js";

// Re-exported so tool modules keep a single import site for raising and classifying failures.
export { WorkspaceToolError, WorkspaceVersionConflictError, MissingPatchFieldError } from "../../workspace/workspaceErrors.js";

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

// Tool names that cross the wire must satisfy the Anthropic tool-name pattern
// ^[a-zA-Z0-9_-]{1,64}$ — remote connectors (claude.ai) forward tools/list names verbatim into the
// Messages API, which rejects the whole request if any name contains a dot. Internally tools are
// defined with dotted namespaces ("workspace.get_nodes"); the transport serves the canonical
// underscore form and accepts both spellings on tools/call so existing callers (UI, scripts) are
// unaffected.
export const ANTHROPIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const canonicalToolName = (name: string): string => name.replace(/\./g, "_");

// Some MCP clients serialize object-typed arguments as JSON strings (observed live with Claude's
// connector: the `node` arg of workspace.create_node and the payload args of
// project.validate_handoff both arrived stringified). For parameters that are contractually
// objects, parse a string that contains a JSON object/array; anything else passes through
// unchanged so downstream schema validation reports the real shape error.
export const coerceJsonObjectInput = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};
export const tool = (definition: WorkspaceTool) => definition;

// Anything carrying a string `code` is treated as already-typed — this picks up ProjectAdminError
// (default_project_protected, unknown_project, project_exists) without coupling this module to it.
const codedError = (error: unknown): { code: string; message: string } | null => {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? { code, message: error.message } : null;
};

export type ToolErrorEnvelope = { ok: false; error: { code: string; message?: string; issues?: unknown } & Record<string, unknown> };

export const toolError = (error: unknown): ToolErrorEnvelope => {
  if (error instanceof ZodError) return { ok: false, error: { code: "validation_error", issues: error.issues } };
  if (error instanceof WorkspaceToolError) return { ok: false, error: { code: error.code, message: error.message, ...error.details } };
  const coded = codedError(error);
  if (coded) return { ok: false, error: { code: coded.code, message: coded.message } };
  return { ok: false, error: { code: "tool_error", message: error instanceof Error ? error.message : "Unknown error" } };
};

// One-line summary for the JSON-RPC `error.message`, so the transport stops reporting every failure
// as the same opaque sentence. The structured envelope still travels in `error.data`.
export const toolErrorSummary = (envelope: ToolErrorEnvelope): string => {
  const { code, message } = envelope.error;
  if (code === "validation_error") return "validation_error: input did not match the tool schema.";
  return message ? `${code}: ${message}` : code;
};

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
