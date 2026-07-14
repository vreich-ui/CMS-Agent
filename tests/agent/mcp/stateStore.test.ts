import { describe, expect, it } from "vitest";
import { mcpStateUsesBlobs } from "../../../src/agent/mcp/state/stateStore.js";

// netlifyBlobsContextConnected() is false in the test process (no real Blobs context is ever
// connected here), so these cases exercise the explicit-override and WORKSPACE_STORE precedence.
const env = (over: Record<string, string | undefined>) => over as NodeJS.ProcessEnv;

describe("mcpStateUsesBlobs", () => {
  it("honors the explicit MCP_STATE_STORE override first", () => {
    expect(mcpStateUsesBlobs(env({ MCP_STATE_STORE: "blobs" }))).toBe(true);
    // Explicit memory wins even when the workspace store is on blobs.
    expect(mcpStateUsesBlobs(env({ MCP_STATE_STORE: "memory", WORKSPACE_STORE: "blobs" }))).toBe(false);
    expect(mcpStateUsesBlobs(env({ MCP_STATE_STORE: "BLOBS" }))).toBe(true); // case-insensitive
  });

  it("follows WORKSPACE_STORE when no explicit override is set", () => {
    expect(mcpStateUsesBlobs(env({ WORKSPACE_STORE: "blobs" }))).toBe(true);
    expect(mcpStateUsesBlobs(env({ WORKSPACE_STORE: "memory" }))).toBe(false);
  });

  it("falls back to memory when nothing indicates a durable store (local/test)", () => {
    expect(mcpStateUsesBlobs(env({}))).toBe(false);
  });
});
