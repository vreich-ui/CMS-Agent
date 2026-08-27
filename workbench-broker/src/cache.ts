/**
 * Short-TTL response cache for read-verb MCP calls (Track A, A1.4).
 *
 * Keyed on (verb, JSON.stringify(args), generation). `generation` is a
 * monotonic counter the broker bumps whenever a mutating verb reaches the
 * upstream workspace — bumping it (and clearing the store) is the
 * invalidation: every previously-cached key silently stops being reachable
 * because new lookups are built against the new generation number. This
 * needs no upstream "workspace version" concept (there isn't one worth
 * trusting — see mcp.ts's own `workspaceVersion`, which is just the MCP
 * protocol version string) and needs no per-key bookkeeping on mutation.
 *
 * Mutating verbs must never be looked up here — that is enforced by the
 * caller (index.ts only calls `get`/`set` for verbs classified "read" by
 * policy.ts), not by this module, which has no verb-policy knowledge of its
 * own on purpose (one classification authority, not two).
 */

export interface ReadCacheOptions {
  ttlMs: number;
  now?: () => number;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class ReadCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private store = new Map<string, Entry>();
  private generation = 0;

  constructor(opts: ReadCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /** Opaque generation token, safe to expose to clients (e.g. as `workspaceVersion`). */
  get version(): number {
    return this.generation;
  }

  private key(verb: string, args: Record<string, unknown>): string {
    return `${this.generation}::${verb}::${JSON.stringify(args)}`;
  }

  get<T = unknown>(verb: string, args: Record<string, unknown>): T | undefined {
    const entry = this.store.get(this.key(verb, args));
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.store.delete(this.key(verb, args));
      return undefined;
    }
    return entry.value as T;
  }

  set(verb: string, args: Record<string, unknown>, value: unknown): void {
    this.store.set(this.key(verb, args), { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Bumps the generation (every existing key becomes unreachable) and drops the store. */
  invalidate(): void {
    this.generation += 1;
    this.store.clear();
  }

  /** Periodic cleanup so the map doesn't grow unbounded over a long uptime. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) this.store.delete(key);
    }
  }

  /** Current entry count — test/diagnostic use only. */
  get size(): number {
    return this.store.size;
  }
}
