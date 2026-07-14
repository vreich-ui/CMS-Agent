// MCP Streamable-HTTP session control.
//
// The workspace endpoint was previously stateless: every POST re-derived tools and forgot the
// caller the moment it responded. This adds real sessions per the Streamable HTTP transport —
// a server-issued `Mcp-Session-Id` minted at `initialize`, carried by the client on every later
// request, validated and slid forward on each touch, and terminable via HTTP DELETE.
//
// A session record is safe to persist: it holds negotiated protocol version, non-secret client
// info, the attributed actor, and timestamps — never a credential.

import { randomBytes } from "node:crypto";
import type { WorkspaceActor } from "../../workspace/changeTypes.js";
import { getMcpStateStore, type Clock, type McpStateStore } from "../state/stateStore.js";

// Protocol versions this server can speak, newest first. Negotiation echoes the client's requested
// version when supported, otherwise falls back to the newest the server knows (per the MCP spec's
// version-negotiation rule for the initialize handshake).
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const negotiateProtocolVersion = (requested?: string): string =>
  requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;

export type McpClientInfo = { name?: string; version?: string; title?: string };

export type McpSession = {
  id: string;
  protocolVersion: string;
  clientInfo: McpClientInfo;
  actor: WorkspaceActor;
  createdAt: string;
  lastSeenAt: string;
  // Absolute wall-clock expiry: the sooner of (lastSeenAt + idleTtl) and (createdAt + maxAge).
  expiresAt: string;
};

export type McpSessionManagerConfig = {
  // Sliding idle window; a session that goes untouched this long is evicted. Default 30 minutes.
  idleTtlMs?: number;
  // Absolute ceiling regardless of activity. Default 12 hours.
  maxAgeMs?: number;
  clock?: Clock;
  store?: McpStateStore;
};

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const KEY_PREFIX = "mcp/session/";

// Session ids must be globally unique and visible-ASCII only (MCP transport rule); hex satisfies
// both and never needs escaping in a header value.
const newSessionId = (): string => `mcps_${randomBytes(24).toString("hex")}`;

export class McpSessionManager {
  private readonly idleTtlMs: number;
  private readonly maxAgeMs: number;
  private readonly clock: Clock;
  private readonly store: McpStateStore;

  constructor(config: McpSessionManagerConfig = {}) {
    this.idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.clock = config.clock ?? Date.now;
    this.store = config.store ?? getMcpStateStore();
  }

  private key(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  private nextExpiry(createdAtMs: number, lastSeenMs: number): number {
    return Math.min(lastSeenMs + this.idleTtlMs, createdAtMs + this.maxAgeMs);
  }

  // Blob TTL is best-effort; the manager also enforces expiry on read so an eventually-consistent
  // backend can never resurrect a dead session.
  private storeTtlMs(): number {
    return this.maxAgeMs;
  }

  async create(input: { protocolVersion?: string; clientInfo?: McpClientInfo; actor: WorkspaceActor }): Promise<McpSession> {
    const nowMs = this.clock();
    const nowIso = new Date(nowMs).toISOString();
    const session: McpSession = {
      id: newSessionId(),
      protocolVersion: negotiateProtocolVersion(input.protocolVersion),
      clientInfo: input.clientInfo ?? {},
      actor: input.actor,
      createdAt: nowIso,
      lastSeenAt: nowIso,
      expiresAt: new Date(this.nextExpiry(nowMs, nowMs)).toISOString()
    };
    await this.store.put(this.key(session.id), session, this.storeTtlMs());
    return session;
  }

  async get(id: string): Promise<McpSession | null> {
    if (!id) return null;
    const session = await this.store.get<McpSession>(this.key(id));
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= this.clock()) {
      await this.store.delete(this.key(id));
      return null;
    }
    return session;
  }

  // Validate and slide the idle window forward. Returns null when the session is unknown/expired,
  // which the transport maps to HTTP 404 so the client re-initializes.
  async touch(id: string): Promise<McpSession | null> {
    const session = await this.get(id);
    if (!session) return null;
    const nowMs = this.clock();
    const refreshed: McpSession = {
      ...session,
      lastSeenAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(this.nextExpiry(Date.parse(session.createdAt), nowMs)).toISOString()
    };
    await this.store.put(this.key(id), refreshed, this.storeTtlMs());
    return refreshed;
  }

  async terminate(id: string): Promise<boolean> {
    const existing = await this.get(id);
    await this.store.delete(this.key(id));
    return existing !== null;
  }

  async list(): Promise<McpSession[]> {
    const keys = await this.store.list(KEY_PREFIX);
    const sessions = await Promise.all(keys.map((key) => this.store.get<McpSession>(key)));
    const now = this.clock();
    return sessions.filter((session): session is McpSession => !!session && Date.parse(session.expiresAt) > now);
  }
}
