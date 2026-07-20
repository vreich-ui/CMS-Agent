// Small TTL-aware key/value store shared by the MCP session layer and the OAuth authorization
// server. Netlify Functions are stateless across invocations, so ephemeral protocol state
// (sessions, authorization codes, issued tokens, registered clients) cannot live in a module-level
// Map in production — the `authorize` call and the `token` call that follows it usually land on
// different invocations. This mirrors the repository layer: a Memory implementation for dev/test
// and a Blob-backed implementation selected by `WORKSPACE_STORE=blobs`.
//
// Records are envelope-wrapped with an absolute `expiresAt`. Expiry is enforced on read (a stale
// record reads as absent and is deleted best-effort), which is sufficient for correctness without
// a background sweeper.

import { getBlobJson, getCmsAgentBlobStore, type BlobStoreClient } from "../../repository/blobs/blobClient.js";
import { netlifyBlobsContextConnected } from "../../runtime/lambdaBlobs.js";

export type Clock = () => number;

type Envelope<T> = { value: T; expiresAt: number | null };

export interface McpStateStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const isExpired = (envelope: Envelope<unknown>, now: number): boolean =>
  typeof envelope.expiresAt === "number" && envelope.expiresAt <= now;

// Process-local store. A single shared instance backs dev/test so a full register → authorize →
// token sequence sees its own writes. `clear()` lets tests reset between cases.
export class MemoryStateStore implements McpStateStore {
  private readonly entries = new Map<string, Envelope<unknown>>();

  constructor(private readonly now: Clock = Date.now) {}

  async get<T>(key: string): Promise<T | null> {
    const envelope = this.entries.get(key);
    if (!envelope) return null;
    if (isExpired(envelope, this.now())) {
      this.entries.delete(key);
      return null;
    }
    return envelope.value as T;
  }

  async put<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: typeof ttlMs === "number" ? this.now() + ttlMs : null });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const now = this.now();
    const keys: string[] = [];
    for (const [key, envelope] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      if (isExpired(envelope, now)) {
        this.entries.delete(key);
        continue;
      }
      keys.push(key);
    }
    return keys;
  }

  clear(): void {
    this.entries.clear();
  }
}

// Blob-backed store. Keys are namespaced by the caller (e.g. "mcp/session/<id>"). Netlify Blob
// `list` returns `{ blobs: [{ key }] }`; expired blobs are dropped lazily on read and filtered out
// of listings.
export class BlobStateStore implements McpStateStore {
  constructor(
    private readonly store: BlobStoreClient = getCmsAgentBlobStore(),
    private readonly now: Clock = Date.now
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const envelope = await getBlobJson<Envelope<T>>(this.store, key);
    if (!envelope) return null;
    if (isExpired(envelope, this.now())) {
      await this.store.delete(key).catch(() => undefined);
      return null;
    }
    return envelope.value;
  }

  async put<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const envelope: Envelope<T> = { value, expiresAt: typeof ttlMs === "number" ? this.now() + ttlMs : null };
    await this.store.setJSON(key, envelope);
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key).catch(() => undefined);
  }

  async list(prefix: string): Promise<string[]> {
    const listing = (await this.store.list({ prefix })) as { blobs?: Array<{ key: string }> };
    return (listing.blobs ?? []).map((blob) => blob.key);
  }
}

// Shared process-local memory store for dev/test so state survives across handler calls within a
// single process, exactly like the repository singleton.
let sharedMemoryStore: MemoryStateStore | undefined;
export const getSharedMemoryStateStore = (): MemoryStateStore => (sharedMemoryStore ??= new MemoryStateStore());
export const resetSharedMemoryStateStore = (): void => sharedMemoryStore?.clear();

// Decide whether MCP OAuth/session state persists in Blobs. This is deliberately decoupled from
// WORKSPACE_STORE (which selects the *repository* backend): OAuth codes/tokens/clients and sessions
// must survive across stateless invocations whenever we run on Netlify, even if a deployment
// chooses ephemeral in-memory workspace data. Precedence:
//   1. MCP_STATE_STORE=blobs|memory  — explicit override (also lets tests force a backend).
//   2. WORKSPACE_STORE=blobs         — if the workspace persists, so does auth state.
//   3. A Netlify Blobs context is connected for this runtime — the default on a real deploy.
// Otherwise (local node/vitest) fall back to the shared in-process Memory store.
export const mcpStateUsesBlobs = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const explicit = (env.MCP_STATE_STORE ?? "").trim().toLowerCase();
  if (explicit === "blobs") return true;
  if (explicit === "memory") return false;
  // "gcs" and "blobs" both back the store through getCmsAgentBlobStore() — on the Cloud Run MCP
  // Service the registered GCS transport makes sessions + OAuth state durable and shared across
  // instances (DIRECTION.md Phase 4), so no session affinity is required.
  const workspaceStore = env.WORKSPACE_STORE ?? "memory";
  if (workspaceStore === "blobs" || workspaceStore === "gcs") return true;
  return netlifyBlobsContextConnected();
};

// Resolve the active state store at call time (never at import). Handlers must have already run
// connectLambdaBlobs(event) before this is first touched in a Blob deployment.
export const getMcpStateStore = (): McpStateStore =>
  mcpStateUsesBlobs() ? new BlobStateStore() : getSharedMemoryStateStore();
