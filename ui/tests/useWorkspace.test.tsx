import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWorkspace } from "../src/hooks/useWorkspace";
import type { McpClient } from "../src/mcp/client";
import type { WorkspaceNode } from "../src/types/workspace";

// Split-brain bug (control-plane / connection switch left the node inspector and Constellation
// canvas showing the PREVIOUS plane's data): useMcpClient now gives the client a new identity on
// every connection-affecting change, and useWorkspace refetches — and resets — whenever that
// identity changes. These tests exercise useWorkspace directly against two distinct clients.

const node = (id: string, name: string): WorkspaceNode => ({
  id, name, prompt: "prompt", kind: "agent", status: "active", riskLevel: "read", dependsOn: [], position: { x: 0, y: 0 }
} as unknown as WorkspaceNode);

// A client whose workspace.get_nodes resolves to `nodes`. Resolution can be deferred via a gate
// promise so a test can inspect state BEFORE the fetch settles (simulating a slow/in-flight load).
const makeClient = (nodes: WorkspaceNode[], gate?: Promise<void>): McpClient => ({
  method: async () => { throw new Error("unused"); },
  call: async <T,>(name: string): Promise<T> => {
    if (gate) await gate;
    if (name === "workspace.get_nodes") return { nodes } as T;
    if (name === "article_body.get_schema") return { schema: { type: "object" } } as T;
    if (name === "workspace.export_workspace") return { workspaceVersion: 1 } as T;
    throw new Error(`unexpected tool call: ${name}`);
  }
});

const failingClient = (message: string): McpClient => ({
  method: async () => { throw new Error("unused"); },
  call: async () => { throw new Error(message); }
});

describe("useWorkspace — auto-load and refetch on client change", () => {
  it("auto-loads on mount, and refetches when the client identity changes: B's nodes, never A's", async () => {
    const clientA = makeClient([node("input_triage", "Publishing Input Triage")]);
    const clientB = makeClient([node("input_triage", "CMS Input Triage")]);
    const { result, rerender } = renderHook(({ client }) => useWorkspace(client), { initialProps: { client: clientA } });

    await act(async () => {});
    expect(result.current.nodes.map((n) => n.name)).toEqual(["Publishing Input Triage"]);

    rerender({ client: clientB });
    await act(async () => {});
    expect(result.current.nodes.map((n) => n.name)).toEqual(["CMS Input Triage"]);
  });

  it("clears state synchronously on a client swap — no frame renders A's nodes under B's connection", async () => {
    const clientA = makeClient([node("input_triage", "Publishing Input Triage")]);
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseB = resolve; });
    const clientB = makeClient([node("input_triage", "CMS Input Triage")], gate);

    const { result, rerender } = renderHook(({ client }) => useWorkspace(client), { initialProps: { client: clientA } });
    await act(async () => {});
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.selectedId).toBe("input_triage");

    rerender({ client: clientB }); // B's fetch is gated shut — it has not resolved yet
    // Immediately after the swap, before B's fetch has any chance to settle, state must already
    // be cleared — this is the exact assertion the reported bug violated (the inspector kept
    // showing "Publishing Input Triage" instead of resetting/updating).
    expect(result.current.nodes).toEqual([]);
    expect(result.current.selectedId).toBeNull();
    expect(result.current.promptDraft).toBe("");
    expect(result.current.loading).toBe(true);

    releaseB();
    await act(async () => {});
    expect(result.current.nodes.map((n) => n.name)).toEqual(["CMS Input Triage"]);
    expect(result.current.loading).toBe(false);
  });

  it("an out-of-order response from a superseded client never overwrites the newer client's state", async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const clientA = makeClient([node("input_triage", "Publishing Input Triage")], gateA);
    const clientB = makeClient([node("input_triage", "CMS Input Triage")]);

    // A's initial mount load starts and immediately blocks on the gate.
    const { result, rerender } = renderHook(({ client }) => useWorkspace(client), { initialProps: { client: clientA } });

    // Switch to B before A's load has any chance to resolve.
    rerender({ client: clientB });
    await act(async () => {}); // B's (ungated) load resolves
    expect(result.current.nodes.map((n) => n.name)).toEqual(["CMS Input Triage"]);

    // Now let A's stale, superseded response resolve — it must be discarded, not applied.
    releaseA();
    await act(async () => {});
    expect(result.current.nodes.map((n) => n.name)).toEqual(["CMS Input Triage"]);
  });

  it("a failed auto-load surfaces loadError and leaves nodes empty rather than stale", async () => {
    const client = failingClient("connection refused");
    const { result } = renderHook(() => useWorkspace(client));

    await act(async () => {});
    expect(result.current.nodes).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe("connection refused");
  });

  it("switching from a failed client back to a working one clears loadError and loads fresh nodes", async () => {
    const badClient = failingClient("connection refused");
    const goodClient = makeClient([node("input_triage", "CMS Input Triage")]);
    const { result, rerender } = renderHook(({ client }) => useWorkspace(client), { initialProps: { client: badClient } });

    await act(async () => {});
    expect(result.current.loadError).toBe("connection refused");

    rerender({ client: goodClient });
    expect(result.current.loadError).toBeNull(); // cleared synchronously, not just after the new load succeeds
    await act(async () => {});
    expect(result.current.loadError).toBeNull();
    expect(result.current.nodes.map((n) => n.name)).toEqual(["CMS Input Triage"]);
  });

  it("a manual loadWorkspace() call still rejects for callers that want to react themselves", async () => {
    const client = failingClient("boom");
    const { result } = renderHook(() => useWorkspace(client));
    await act(async () => {});

    await act(async () => {
      await expect(result.current.loadWorkspace()).rejects.toThrow("boom");
    });
    expect(result.current.loadError).toBe("boom");
  });
});
