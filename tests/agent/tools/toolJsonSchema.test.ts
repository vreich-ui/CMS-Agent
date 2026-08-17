import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OPEN_TOOL_PARAMETERS, toolInputJsonSchema } from "../../../src/agent/tools/toolJsonSchema.js";
import { getTool, listTools } from "../../../src/agent/tools/toolResolver.js";

// S1 (chat-path). The model must be told the argument names the server will validate — the open
// placeholder taught it nothing, and every guessed name was a wasted turn against a strict schema.
describe("controlled-tool JSON schema handed to the model", () => {
  it("project.call_read_tool exposes projectId, tool and arguments", () => {
    const schema = toolInputJsonSchema(getTool("project.call_read_tool")!.inputSchema);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual(["arguments", "projectId", "tool"]);
    expect(schema.required).toEqual(expect.arrayContaining(["projectId", "tool"]));
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty("$schema");
  });

  it("every registry tool converts to an object schema without throwing", () => {
    for (const tool of listTools()) {
      const schema = toolInputJsonSchema(tool.inputSchema);
      expect(schema.type, tool.toolId).toBe("object");
      expect(typeof schema.properties, tool.toolId).toBe("object");
    }
  });

  it("falls back to the open placeholder for a non-object or missing schema", () => {
    expect(toolInputJsonSchema(undefined)).toEqual(OPEN_TOOL_PARAMETERS);
    expect(toolInputJsonSchema(z.string())).toEqual(OPEN_TOOL_PARAMETERS);
  });
});
