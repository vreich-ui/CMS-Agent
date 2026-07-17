import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePublish } from "../src/hooks/usePublish";
import type { McpClient } from "../src/mcp/client";
import type { PublishReadinessResponse, PublishResult } from "../src/types/workspace";

const makeClient = (call: McpClient["call"]): McpClient => ({ method: async () => { throw new Error("unused"); }, call });

const goReadiness: PublishReadinessResponse = { available: true, articleBodyValid: true, readiness: { status: "go", state: "ready_for_publish_execution", checklist: [], blockers: [], hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false } } };

const blockedResult: PublishResult = {
  published: false,
  mode: "blocked_for_publish_execution",
  gates: { operatorEnabled: false, approved: false, live: false, allPassed: false, gates: [] },
  plan: { projectId: "dr-lurie", requestId: "req_x", nodeCount: 1, publishedTime: null, toolSequence: [] },
  steps: [],
  readiness: { status: "no_go", state: "blocked_for_publish_execution", checklist: [], blockers: ["pinned_approval"], requiredAction: "Resolve: pinned_approval.", hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false } },
  blocked: { requestId: "req_x", nodeAwaitingApproval: "publication_controller", artifactSlot: null, requiredAction: "Resolve: pinned_approval.", resumable: true }
};

describe("usePublish", () => {
  it("calls workflow.publish_readiness with only the provided args and stores the response", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = makeClient(async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ name, args });
      return { readiness: goReadiness } as T;
    });
    const { result } = renderHook(() => usePublish(client));

    await act(async () => { await result.current.checkReadiness({ projectId: "dr-lurie", runId: "run_1", readiness: { releaseBehavior: "publish_now" } }); });

    expect(calls[0]).toEqual({ name: "workflow.publish_readiness", args: { projectId: "dr-lurie", runId: "run_1", readiness: { releaseBehavior: "publish_now" } } });
    expect(result.current.readiness?.available).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("omits runId/readiness when absent", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = makeClient(async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => { calls.push({ name, args }); return { readiness: goReadiness } as T; });
    const { result } = renderHook(() => usePublish(client));

    await act(async () => { await result.current.checkReadiness({ projectId: "dr-lurie" }); });

    expect(calls[0]).toEqual({ name: "workflow.publish_readiness", args: { projectId: "dr-lurie" } });
  });

  it("stores the publish result and syncs readiness from a blocked_for_publish_execution response", async () => {
    const client = makeClient(async <T,>(name: string): Promise<T> => {
      if (name === "workflow.publish_run") return { publish: blockedResult } as T;
      throw new Error(`unexpected ${name}`);
    });
    const { result } = renderHook(() => usePublish(client));

    await act(async () => { await result.current.publish({ projectId: "dr-lurie", runId: "run_1", requestId: "req_x", approved: false, live: false }); });

    expect(result.current.publishResult?.mode).toBe("blocked_for_publish_execution");
    // The readiness view is kept in step with whatever the publish path evaluated.
    expect(result.current.readiness?.readiness?.status).toBe("no_go");
  });

  it("surfaces a thrown error as inline error state and rethrows", async () => {
    const client = makeClient(async () => { throw new Error("boom"); });
    const { result } = renderHook(() => usePublish(client));

    await act(async () => { await expect(result.current.checkReadiness({ projectId: "dr-lurie" })).rejects.toThrow("boom"); });

    expect(result.current.error).toBe("boom");
  });
});
