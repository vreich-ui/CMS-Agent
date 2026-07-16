import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../src/agent/runtime/repositories.js";
import { BlobWorkspaceRepository } from "../../src/agent/repository/blobs/BlobWorkspaceRepository.js";
import type { BlobStoreClient } from "../../src/agent/repository/blobs/blobClient.js";

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
