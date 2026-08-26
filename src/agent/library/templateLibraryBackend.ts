// T15.31 (#207) — resolves which BlobStoreClient TemplateLibraryStore's zero-arg constructor uses,
// mirroring RepositoryManager's own "blobs"/"gcs" -> real blob store, else -> in-process memory"
// branch (RepositoryManager.ts's constructor) — same WORKSPACE_STORE env var, same default of
// "memory" for local dev and the test suite, so touching the library never requires a test to mock
// @netlify/blobs the way blobProjectRepository.test.ts does, unless it is deliberately exercising the
// blobs backend.
//
// The in-memory implementation is a real BlobStoreClient (get/getWithMetadata/setJSON/list/delete),
// not a separate code path — templateLibraryStore.ts's CAS logic (onlyIfNew/onlyIfMatch) runs
// IDENTICALLY against either backend, which is what makes the immutability/versioning tests
// meaningful in "memory" mode and not just theater that the real blobs backend might behave
// differently under.
import { getCmsAgentBlobStore, type BlobStoreClient } from "../repository/blobs/blobClient.js";

type MemoryEntry = { value: unknown; etag: string };

// Module-level, like repositoryManager's own memoized singleton (runtime/repositories.ts) — a
// process-lifetime store so two independently-constructed TemplateLibraryStore instances (a deposit
// in cloneConductorRoutes.ts, a later list/instantiate call) see the SAME data, exactly as two
// independently-constructed MemoryProjectRepository instances would NOT (that class's Map is
// per-instance) but two calls through the shared `repositoryManager` proxy DO.
let memoryBlobs: Map<string, MemoryEntry> | undefined;
const state = (): Map<string, MemoryEntry> => (memoryBlobs ??= new Map());

/** Test-only reset, mirroring resetRepositoryManager() — call between tests so one test's deposits
 *  never leak into the next. */
export const resetTemplateLibraryMemoryStore = (): void => { memoryBlobs = undefined; };

const nextEtag = (() => {
  let seq = 0;
  return (key: string) => `library-memory-etag:${key}:${++seq}`;
})();

// Built as a plain object, typed loosely, then cast once to BlobStoreClient: @netlify/blobs' real
// Store methods are heavily overloaded (arrayBuffer/text/json variants) for a client library that
// supports far more than the {get,getWithMetadata,setJSON,list,delete} JSON-only slice
// BlobStoreClient (blobClient.ts) actually declares — a literal implementing only that slice does
// not structurally match the overload set TypeScript infers from `Store` itself. The cast is safe
// because every call site in this codebase goes through BlobStoreClient's own (non-overloaded)
// signature, never Store's.
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

/** The default BlobStoreClient for a zero-arg `new TemplateLibraryStore()`: the real Netlify-backed
 *  store when WORKSPACE_STORE names "blobs"/"gcs", an in-process one otherwise. A caller that wants
 *  its own fixed store (a test double, an explicit choice) always passes one directly instead. */
export const resolveDefaultTemplateLibraryBackend = (env: NodeJS.ProcessEnv = process.env): BlobStoreClient =>
  usesBlobBackend(env) ? getCmsAgentBlobStore() : createMemoryBlobStoreClient();
