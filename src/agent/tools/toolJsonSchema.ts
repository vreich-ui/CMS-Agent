// S1 (chat-path, 2026-08-17) — THE TOOL SCHEMA THE MODEL SEES.
//
// The OpenAI runner used to advertise every controlled tool to the model with the placeholder
// `{type:"object", properties:{}, additionalProperties:true}` — an object that says nothing. The
// server-side zod inputSchema is `.strict()`, so the model had to GUESS argument names (projectId?
// project_id? tool? name?) and burn turns on validation errors it could not have avoided. This
// converts the registry's zod inputSchema into the real JSON Schema (zod 4's built-in
// z.toJSONSchema — no new dependency), so `project.call_read_tool` advertises projectId/tool/
// arguments exactly as the executor will validate them. Server-side `.strict()` is unchanged.
//
// Robustness over fidelity: a schema zod cannot represent in JSON Schema (none in the registry
// today; guarded anyway) falls back to the open placeholder rather than failing the dispatch.
import { z, type ZodTypeAny } from "zod";

export const OPEN_TOOL_PARAMETERS: Record<string, unknown> = { type: "object", properties: {}, required: [], additionalProperties: true };

export function toolInputJsonSchema(schema: ZodTypeAny | undefined): Record<string, unknown> {
  if (!schema) return { ...OPEN_TOOL_PARAMETERS };
  try {
    const json = z.toJSONSchema(schema as never, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
    // The $schema marker is noise in a function-parameters block, and a non-object root (a bare
    // record/unknown) cannot be a function's parameters — the model needs an object at the top.
    const { $schema: _marker, ...rest } = json;
    void _marker;
    if (rest.type !== "object") return { ...OPEN_TOOL_PARAMETERS };
    return { properties: {}, ...rest };
  } catch {
    return { ...OPEN_TOOL_PARAMETERS };
  }
}
