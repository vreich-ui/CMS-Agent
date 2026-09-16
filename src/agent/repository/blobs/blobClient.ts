import { getStore, type Store } from "@netlify/blobs";
import type { RepositoryBackend } from "../RepositoryManager.js";

// `getWithMetadata` is optional so lightweight test doubles that only implement get/setJSON/list/
// delete keep type-checking; callers feature-detect it before relying on ETag-based writes.
//
// `head` (W1) is an OPTIONAL extension beyond the @netlify/blobs Store surface: the object's
// current version identifier with no download. Netlify Blobs has no such call, so every consumer
// feature-detects it and degrades to a full read — the behavior that shipped before W1.
export type BlobStoreClient = Pick<Store, "get" | "setJSON" | "list" | "delete"> & Partial<Pick<Store, "getWithMetadata">> & {
  head?(key: string): Promise<string | null>;
};

// Alternate store transports (the GCS backend — DIRECTION.md Phase 2) register a factory here from
// their entrypoint instead of being imported by this module, so @google-cloud/storage never lands
// in Netlify function bundles. Registration must happen before the first repository access; the
// repository manager is built lazily, so an entrypoint that registers at startup is always early
// enough.
let externalStoreFactory: (() => BlobStoreClient) | undefined;
export const registerCmsAgentStoreFactory = (factory: (() => BlobStoreClient) | undefined): void => { externalStoreFactory = factory; };

// Which transport the blob-shaped repositories are actually running on, for honest health labels.
export const storeBackendLabel = (): RepositoryBackend => ((process.env.WORKSPACE_STORE ?? "") === "gcs" ? "gcs" : "blobs");

// Inside the Netlify runtime, getStore({ name }) binds to the per-request Blobs context that the
// Lambda handlers connect. Outside it (the Cloud Run job entrypoint — DIRECTION.md Phase 1) there
// is no such context, so explicit credentials are read from NETLIFY_BLOBS_SITE_ID +
// NETLIFY_BLOBS_TOKEN, putting the client in API mode against the same store. The dedicated env
// names (not NETLIFY_SITE_ID) guarantee Netlify deployments never switch modes accidentally.
export const getCmsAgentBlobStore = (): BlobStoreClient => {
  if (externalStoreFactory) return externalStoreFactory();
  if ((process.env.WORKSPACE_STORE ?? "") === "gcs") {
    throw new Error("WORKSPACE_STORE=gcs requires the entrypoint to register the GCS store factory (registerCmsAgentStoreFactory) before repositories are built — see docs/platform/PHASE2_RUNBOOK.md.");
  }
  const name = process.env.NETLIFY_BLOBS_STORE_NAME ?? "cms-agent";
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID?.trim();
  const token = process.env.NETLIFY_BLOBS_TOKEN?.trim();
  return siteID && token ? getStore({ name, siteID, token }) : getStore({ name });
};

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


// ---------------------------------------------------------------------------------------------
// W1 — CachedJsonBlob
//
// The read model for every JSON blob this service reads far more often than it writes. Before it,
// each read was an unconditional download-and-reparse: fifteen concurrent verbs on one cold
// Workbench paint cost thirty GCS round trips and 4.7 MB re-downloaded of a 321 KB document that
// had not changed between the first read and the last (docs/perf/workbench-2026-09-16.md).
//
// Three mechanisms, cheapest first:
//   1. micro-TTL — inside `ttlMs` of the last check, the parsed value is returned with NO network
//      call at all. This is what collapses a burst.
//   2. version check — past the TTL, `store.head(key)` asks only for the current version. Matching
//      the cached one costs one metadata call and no transfer, no parse, no allocation.
//   3. download — only when the version actually moved, or the cache is cold.
//
// Plus coalescing: concurrent callers share ONE in-flight refresh rather than each starting their
// own. That alone is the difference between 15 round trips and 1 when a burst arrives cold.
//
// Consistency, stated plainly: a cached read can be up to `ttlMs` behind a write made by ANOTHER
// instance. That is a deliberate trade for read paths. It is NOT acceptable for the read half of a
// read-modify-write, so every mutation path must pass `{ fresh: true }`, which bypasses both the
// TTL and the version check. Writers call `adopt()` after a successful save so this instance never
// re-reads bytes it just produced, and `invalidate()` when a write's outcome is unknown.
// ---------------------------------------------------------------------------------------------

export type CachedBlobRead<T> = {
  data: T | null;
  etag?: string;
  /** How the answer was obtained — asserted by the perf tests, and cheap to log. */
  source: "ttl" | "version" | "download";
};

export type CachedJsonBlobOptions = {
  /** Window in which a cached value is returned without any network call. Default 1500 ms. */
  ttlMs?: number;
  /** Called once per real download with the parsed value, for size/telemetry accounting. */
  onDownload?: (data: unknown) => void;
};

export const DEFAULT_BLOB_CACHE_TTL_MS = 1500;

export class CachedJsonBlob<T> {
  private cached: { data: T | null; etag?: string } | undefined;
  private checkedAt = 0;
  private inFlight: Promise<CachedBlobRead<T>> | undefined;
  private readonly ttlMs: number;

  constructor(
    private readonly store: BlobStoreClient,
    private readonly key: string,
    private readonly options: CachedJsonBlobOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_BLOB_CACHE_TTL_MS;
  }

  /** The cached value without touching the network or the clock — `undefined` when never read. */
  peek(): { data: T | null; etag?: string } | undefined { return this.cached; }

  async read(options?: { fresh?: boolean }): Promise<CachedBlobRead<T>> {
    if (!options?.fresh && this.cached !== undefined && Date.now() - this.checkedAt < this.ttlMs) {
      return { ...this.cached, source: "ttl" };
    }
    // Coalesce: a burst that arrives while a refresh is already in flight waits for THAT refresh
    // instead of starting fifteen of its own. A `fresh` caller still joins an in-flight refresh —
    // it was started no earlier than this call, so its answer is no staler than a new read's.
    if (this.inFlight) return this.inFlight;
    const refresh = this.refresh(Boolean(options?.fresh)).finally(() => { this.inFlight = undefined; });
    this.inFlight = refresh;
    return refresh;
  }

  private async refresh(fresh: boolean): Promise<CachedBlobRead<T>> {
    // Version check, but only when there is something to compare against and the caller can live
    // with a value it may already hold. A cold cache goes straight to the download — asking for a
    // version we cannot match would be a wasted round trip.
    if (!fresh && this.cached?.etag !== undefined && typeof this.store.head === "function") {
      const current = await this.store.head(this.key);
      if (current !== null && current === this.cached.etag) {
        this.checkedAt = Date.now();
        return { ...this.cached, source: "version" };
      }
    }
    const { data, etag } = await getBlobJsonWithEtag<T>(this.store, this.key);
    if (data !== null) this.options.onDownload?.(data);
    this.cached = { data, etag };
    this.checkedAt = Date.now();
    return { data, etag, source: "download" };
  }

  /** Record a value this instance just wrote, so the next read neither downloads nor re-parses it. */
  adopt(data: T, etag: string | undefined): void {
    this.cached = { data, etag };
    this.checkedAt = Date.now();
  }

  /** Drop the cached value — for a write whose landed version is unknown, and for tests. */
  invalidate(): void {
    this.cached = undefined;
    this.checkedAt = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// W1 — CoalescedTtlCache
//
// CachedJsonBlob covers ONE key. Several repositories instead answer a read by scanning a prefix
// and opening every blob under it — `BlobSkillRepository.load()` lists `skills/current/`,
// `skills/versions/` AND `skills/events/` and reads every object in all three, on every single
// read, so the cost of `skill_list` grows with every skill edit ever made (measured live at 20 s
// for a 63 KB answer, to render a row of chips). Evaluation rubrics, usage records and the project
// registry have the same shape.
//
// There is no cheap version check for a whole prefix, so this offers the other two mechanisms: a
// short TTL and in-flight coalescing. Writers invalidate explicitly. A miss costs exactly what the
// read cost before, so the worst case is unchanged behavior.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_COMPOSITE_CACHE_TTL_MS = 5000;

export class CoalescedTtlCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; settledAt?: number }>();

  constructor(private readonly ttlMs: number = DEFAULT_COMPOSITE_CACHE_TTL_MS) {}

  async read(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && (existing.settledAt === undefined || Date.now() - existing.settledAt < this.ttlMs)) return existing.value;
    // A rejected load is dropped rather than cached: a transient store error must not be replayed
    // to every caller for the rest of the TTL window.
    const entry: { value: Promise<T>; settledAt?: number } = {
      value: load().catch((error) => { this.entries.delete(key); throw error; })
    };
    this.entries.set(key, entry);
    const value = await entry.value;
    entry.settledAt = Date.now();
    return value;
  }

  /** Called by every write path that can change what a cached read would answer. */
  invalidate(): void { this.entries.clear(); }
}
