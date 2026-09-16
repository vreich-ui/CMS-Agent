// GCS-backed implementation of the BlobStoreClient surface the blob repositories consume —
// docs/platform/DIRECTION.md Phase 2. The repository classes are reused unchanged, so every
// hardening behavior they carry (tolerant loads, revision checks, envelope shapes, CAS retries)
// applies identically; only the byte transport changes. GCS adds two properties over Netlify
// Blobs that close the documented lost-update race deterministically:
//   1. Strong consistency on every read — the eventual-consistency fallback paths never trigger.
//   2. Generation-number preconditions on every write — an ETag (the object generation) is always
//      present, so conditional writes (`onlyIfMatch`/`onlyIfNew` → ifGenerationMatch) are a hard
//      compare-and-swap rather than an environment-dependent best effort.
//
// This module is imported ONLY by the Cloud Run entrypoints (via registerCmsAgentStoreFactory in
// blobClient.ts), never by Netlify function code, so @google-cloud/storage stays out of function
// bundles.
import { Storage, type Bucket } from "@google-cloud/storage";

type SetJsonOptions = { onlyIfNew?: boolean; onlyIfMatch?: string; metadata?: unknown };
// `etagVerified` — W7. False when `etag` came from a metadata re-read rather than the upload's own
// response, i.e. when it may belong to a writer who raced into that window. Safe for the next
// conditional write either way (a wrong one simply fails and the caller retries), but NOT safe to
// cache our own bytes against: see BlobWorkspaceRepository.save().
type WriteResult = { etag?: string; modified: boolean; etagVerified?: boolean };
type ListEntry = { key: string; etag: string };

const statusCodeOf = (error: unknown): number | undefined => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
};
const isNotFound = (error: unknown): boolean => statusCodeOf(error) === 404;
const isPreconditionFailure = (error: unknown): boolean => statusCodeOf(error) === 412;

export class GcsStoreClient {
  private readonly bucket: Bucket;

  // `keyPrefix` is the per-project namespacing seam from DIRECTION.md Phase 2 / SESSION_HANDOFF
  // §5.2: keys keep their existing shapes (`workspace/current.json`, `runs/…`) and the prefix
  // relocates the whole tree (e.g. `projects/<id>/`) without any repository knowing.
  constructor(private readonly keyPrefix: string = "", bucket?: Bucket, private readonly bucketName?: string) {
    this.bucket = bucket ?? new Storage().bucket(this.requireBucketName());
  }

  private requireBucketName(): string {
    const name = (this.bucketName ?? process.env.GCS_BUCKET)?.trim();
    if (!name) throw new Error("GCS_BUCKET is required for WORKSPACE_STORE=gcs.");
    return name;
  }

  private objectName(key: string): string { return `${this.keyPrefix}${key}`; }
  private storeKey(objectName: string): string { return objectName.startsWith(this.keyPrefix) ? objectName.slice(this.keyPrefix.length) : objectName; }

  async get(key: string, _options?: unknown): Promise<unknown> {
    try {
      const [contents] = await this.bucket.file(this.objectName(key)).download();
      return JSON.parse(contents.toString("utf8"));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getWithMetadata(key: string, _options?: unknown): Promise<{ data: unknown; etag?: string; metadata: Record<string, unknown> } | null> {
    const file = this.bucket.file(this.objectName(key));
    try {
      // Read the generation first, then download that exact generation so the (data, etag) pair is
      // consistent even if a writer lands in between. A delete in that window surfaces as 404.
      const [metadata] = await file.getMetadata();
      const generation = String(metadata.generation ?? "");
      const [contents] = await this.bucket.file(this.objectName(key), generation ? { generation: Number(generation) } : undefined).download();
      return { data: JSON.parse(contents.toString("utf8")), etag: generation || undefined, metadata: {} };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // W1 — the cheap half of getWithMetadata: the object's current generation, with no download.
  // A read path that already holds a parsed document only needs to know whether that generation
  // moved; asking this costs one metadata call instead of re-fetching (and re-parsing) bytes the
  // instance already has. Returns null when the object does not exist.
  async head(key: string): Promise<string | null> {
    try {
      const [metadata] = await this.bucket.file(this.objectName(key)).getMetadata();
      const generation = metadata.generation;
      return generation === undefined || generation === null ? null : String(generation);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async setJSON(key: string, data: unknown, options?: SetJsonOptions): Promise<WriteResult> {
    const file = this.bucket.file(this.objectName(key));
    const ifGenerationMatch = options?.onlyIfMatch !== undefined ? Number(options.onlyIfMatch) : options?.onlyIfNew ? 0 : undefined;
    try {
      await file.save(JSON.stringify(data), {
        contentType: "application/json",
        resumable: false,
        ...(ifGenerationMatch !== undefined ? { preconditionOpts: { ifGenerationMatch } } : {})
      });
    } catch (error) {
      // Mirror the @netlify/blobs WriteResult contract the repositories already branch on: a
      // failed precondition is `modified: false`, never a throw.
      if (isPreconditionFailure(error)) return { modified: false };
      throw error;
    }
    // The library populates file.metadata from the upload response for non-resumable writes; fall
    // back to a metadata read. A writer racing into this window yields a stale etag here, which is
    // CAS-safe: the next conditional write simply fails and the caller retries from a fresh read.
    //
    // W7 — but it is NOT safe to CACHE against. Once a caller may `adopt(document, etag)` (see
    // CachedJsonBlob), pairing our own bytes with somebody else's generation pins the cache to a
    // version check that passes forever: `head()` keeps returning the generation we recorded, so the
    // instance serves its own superseded document with no TTL bound. `etagVerified` says which of
    // the two we got — the upload's own answer, or a re-read that may have caught another writer —
    // so a cache can adopt the first and drop the second.
    const fromUpload = file.metadata?.generation;
    const generation = fromUpload ?? (await file.getMetadata())[0]?.generation;
    return { modified: true, etag: generation !== undefined ? String(generation) : undefined, etagVerified: fromUpload !== undefined };
  }

  async list(options: { prefix?: string } = {}): Promise<{ blobs: ListEntry[]; directories: string[] }> {
    const [files] = await this.bucket.getFiles({ prefix: this.objectName(options.prefix ?? "") });
    return {
      blobs: files.map((file) => ({ key: this.storeKey(file.name), etag: String(file.metadata?.generation ?? "") })),
      directories: []
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.file(this.objectName(key)).delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

let memoizedClient: GcsStoreClient | undefined;

// One Storage client per process: the SDK client is stateless and reusable, and repositories are
// constructed per RepositoryManager rebuild, so the factory must not mint a client per call.
export const createGcsStoreClient = (): GcsStoreClient =>
  (memoizedClient ??= new GcsStoreClient(process.env.GCS_KEY_PREFIX?.trim() ?? ""));

export const resetGcsStoreClientForTests = (): void => { memoizedClient = undefined; };
