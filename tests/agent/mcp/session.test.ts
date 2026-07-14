import { describe, expect, it } from "vitest";
import { McpSessionManager, negotiateProtocolVersion, LATEST_PROTOCOL_VERSION } from "../../../src/agent/mcp/transport/session.js";
import { MemoryStateStore } from "../../../src/agent/mcp/state/stateStore.js";

const manager = (nowRef: { value: number }, config: { idleTtlMs?: number; maxAgeMs?: number } = {}) => {
  const clock = () => nowRef.value;
  return new McpSessionManager({ clock, store: new MemoryStateStore(clock), idleTtlMs: config.idleTtlMs ?? 1000, maxAgeMs: config.maxAgeMs ?? 10000 });
};

describe("negotiateProtocolVersion", () => {
  it("echoes a supported version", () => {
    expect(negotiateProtocolVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
  });
  it("falls back to the latest for unknown or missing versions", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe("McpSessionManager", () => {
  it("creates a session with a visible-ascii id, negotiated protocol, actor and timestamps", async () => {
    const now = { value: 1_000 };
    const session = await manager(now).create({ protocolVersion: "2025-03-26", clientInfo: { name: "Claude" }, actor: { kind: "agent", label: "Claude (oauth)" } });

    expect(session.id).toMatch(/^mcps_[0-9a-f]{48}$/);
    expect(session.protocolVersion).toBe("2025-03-26");
    expect(session.actor).toEqual({ kind: "agent", label: "Claude (oauth)" });
    expect(session.clientInfo).toEqual({ name: "Claude" });
    expect(Date.parse(session.createdAt)).toBe(1_000);
    // expiresAt is the sooner of idle (now+1000) and maxAge (now+10000).
    expect(Date.parse(session.expiresAt)).toBe(2_000);
  });

  it("retrieves a live session and rejects unknown ids", async () => {
    const now = { value: 0 };
    const m = manager(now);
    const session = await m.create({ actor: { kind: "agent" } });
    expect(await m.get(session.id)).not.toBeNull();
    expect(await m.get("mcps_missing")).toBeNull();
    expect(await m.get("")).toBeNull();
  });

  it("slides the idle window forward on touch", async () => {
    const now = { value: 0 };
    const m = manager(now, { idleTtlMs: 1000, maxAgeMs: 10000 });
    const session = await m.create({ actor: { kind: "agent" } });

    now.value = 900;
    const touched = await m.touch(session.id);
    expect(touched).not.toBeNull();
    expect(Date.parse(touched!.expiresAt)).toBe(1_900);

    // Advancing just short of the new expiry keeps it alive.
    now.value = 1_800;
    expect(await m.get(session.id)).not.toBeNull();
  });

  it("expires an idle session that is never touched", async () => {
    const now = { value: 0 };
    const m = manager(now, { idleTtlMs: 1000, maxAgeMs: 10000 });
    const session = await m.create({ actor: { kind: "agent" } });

    now.value = 1_001;
    expect(await m.get(session.id)).toBeNull();
    expect(await m.touch(session.id)).toBeNull();
  });

  it("never extends expiry beyond the absolute max age even with frequent touches", async () => {
    const now = { value: 0 };
    const m = manager(now, { idleTtlMs: 1000, maxAgeMs: 2000 });
    const session = await m.create({ actor: { kind: "agent" } });

    now.value = 900;
    expect(Date.parse((await m.touch(session.id))!.expiresAt)).toBe(1_900);
    now.value = 1_800;
    expect(Date.parse((await m.touch(session.id))!.expiresAt)).toBe(2_000); // capped at createdAt + maxAge

    now.value = 2_001;
    expect(await m.get(session.id)).toBeNull();
  });

  it("terminates a session and reports whether it existed", async () => {
    const now = { value: 0 };
    const m = manager(now);
    const session = await m.create({ actor: { kind: "agent" } });

    expect(await m.terminate(session.id)).toBe(true);
    expect(await m.get(session.id)).toBeNull();
    expect(await m.terminate(session.id)).toBe(false);
  });

  it("lists only live sessions", async () => {
    const now = { value: 0 };
    const m = manager(now, { idleTtlMs: 1000, maxAgeMs: 10000 });
    const a = await m.create({ actor: { kind: "agent" } });
    await m.create({ actor: { kind: "human", id: "vreich@kugelbrands.com" } });

    expect((await m.list()).map((s) => s.id)).toContain(a.id);
    expect(await m.list()).toHaveLength(2);

    now.value = 1_001; // both idle-expire
    expect(await m.list()).toHaveLength(0);
  });
});
