import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import {
  coerceNodeInput,
  coerceSchemaInput,
  createDefaultWorkspaceDocument,
  parseWorkspaceDocumentTolerant
} from "../../../src/agent/mcp/workspace/store.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const structured = (res: any) => res.result?.structuredContent;
const errorText = (res: any) => JSON.stringify(res.error?.data ?? res.error ?? {});

describe("workspace node write hardening", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("coerces a node argument delivered as a JSON string (MCP client stringification)", async () => {
    // Reproduces the live corruption: the client sent `node` as a JSON string. Previously this was
    // spread into indexed characters and persisted as a node with no id; now it round-trips.
    const res = await call("workspace.create_node", { node: JSON.stringify({ id: "string_arg_node", name: "String Arg Node", prompt: "Draft." }) });
    expect(structured(res).ok).toBe(true);
    expect(structured(res).data.node.id).toBe("string_arg_node");
    expect(structured(res).data.node).not.toHaveProperty("0");

    // The workspace is still readable afterward — no poisoned record persisted.
    const list = await call("node.list");
    expect(structured(list).data.nodes.some((n: { id: string }) => n.id === "string_arg_node")).toBe(true);
  });

  it("rejects a node string that is not valid JSON, persisting nothing", async () => {
    const res = await call("workspace.create_node", { node: "{ not valid json" });
    expect(errorText(res)).toContain("invalid_node");
    expect(structured(await call("node.list")).data.nodes.some((n: { name?: string }) => n?.name === undefined)).toBe(false);
  });

  it("rejects a node object missing required fields via the mutate backstop", async () => {
    const res = await call("workspace.create_node", { node: { name: "No Id", prompt: "x" } });
    expect(errorText(res)).toContain("invalid_node");
    // Reads still work — nothing invalid was written.
    expect(structured(await call("node.list")).ok).toBe(true);
  });

  it("still creates a normal minimally-specified node", async () => {
    const res = await call("workspace.create_node", { node: { id: "ok_node", name: "OK Node", prompt: "Draft." } });
    expect(structured(res).ok).toBe(true);
    expect(structured(res).data.node).toMatchObject({ id: "ok_node", dependsOn: [], riskLevel: "read" });
  });
});

describe("coerceNodeInput", () => {
  it("parses strings, passes objects, and rejects other shapes", () => {
    expect(coerceNodeInput('{"id":"a"}')).toEqual({ id: "a" });
    expect(coerceNodeInput({ id: "b" })).toEqual({ id: "b" });
    expect(() => coerceNodeInput("nope")).toThrow(/invalid_node/);
    expect(() => coerceNodeInput(["x"])).toThrow(/invalid_node/);
    expect(() => coerceNodeInput(42 as unknown)).toThrow(/invalid_node/);
    expect(() => coerceNodeInput(null)).toThrow(/invalid_node/);
  });
});

describe("R-3 — stringified schema arguments on the schema writers", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  const objectSchemaValue = { type: "object", additionalProperties: false, required: ["headline"], properties: { headline: { type: "string" } } };

  it("accepts a stringified output schema and persists the parsed object", async () => {
    // Pre-fix this reached validateJsonSchema as a string and failed with "JSON Schema must be an
    // object or boolean", which is the whole reason S4's Schemas tab shipped read-only.
    const res = await call("workspace.update_node_output_schema", { id: "input_triage", schema: JSON.stringify(objectSchemaValue) });
    expect(structured(res).ok).toBe(true);

    const node = structured(await call("workspace.get_node", { id: "input_triage" })).data.node;
    expect(node.outputSchema).toEqual(objectSchemaValue);
    expect(node.schema).toEqual(objectSchemaValue);
    expect(typeof node.outputSchema).toBe("object");
  });

  it("accepts a stringified input schema and persists the parsed object", async () => {
    const res = await call("workspace.update_node_input_schema", { id: "input_triage", schema: JSON.stringify(objectSchemaValue) });
    expect(structured(res).ok).toBe(true);
    expect(structured(await call("workspace.get_node", { id: "input_triage" })).data.node.inputSchema).toEqual(objectSchemaValue);
  });

  it("still accepts a plain object schema unchanged", async () => {
    const res = await call("workspace.update_node_output_schema", { id: "input_triage", schema: objectSchemaValue });
    expect(structured(res).ok).toBe(true);
    expect(structured(await call("workspace.get_node", { id: "input_triage" })).data.node.outputSchema).toEqual(objectSchemaValue);
  });

  it("refuses a schema string that is not valid JSON, writing nothing", async () => {
    const before = structured(await call("workspace.get_node", { id: "input_triage" })).data.node.outputSchema;
    const res = await call("workspace.update_node_output_schema", { id: "input_triage", schema: "{ not valid json" });
    expect(errorText(res)).toContain("invalid_schema");
    expect(structured(await call("workspace.get_node", { id: "input_triage" })).data.node.outputSchema).toEqual(before);
  });

  it("refuses a schema of the wrong shape rather than corrupting the node", async () => {
    const res = await call("workspace.update_node_output_schema", { id: "input_triage", schema: JSON.stringify(["not", "a", "schema"]) });
    expect(errorText(res)).toContain("invalid_schema");
  });

  it("still refuses a patch that omits schema entirely (no silent overwrite)", async () => {
    const before = structured(await call("workspace.get_node", { id: "input_triage" })).data.node.outputSchema;
    const res = await call("workspace.update_node_output_schema", { id: "input_triage" });
    expect(res.error ?? res.result?.structuredContent?.ok).toBeTruthy();
    expect(structured(await call("workspace.get_node", { id: "input_triage" })).data.node.outputSchema).toEqual(before);
  });
});

describe("coerceSchemaInput", () => {
  it("parses strings, passes objects and booleans, and rejects other shapes", () => {
    expect(coerceSchemaInput('{"type":"object"}')).toEqual({ type: "object" });
    expect(coerceSchemaInput({ type: "string" })).toEqual({ type: "string" });
    // Both boolean JSON Schemas are legal, stringified or not.
    expect(coerceSchemaInput(true)).toBe(true);
    expect(coerceSchemaInput(false)).toBe(false);
    expect(coerceSchemaInput("true")).toBe(true);
    expect(() => coerceSchemaInput("nope")).toThrow(/invalid_schema/);
    expect(() => coerceSchemaInput(["x"])).toThrow(/invalid_schema/);
    expect(() => coerceSchemaInput('["x"]')).toThrow(/invalid_schema/);
    expect(() => coerceSchemaInput(42 as unknown)).toThrow(/invalid_schema/);
    expect(() => coerceSchemaInput(null)).toThrow(/invalid_schema/);
    expect(() => coerceSchemaInput(undefined)).toThrow(/invalid_schema/);
  });
});

describe("parseWorkspaceDocumentTolerant", () => {
  it("drops unusable node records and reports the count instead of throwing", () => {
    const base = createDefaultWorkspaceDocument();
    const validCount = base.nodes.length;
    // Inject a corrupt node record shaped like the live failure: a spread string with no id/name.
    const corrupt = { "0": "{", "1": "\"", kind: "workspace", updatedAt: new Date().toISOString() };
    const raw = { ...base, nodes: [...base.nodes, corrupt] };

    const { document, droppedNodes } = parseWorkspaceDocumentTolerant(raw);
    expect(droppedNodes).toBe(1);
    expect(document.nodes).toHaveLength(validCount);
    expect(document.nodes.every((node) => typeof node.id === "string" && node.id.length > 0)).toBe(true);
  });

  it("returns zero dropped for a clean document", () => {
    const { droppedNodes } = parseWorkspaceDocumentTolerant(createDefaultWorkspaceDocument());
    expect(droppedNodes).toBe(0);
  });
});
