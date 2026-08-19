import { describe, expect, it } from "vitest";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";
import {
  MANAGED_SCOPED_BEARER_REGISTRY_KEY,
  ManagedScopedBearerCredentialRepository,
  digestScopedBearer
} from "../../../src/agent/mcp/auth/managedScopedBearerCredentials.js";

const memoryStore = () => {
  const values = new Map<string, { data: unknown; etag: string }>();
  let generation = 0;
  const store = {
    get: async (key: string) => structuredClone(values.get(key)?.data ?? null),
    getWithMetadata: async (key: string) => {
      const current = values.get(key);
      return current ? { data: structuredClone(current.data), etag: current.etag, metadata: {} } : null;
    },
    setJSON: async (key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      const current = values.get(key);
      if ((options?.onlyIfNew && current) || (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
      generation += 1;
      const etag = String(generation);
      values.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    list: async () => ({ blobs: [], directories: [] }),
    delete: async (key: string) => { values.delete(key); }
  } as unknown as BlobStoreClient;
  return { store, values };
};

describe("genesis-managed scoped bearer credentials", () => {
  it("persists only a digest, resolves the policy, and retires the overlap after verification", async () => {
    const memory = memoryStore();
    const repository = new ManagedScopedBearerCredentialRepository(memory.store, () => "2026-08-19T12:00:00.000Z");
    const first = await repository.mint({ projectId: "dr-lurie", toolAllowlist: ["agent_resolve", "agent_converse"], netlifySiteId: "site_1", netlifySiteName: "drluriescience" });
    const second = await repository.mint({ projectId: "dr-lurie", toolAllowlist: ["agent_resolve", "agent_converse"], netlifySiteId: "site_1", netlifySiteName: "drluriescience" });

    const serializedBefore = JSON.stringify(memory.values.get(MANAGED_SCOPED_BEARER_REGISTRY_KEY)?.data);
    expect(serializedBefore).not.toContain(first.token);
    expect(serializedBefore).not.toContain(second.token);
    expect(serializedBefore).toContain(digestScopedBearer(first.token));
    expect(await repository.findPolicy(second.token)).toEqual({ projects: ["dr-lurie"], toolAllowlist: ["agent_resolve", "agent_converse"] });

    await repository.retireOtherProjectCredentials("dr-lurie", second.digest);
    expect(await repository.findPolicy(first.token)).toBeUndefined();
    expect(await repository.findPolicy(second.token)).toEqual(second.policy);
    expect(await repository.listMetadata()).toHaveLength(1);
  });
});
