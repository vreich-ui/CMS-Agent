import { describe, expect, it } from "vitest";
import { defaultEndpointForMode, redactSecretText, redactSecretValue, summarizeConnectionAuth } from "../../ui/src/connection.js";
import type { McpConnection } from "../../ui/src/connection.js";

describe("defaultEndpointForMode", () => {
  it("maps each mode to its endpoint default", () => {
    expect(defaultEndpointForMode("direct")).toBe("/api/mcp");
    expect(defaultEndpointForMode("secure-proxy")).toBe("/api/workspace-mcp");
  });
});

describe("summarizeConnectionAuth", () => {
  const proxy: McpConnection = { mode: "secure-proxy", endpoint: "/api/workspace-mcp", getAccessToken: async () => "jwt" };

  it("models auth state explicitly from the union, never from the endpoint string", () => {
    // A direct connection pointed at the proxy path is still direct: the token is still required
    // and still used. The endpoint value carries no authentication meaning.
    expect(summarizeConnectionAuth({ mode: "direct", endpoint: "/api/workspace-mcp", token: "" }).kind).toBe("direct-missing-token");
    expect(summarizeConnectionAuth({ mode: "direct", endpoint: "/api/workspace-mcp", token: "t" }).kind).toBe("direct-ready");
    expect(summarizeConnectionAuth(proxy).kind).toBe("secure-proxy");
  });

  it("treats whitespace-only tokens as missing and never includes the token in the label", () => {
    const summary = summarizeConnectionAuth({ mode: "direct", endpoint: "/api/mcp", token: "  secret-value  " });
    expect(summary.kind).toBe("direct-ready");
    expect(summary.label).not.toContain("secret-value");
    expect(summarizeConnectionAuth({ mode: "direct", endpoint: "/api/mcp", token: "   " }).kind).toBe("direct-missing-token");
  });
});

describe("redaction helpers", () => {
  it("redacts bearer values in text regardless of casing", () => {
    expect(redactSecretText("failed: BEARER abc.DEF_123 and bearer xyz-9")).toBe("failed: Bearer [redacted] and Bearer [redacted]");
  });

  it("redacts credential-named keys and nested bearer strings in structured values", () => {
    expect(redactSecretValue({
      authorization: "Bearer a",
      Token: "b",
      apiKey: "c",
      api_key: "d",
      cookie: "e",
      passkey: "f",
      jwt: "g",
      list: ["Bearer h.1", { secretToken: "i" }],
      safe: { value: 42, note: "no credentials here" }
    })).toEqual({
      authorization: "[redacted]",
      Token: "[redacted]",
      apiKey: "[redacted]",
      api_key: "[redacted]",
      cookie: "[redacted]",
      passkey: "[redacted]",
      jwt: "[redacted]",
      list: ["Bearer [redacted]", { secretToken: "[redacted]" }],
      safe: { value: 42, note: "no credentials here" }
    });
  });

  it("caps recursion depth instead of overflowing on cyclic-deep structures", () => {
    let deep: Record<string, unknown> = { value: "Bearer deep-secret-value" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    const result = JSON.stringify(redactSecretValue(deep));
    expect(result).toContain("[redacted: depth limit]");
    expect(result).not.toContain("deep-secret-value");
  });

  it("leaves prose mentions of tokens readable while still catching realistic values", () => {
    expect(redactSecretText("Enter an MCP bearer token before calling workspace tools.")).toBe("Enter an MCP bearer token before calling workspace tools.");
    expect(redactSecretText("rejected bearer local-mcp-token")).toBe("rejected Bearer [redacted]");
  });

  it("passes through primitives untouched", () => {
    expect(redactSecretValue(42)).toBe(42);
    expect(redactSecretValue(null)).toBeNull();
    expect(redactSecretValue(true)).toBe(true);
  });
});
