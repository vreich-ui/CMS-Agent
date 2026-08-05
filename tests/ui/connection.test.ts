import { describe, expect, it } from "vitest";
import { redactSecretText, redactSecretValue, summarizeConnectionAuth } from "../../ui/src/connection.js";
import type { McpConnection } from "../../ui/src/connection.js";

describe("summarizeConnectionAuth", () => {
  it("reports missing vs ready from the token alone — Cloud Run is the sole plane, always direct token auth", () => {
    const connection: McpConnection = { endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "" };
    expect(summarizeConnectionAuth(connection).kind).toBe("direct-missing-token");
    expect(summarizeConnectionAuth({ ...connection, token: "t" }).kind).toBe("direct-ready");
  });

  it("treats whitespace-only tokens as missing and never includes the token in the label", () => {
    const summary = summarizeConnectionAuth({ endpoint: "/mcp", token: "  secret-value  " });
    expect(summary.kind).toBe("direct-ready");
    expect(summary.label).not.toContain("secret-value");
    expect(summarizeConnectionAuth({ endpoint: "/mcp", token: "   " }).kind).toBe("direct-missing-token");
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
