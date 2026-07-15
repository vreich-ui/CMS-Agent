import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import {
  coerceNodeInput,
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
