import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../src/agent/runtime/repositories.js";
import { BlobWorkspaceRepository } from "../../src/agent/repository/blobs/BlobWorkspaceRepository.js";
import type { BlobStoreClient } from "../../src/agent/repository/blobs/blobClient.js";
import { createDefaultWorkspaceDocument } from "../../src/agent/mcp/workspace/store.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = (res: any) => res.result?.structuredContent?.data;
const errorText = (res: any) => JSON.stringify(res.error?.data ?? res.error ?? {});

describe("workspaceVersion consistency (read / return / enforce one version)", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("update_node_prompt returns the version its own mutation produced, matching the current version", async () => {
    const created = await call("workspace.create_node", { node: { id: "v_node", name: "V Node", prompt: "Draft." } });
    const createdVersion = data(created).workspaceVersion;

    const updated = await call("workspace.update_node_prompt", { id: "v_node", prompt: "Updated." });
    const reportedVersion = data(updated).workspaceVersion;

    // The mutation reports exactly one increment over the create, not a later/older racy read.
    expect(reportedVersion).toBe(createdVersion + 1);
    // A subsequent read agrees with the version the mutation reported.
    const health = await call("repository.get_health");
    expect(data(health).health.workspaceVersion).toBe(reportedVersion);
  });

  it("the version a mutation reports is the enforceable current version for the next optimistic write", async () => {
    const created = await call("workspace.create_node", { node: { id: "v_node2", name: "V Node 2", prompt: "Draft." } });
    const version = data(created).workspaceVersion;

    // Enforcing the exact reported version succeeds (no false conflict).
    const ok = await call("workspace.update_node_prompt", { id: "v_node2", prompt: "Next.", expectedWorkspaceVersion: version });
    expect(data(ok).workspaceVersion).toBe(version + 1);

    // Re-using the now-stale version is rejected as a conflict.
    const stale = await call("workspace.update_node_prompt", { id: "v_node2", prompt: "Stale.", expectedWorkspaceVersion: version });
    expect(errorText(stale)).toContain("workspace_version_conflict");
  });
});

describe("BlobWorkspaceRepository version monotonicity under eventual consistency", () => {
  it("getWorkspaceVersion never regresses below a version this instance committed", async () => {
    let served: unknown = null;
    const store = {
      get: async () => (served === null ? null : structuredClone(served)),
      setJSON: async (_key: string, value: unknown) => { served = structuredClone(value); },
      list: async () => ({ blobs: [], directories: [] }),
      delete: async () => {}
    } as unknown as BlobStoreClient;

    const repo = new BlobWorkspaceRepository(store);
    const first = await repo.updateNodePrompt("input_triage", "First.");
    expect(first.workspaceVersion).toBe(1);
    const staleSnapshot = structuredClone(served); // a replica frozen at version 1

    const second = await repo.updateNodePrompt("input_triage", "Second.");
    expect(second.workspaceVersion).toBe(2);

    // Simulate an eventually-consistent replica answering the next read with the older snapshot.
    served = staleSnapshot;

    // Without the monotonic guard this reports 1 — older than a version already committed here.
    expect(await repo.getWorkspaceVersion()).toBe(2);
    // And a read of the node still reflects the newest committed prompt, not the stale replica.
    expect((await repo.getNode("input_triage"))?.prompt).toBe("Second.");
  });
});

describe("BlobWorkspaceRepository stale-read reconciliation (cross-instance eventual consistency)", () => {
  const docAt = (version: number) => ({ ...createDefaultWorkspaceDocument(), workspaceVersion: version });

  it("reconciles a lagging read so an expectedWorkspaceVersion a prior mutation returned is enforced, not falsely conflicted", async () => {
    // A fresh instance first reads a lagging v1, then the propagated v2. The caller expects v2 (the
    // version a prior mutation reported). Without reconciliation this throws expected 2 / current 1.
    let reads = 0;
    let written: any = null;
    const store = {
      get: async () => structuredClone(reads++ < 1 ? docAt(1) : docAt(2)),
      setJSON: async (_key: string, value: unknown) => { written = structuredClone(value); },
      list: async () => ({ blobs: [], directories: [] }),
      delete: async () => {}
    } as unknown as BlobStoreClient;

    const repo = new BlobWorkspaceRepository(store);
    const result = await repo.updateNodePrompt("input_triage", "Reconciled.", { expectedWorkspaceVersion: 2 });

    expect(result.workspaceVersion).toBe(3);
    expect(written.workspaceVersion).toBe(3);
    expect(reads).toBeGreaterThanOrEqual(2); // it reloaded to catch up
  });

  it("still rejects a genuinely stale expectation (expected older than current) without looping", async () => {
    let reads = 0;
    const store = {
      get: async () => { reads++; return structuredClone(docAt(5)); },
      setJSON: async () => {},
      list: async () => ({ blobs: [], directories: [] }),
      delete: async () => {}
    } as unknown as BlobStoreClient;

    const repo = new BlobWorkspaceRepository(store);
    await expect(repo.updateNodePrompt("input_triage", "x", { expectedWorkspaceVersion: 3 })).rejects.toThrow(/workspace_version_conflict/);
    // expected < current is a real conflict, so no reconciliation reloads happen.
    expect(reads).toBe(1);
  });
});
