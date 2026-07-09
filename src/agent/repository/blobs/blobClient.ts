import { getStore, type Store } from "@netlify/blobs";

export type BlobStoreClient = Pick<Store, "get" | "setJSON" | "list">;

export const getCmsAgentBlobStore = (): BlobStoreClient => getStore({ name: process.env.NETLIFY_BLOBS_STORE_NAME ?? "cms-agent", consistency: "strong" });

export const strongConsistency = { consistency: "strong" as const };
