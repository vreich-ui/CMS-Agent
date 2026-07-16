import { getStore, type Store } from "@netlify/blobs";

// `getWithMetadata` is optional so lightweight test doubles that only implement get/setJSON/list/
// delete keep type-checking; callers feature-detect it before relying on ETag-based writes.
export type BlobStoreClient = Pick<Store, "get" | "setJSON" | "list" | "delete"> & Partial<Pick<Store, "getWithMetadata">>;

export const getCmsAgentBlobStore = (): BlobStoreClient => getStore({ name: process.env.NETLIFY_BLOBS_STORE_NAME ?? "cms-agent" });

export const strongConsistency = { consistency: "strong" as const };
const eventualConsistency = { consistency: "eventual" as const };

// Strong-consistency reads require the deployment to expose an `uncachedEdgeURL`. Some Netlify
// Function environments don't provide one, and @netlify/blobs throws a BlobsConsistencyError
// ("...has not been configured with a 'uncachedEdgeURL' property") rather than falling back on
// its own. The error names the missing property only — it never carries the site ID, token, or
// any other Blobs internals — so it is safe to inspect here.
const isStrongConsistencyUnavailable = (error: unknown): boolean => error instanceof Error && error.name === "BlobsConsistencyError";

// Reads a JSON blob preferring strong consistency, so a write is visible to the very next read.
// When strong consistency is unavailable in the current environment, this falls back to a normal
// (eventual) consistency read of the same key instead of failing the request.
export async function getBlobJson<T>(store: BlobStoreClient, key: string): Promise<T | null> {
  try {
    return (await store.get(key, { type: "json", ...strongConsistency })) as T | null;
  } catch (error) {
    if (!isStrongConsistencyUnavailable(error)) throw error;
    return (await store.get(key, { type: "json", ...eventualConsistency })) as T | null;
  }
}

// Reads a JSON blob together with its current ETag so a subsequent conditional write
// (`setJSON(..., { onlyIfMatch })`) can perform a true compare-and-swap. Returns { data: null }
// when the key is absent. Mirrors getBlobJson's strong→eventual consistency fallback, and returns
// no ETag when the environment or store double lacks getWithMetadata (the caller then degrades to a
// revision-checked write rather than a hard CAS).
export async function getBlobJsonWithEtag<T>(store: BlobStoreClient, key: string): Promise<{ data: T | null; etag?: string }> {
  if (typeof store.getWithMetadata !== "function") {
    return { data: await getBlobJson<T>(store, key) };
  }
  const read = async (consistency: typeof strongConsistency | typeof eventualConsistency) =>
    store.getWithMetadata!(key, { type: "json", ...consistency }) as Promise<{ data: T; etag?: string } | null>;
  try {
    const result = await read(strongConsistency);
    return result ? { data: result.data, etag: result.etag } : { data: null };
  } catch (error) {
    if (!isStrongConsistencyUnavailable(error)) throw error;
    const result = await read(eventualConsistency);
    return result ? { data: result.data, etag: result.etag } : { data: null };
  }
}
