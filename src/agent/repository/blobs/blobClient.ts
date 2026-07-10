import { getStore, type Store } from "@netlify/blobs";

export type BlobStoreClient = Pick<Store, "get" | "setJSON" | "list" | "delete">;

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
