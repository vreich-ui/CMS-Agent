import { describe, expect, it } from "vitest";
import { isEventStreamBody, unframeJsonRpcBody } from "../../../scripts/verifyDeployment.js";

// Bonus task, measured 2026-09-14: `npm run verify:deploy` was unusable because the SSE detection was
// a substring search over the whole body, and one tool description contains the prose "structural
// data: agent summaries". The check fired on valid JSON, the unframing kept zero lines, and
// JSON.parse("") threw — with an error message that printed the valid JSON it had just rejected.
const TOOLS_LIST_JSON = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { tools: [{ name: "constellation_get_structure", description: "Return the constellation structural data: agent summaries, stored typed relationships, and execution edges derived from node.dependsOn. Read-only." }] }
});

describe("verify:deploy response framing", () => {
  it("parses a plain-JSON body whose content contains the literal \"data:\" inside a string", () => {
    expect(isEventStreamBody(TOOLS_LIST_JSON, "application/json")).toBe(false);
    expect(isEventStreamBody(TOOLS_LIST_JSON, null)).toBe(false);
    expect(JSON.parse(unframeJsonRpcBody(TOOLS_LIST_JSON, "application/json")).result.tools).toHaveLength(1);
    expect(JSON.parse(unframeJsonRpcBody(TOOLS_LIST_JSON, null)).result.tools).toHaveLength(1);
  });

  it("still unframes a real SSE body, by content-type", () => {
    const sse = `event: message\ndata: ${TOOLS_LIST_JSON}\n\n`;
    expect(isEventStreamBody(sse, "text/event-stream")).toBe(true);
    expect(JSON.parse(unframeJsonRpcBody(sse, "text/event-stream; charset=utf-8")).result.tools).toHaveLength(1);
  });

  it("falls back to a LINE-ANCHORED test when the server sends no usable content-type", () => {
    const sse = `data: ${TOOLS_LIST_JSON}\n\n`;
    expect(isEventStreamBody(sse, null)).toBe(true);
    expect(isEventStreamBody(sse, "")).toBe(true);
    expect(JSON.parse(unframeJsonRpcBody(sse, undefined)).result.tools).toHaveLength(1);
  });

  it("joins a multi-line SSE body back into one JSON-RPC message", () => {
    const sse = `event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"ok":true}}\n\n`;
    expect(JSON.parse(unframeJsonRpcBody(sse, "text/event-stream")).result).toEqual({ ok: true });
  });
});
