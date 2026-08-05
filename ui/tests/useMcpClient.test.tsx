import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMcpClient } from "../src/hooks/useMcpClient";
import type { McpConnection } from "../src/connection";

// Root cause of the split-brain bug: the client's referential identity never changed when the
// connection (endpoint/credential) did, so every hook keyed on [client] (useWorkspace,
// useChanges, useProjects, ...) never re-ran. These tests pin the fixed identity behavior
// directly, independent of any consuming hook. Cloud Run is the sole control plane — the
// connection is just { endpoint, token }.

describe("useMcpClient — identity tracks the connection", () => {
  it("keeps the SAME client identity across a re-render with an equal-fields (but new object) connection", () => {
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "tok" } }
    });
    const first = result.current;

    // A brand-new object with IDENTICAL field values — App.tsx's own connection useMemo would
    // never actually produce this (it's itself memoized), but useMcpClient must not regress into
    // depending on the connection object's reference either.
    rerender({ connection: { endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "tok" } });
    expect(result.current).toBe(first);
  });

  it("changes identity when the endpoint changes (e.g. a local-dev override)", () => {
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "tok" } }
    });
    const first = result.current;
    rerender({ connection: { endpoint: "http://localhost:9999/mcp", token: "tok" } });
    expect(result.current).not.toBe(first);
  });

  it("changes identity when the bearer token changes", () => {
    const { result, rerender } = renderHook(({ connection }: { connection: McpConnection }) => useMcpClient(connection), {
      initialProps: { connection: { endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "old-token" } }
    });
    const first = result.current;
    rerender({ connection: { endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "new-token" } });
    expect(result.current).not.toBe(first);
  });
});
