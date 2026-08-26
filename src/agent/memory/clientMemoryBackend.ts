// T15.32 (#208; ADR-2026-08-25-structure-studio §5.2) — resolves which BlobStoreClient
// clientMemoryStore.ts's zero-arg constructor uses. Mirrors templateLibraryBackend.ts's own
// resolveDefaultTemplateLibraryBackend EXACTLY in shape (same WORKSPACE_STORE env var, same
// memory-mode default for local dev and the test suite) — deliberately a SEPARATE module, not a
// shared one, with its OWN module-level Map: the library is cross-tenant and this store is
// per-tenant (ADR §5.2's tenancy seam), and a test resetting one must never be able to leak into or
// mask a bug in the other. See templateLibraryTypes.ts's header for the tenancy distinction this
// module-boundary enforces at the storage layer too.
import { getCmsAgentBlobStore, type BlobStoreClient } from "../repository/blobs/blobClient.js";

type MemoryEntry = { value: unknown; etag: string };

// Module-level, process-lifetime store — see templateLibraryBackend.ts's identical comment for why
// (two independently-constructed ClientMemoryStore instances must see the SAME data).
let memoryBlobs: Map<string, MemoryEntry> | undefined;
const state = (): Map<string, MemoryEntry> => (memoryBlobs ??= new Map());

/** Test-only reset — call between tests so one test's memory writes never leak into the next. */
export const resetClientMemoryStore = (): void => { memoryBlobs = undefined; };

const nextEtag = (() => {
  let seq = 0;
  return (key: string) => `client-memory-etag:${key}:${++seq}`;
})();

// See templateLibraryBackend.ts's identical function for why this is built as a plain object and
// cast once rather than typed against @netlify/blobs' own (heavily overloaded) Store type.
function createMemoryBlobStoreClient(): BlobStoreClient {
  const client = {
    async get(key: string) {
      const entry = state().get(key);
      return entry ? structuredClone(entry.value) : null;
    },
    async getWithMetadata(key: string) {
      const entry = state().get(key);
      return entry ? { data: structuredClone(entry.value), etag: entry.etag } : null;
    },
    async setJSON(key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) {
      const store = state();
      const existing = store.get(key);
      if (options?.onlyIfNew && existing) return { modified: false };
      if (options?.onlyIfMatch !== undefined && (!existing || existing.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = nextEtag(key);
      store.set(key, { value: structuredClone(data), etag });
      return { modified: true, etag };
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const blobs = [...state().entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({ key, etag: entry.etag }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { blobs, directories: [] };
    },
    async delete(key: string) {
      state().delete(key);
    }
  };
  return client as unknown as BlobStoreClient;
}

const usesBlobBackend = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const mode = env.WORKSPACE_STORE ?? "memory";
  return mode === "blobs" || mode === "gcs";
};

/** The default BlobStoreClient for a zero-arg `new ClientMemoryStore()`: the real Netlify-backed
 *  store when WORKSPACE_STORE names "blobs"/"gcs", an in-process one otherwise. */
export const resolveDefaultClientMemoryBackend = (env: NodeJS.ProcessEnv = process.env): BlobStoreClient =>
  usesBlobBackend(env) ? getCmsAgentBlobStore() : createMemoryBlobStoreClient();
