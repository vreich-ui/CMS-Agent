import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_CREDENTIALS_POLL_INTERVAL_MS, useSiteCredentials } from "../src/hooks/useSiteCredentials";
import type { McpClient } from "../src/mcp/client";
import type { SiteCredentialExecutionStatus, SiteCredentialPlan } from "../src/types/workspace";

const plan = (staleCount: number): SiteCredentialPlan => ({
  mode: "dry_run",
  staleCount,
  results: [
    { projectId: "dr-lurie", netlifySiteName: "dr-lurie-skincare", status: staleCount > 0 ? "planned" : "current" },
    { projectId: "kugel-platform", netlifySiteName: "kugel-platform", status: "current" }
  ]
});

function makeClient(handler: (name: string, args?: Record<string, unknown>) => unknown): McpClient {
  return {
    method: async () => { throw new Error("unused"); },
    call: async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => handler(name, args) as T
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useSiteCredentials", () => {
  it("loads the plan on mount", async () => {
    const client = makeClient((name) => {
      if (name === "site_credentials_plan") return plan(1);
      throw new Error(`unexpected ${name}`);
    });
    const { result } = renderHook(() => useSiteCredentials(client));

    await waitFor(() => expect(result.current.plan).not.toBeNull());
    expect(result.current.plan?.staleCount).toBe(1);
    expect(result.current.planError).toBeNull();
  });

  it("surfaces a plan fetch error", async () => {
    const client = makeClient((name) => {
      if (name === "site_credentials_plan") throw new Error("no route to Cloud Run");
      throw new Error(`unexpected ${name}`);
    });
    const { result } = renderHook(() => useSiteCredentials(client));

    await waitFor(() => expect(result.current.planError).toBe("no route to Cloud Run"));
    expect(result.current.plan).toBeNull();
  });

  it("fires apply, gets immediate first-status feedback, and polls until a terminal state stops it", async () => {
    const planCalls: number[] = [];
    let statusCallCount = 0;
    const client = makeClient((name) => {
      if (name === "site_credentials_plan") { planCalls.push(Date.now()); return plan(1); }
      if (name === "site_credentials_apply") return { executionName: "exec_1", jobName: "reconcile-site-credentials" };
      if (name === "site_credentials_execution_status") {
        statusCallCount += 1;
        const status: SiteCredentialExecutionStatus = statusCallCount < 3
          ? { state: "ACTIVE" }
          : { state: "SUCCEEDED", succeededCount: 1, failedCount: 0 };
        return status;
      }
      throw new Error(`unexpected ${name}`);
    });

    const { result } = renderHook(() => useSiteCredentials(client));
    await waitFor(() => expect(result.current.plan?.staleCount).toBe(1));
    vi.useFakeTimers();

    await act(async () => { await result.current.apply(); });
    // apply() awaits one immediate status check before returning — no need to advance a timer to
    // see the first poll's effect.
    expect(statusCallCount).toBe(1);
    expect(result.current.applying).toBe(true);
    expect(result.current.executionName).toBe("exec_1");
    expect(result.current.execution?.state).toBe("ACTIVE");

    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_CREDENTIALS_POLL_INTERVAL_MS); });
    expect(statusCallCount).toBe(2);
    expect(result.current.applying).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_CREDENTIALS_POLL_INTERVAL_MS); });
    expect(statusCallCount).toBe(3);
    expect(result.current.applying).toBe(false);
    expect(result.current.execution?.state).toBe("SUCCEEDED");

    // Polling must actually stop at the terminal state: no further status calls even much later.
    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_CREDENTIALS_POLL_INTERVAL_MS * 5); });
    expect(statusCallCount).toBe(3);

    // Reaching a terminal state re-fetches the plan automatically (mount fetch + post-terminal fetch).
    expect(planCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a partly-failed execution instead of swallowing it", async () => {
    const client = makeClient((name) => {
      if (name === "site_credentials_plan") return plan(2);
      if (name === "site_credentials_apply") return { executionName: "exec_2", jobName: "reconcile-site-credentials" };
      if (name === "site_credentials_execution_status") return { state: "SUCCEEDED", succeededCount: 1, failedCount: 1 };
      throw new Error(`unexpected ${name}`);
    });

    const { result } = renderHook(() => useSiteCredentials(client));
    await waitFor(() => expect(result.current.plan?.staleCount).toBe(2));
    vi.useFakeTimers();

    await act(async () => { await result.current.apply(); });

    expect(result.current.applying).toBe(false);
    expect(result.current.execution).toEqual({ state: "SUCCEEDED", succeededCount: 1, failedCount: 1 });
  });

  it("keeps polling through a transient status-check error instead of stopping silently", async () => {
    let statusCallCount = 0;
    const client = makeClient((name) => {
      if (name === "site_credentials_plan") return plan(1);
      if (name === "site_credentials_apply") return { executionName: "exec_3", jobName: "job" };
      if (name === "site_credentials_execution_status") {
        statusCallCount += 1;
        if (statusCallCount === 1) throw new Error("network blip");
        return { state: "SUCCEEDED", succeededCount: 1, failedCount: 0 };
      }
      throw new Error(`unexpected ${name}`);
    });

    const { result } = renderHook(() => useSiteCredentials(client));
    await waitFor(() => expect(result.current.plan?.staleCount).toBe(1));
    vi.useFakeTimers();

    await act(async () => { await result.current.apply(); });
    expect(result.current.applyError).toBe("network blip");
    expect(result.current.applying).toBe(true); // still running — the job itself didn't fail, the status check did

    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_CREDENTIALS_POLL_INTERVAL_MS); });
    expect(statusCallCount).toBe(2);
    expect(result.current.applying).toBe(false);
  });

  it("does not leak a poll timer after unmount", async () => {
    let statusCallCount = 0;
    const client = makeClient((name) => {
      if (name === "site_credentials_plan") return plan(1);
      if (name === "site_credentials_apply") return { executionName: "exec_4", jobName: "job" };
      if (name === "site_credentials_execution_status") { statusCallCount += 1; return { state: "ACTIVE" }; }
      throw new Error(`unexpected ${name}`);
    });

    const { result, unmount } = renderHook(() => useSiteCredentials(client));
    await waitFor(() => expect(result.current.plan?.staleCount).toBe(1));
    vi.useFakeTimers();

    await act(async () => { await result.current.apply(); });
    expect(statusCallCount).toBe(1);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_CREDENTIALS_POLL_INTERVAL_MS * 5); });
    expect(statusCallCount).toBe(1);
  });

  it("clears plan and execution state, and cancels an in-flight poll, when the client changes", async () => {
    let statusCallCount = 0;
    const clientA = makeClient((name) => {
      if (name === "site_credentials_plan") return plan(1);
      if (name === "site_credentials_apply") return { executionName: "exec_a", jobName: "job" };
      if (name === "site_credentials_execution_status") { statusCallCount += 1; return { state: "ACTIVE" }; }
      throw new Error(`unexpected ${name}`);
    });
    const clientB = makeClient((name) => {
      if (name === "site_credentials_plan") return plan(0);
      throw new Error(`unexpected ${name} on clientB`);
    });

    const { result, rerender } = renderHook(({ client }) => useSiteCredentials(client), { initialProps: { client: clientA } });
    await waitFor(() => expect(result.current.plan?.staleCount).toBe(1));
    vi.useFakeTimers();

    await act(async () => { await result.current.apply(); });
    expect(statusCallCount).toBe(1);
    expect(result.current.executionName).toBe("exec_a");

    rerender({ client: clientB });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.plan?.staleCount).toBe(0);
    expect(result.current.executionName).toBeNull();
    expect(result.current.execution).toBeNull();
    expect(result.current.applying).toBe(false);

    // The old client's poll must not still be running against the new connection.
    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_CREDENTIALS_POLL_INTERVAL_MS * 5); });
    expect(statusCallCount).toBe(1);
  });
});
