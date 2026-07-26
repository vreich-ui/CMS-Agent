import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMcpClient } from "../src/hooks/useMcpClient";
import type { McpConnection } from "../src/connection";

// Root cause of the split-brain bug: the client's referential identity never changed when the
// connection (mode/endpoint/credential) did, so every hook keyed on [client] (useWorkspace,
// useChanges, useProjects, ...) never re-ran. These tests pin the fixed identity behavior
// directly, independent of any consuming hook.

describe("useMcpClient — identity tracks the connection", () => {
  it("keeps the SAME client identity across a re-render with an equal-fields (but new object) connection", () => {
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { mode: "direct", endpoint: "/api/mcp", token: "tok" } as McpConnection }
    });
    const first = result.current;

    // A brand-new object with IDENTICAL field values — App.tsx's own connection useMemo would
    // never actually produce this (it's itself memoized), but useMcpClient must not regress into
    // depending on the connection object's reference either.
    rerender({ connection: { mode: "direct", endpoint: "/api/mcp", token: "tok" } as McpConnection });
    expect(result.current).toBe(first);
  });

  it("changes identity when the endpoint changes", () => {
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { mode: "direct", endpoint: "/api/mcp", token: "tok" } as McpConnection }
    });
    const first = result.current;
    rerender({ connection: { mode: "direct", endpoint: "https://cloud-run.example/mcp", token: "tok" } as McpConnection });
    expect(result.current).not.toBe(first);
  });

  it("changes identity when the direct-mode token changes", () => {
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { mode: "direct", endpoint: "/api/mcp", token: "old-token" } as McpConnection }
    });
    const first = result.current;
    rerender({ connection: { mode: "direct", endpoint: "/api/mcp", token: "new-token" } as McpConnection });
    expect(result.current).not.toBe(first);
  });

  it("changes identity when switching mode (direct <-> secure-proxy) even with the same endpoint", () => {
    const getAccessToken = async () => "jwt";
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { mode: "direct", endpoint: "/api/mcp", token: "tok" } as McpConnection }
    });
    const first = result.current;
    rerender({ connection: { mode: "secure-proxy", endpoint: "/api/mcp", getAccessToken } as McpConnection });
    expect(result.current).not.toBe(first);
  });

  it("changes identity when the secure-proxy token getter changes, keeping the same identity if it doesn't", () => {
    const getAccessTokenA = async () => "a";
    const getAccessTokenB = async () => "b";
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { mode: "secure-proxy", endpoint: "/api/mcp", getAccessToken: getAccessTokenA } as McpConnection }
    });
    const first = result.current;

    // Same getter reference (e.g. a re-render for an unrelated reason) — identity is stable.
    rerender({ connection: { mode: "secure-proxy", endpoint: "/api/mcp", getAccessToken: getAccessTokenA } as McpConnection });
    expect(result.current).toBe(first);

    // A different getter reference — identity changes.
    rerender({ connection: { mode: "secure-proxy", endpoint: "/api/mcp", getAccessToken: getAccessTokenB } as McpConnection });
    expect(result.current).not.toBe(first);
  });

  it("this is exactly the signal downstream [client]-effects depend on — the plane-switch scenario changes identity", () => {
    // Mirrors App.tsx's handlePlaneChange: Netlify (secure-proxy) -> Cloud Run (direct, forced).
    const getAccessToken = async () => "jwt";
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { mode: "secure-proxy", endpoint: "/api/workspace-mcp", getAccessToken } as McpConnection }
    });
    const netlifyClient = result.current;
    rerender({ connection: { mode: "direct", endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "" } as McpConnection });
    expect(result.current).not.toBe(netlifyClient);
  });
});
