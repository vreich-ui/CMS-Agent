/**
 * C7 — the durable uniqueness primitive, on its own.
 *
 * What is pinned here is the thing a check-then-act could never give at any window size: that when
 * two callers genuinely race for one request id, the STORE decides, and the loser is told it lost.
 * The double below therefore forces the interleaving the old code hoped would not happen — both
 * callers read "absent" before either writes — because a test that lets the race serialize itself
 * proves nothing about the race.
 */
import { describe, expect, it } from "vitest";

import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";
import {
  CommissionReservationStore,
  COMMISSION_RESERVATION_CONTRACT,
  PASS_LEASE_STALE_MS,
  RESERVATION_STALE_MS,
  isReclaimable,
  type CommissionReservation
} from "../../../src/agent/planner/commissioningReservations.js";

const PROJECT = "dr-lurie";
const REQUEST = "req_plugin_ceramides_20260915_01";

/**
 * The in-memory blob double, same shape as tests/agent/mcp/managedScopedBearerCredentials.test.ts,
 * plus two things this suite needs: a forced yield inside `get` so concurrent callers can be made to
 * read before either writes, and injectable failures so "the store is unreachable" is a tested path
 * rather than an assumed one.
 */
const memoryBlobStore = (options: { yieldOnGet?: boolean } = {}) => {
  const values = new Map<string, { data: unknown; etag: string }>();
  let generation = 0;
  const control = { failGet: undefined as Error | undefined, failSet: undefined as Error | undefined, writes: 0 };
  const settle = async () => { if (options.yieldOnGet) { await Promise.resolve(); await Promise.resolve(); } };
  const store = {
    get: async (key: string) => { if (control.failGet) throw control.failGet; await settle(); return structuredClone(values.get(key)?.data ?? null); },
    getWithMetadata: async (key: string) => {
      if (control.failGet) throw control.failGet;
      await settle();
      const current = values.get(key);
      return current ? { data: structuredClone(current.data), etag: current.etag, metadata: {} } : null;
    },
    setJSON: async (key: string, data: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      if (control.failSet) throw control.failSet;
      const current = values.get(key);
      if ((opts?.onlyIfNew && current) || (opts?.onlyIfMatch !== undefined && current?.etag !== opts.onlyIfMatch)) return { modified: false };
      generation += 1;
      control.writes += 1;
      const etag = String(generation);
      values.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    list: async () => ({ blobs: [], directories: [] }),
    delete: async (key: string) => { values.delete(key); }
  } as unknown as BlobStoreClient;
  return { store, values, control };
};

const at = (iso: string) => () => new Date(iso);
const NOW = "2026-09-15T09:00:00.000Z";

describe("commission reservations — durable uniqueness", () => {
  it("gives the reservation to exactly one of two concurrent callers, and names the winner to the loser", async () => {
    // yieldOnGet forces BOTH callers past their read before either reaches setJSON: the exact
    // interleaving the old check-then-start lost to.
    const { store, control } = memoryBlobStore({ yieldOnGet: true });
    const a = new CommissionReservationStore(store, at(NOW));
    const b = new CommissionReservationStore(store, at(NOW));

    const [first, second] = await Promise.all([
      a.reserve(PROJECT, REQUEST, "editorial_planner_job"),
      b.reserve(PROJECT, REQUEST, "planner.commission")
    ]);

    const winners = [first, second].filter((outcome) => outcome.ok);
    const losers = [first, second].filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0] as Extract<typeof first, { ok: false }>;
    expect(loser.reason).toBe("held");
    // The refusal names who holds it — a run nobody can attribute is a run nobody can stop.
    expect(loser.reason === "held" && loser.holder.reservedBy).toMatch(/editorial_planner_job|planner\.commission/);
    // One reservation was written, not two.
    expect(control.writes).toBe(1);
  });

  it("refuses a second reservation once the first is bound to a running run, however old it is", async () => {
    const { store } = memoryBlobStore();
    const reserved = new CommissionReservationStore(store, at("2026-09-01T00:00:00.000Z"));
    expect((await reserved.reserve(PROJECT, REQUEST, "job")).ok).toBe(true);
    await reserved.markStarted(PROJECT, REQUEST, "run_abc");

    // Two weeks later — far past RESERVATION_STALE_MS — and with reclaim explicitly permitted.
    const later = new CommissionReservationStore(store, at("2026-09-15T00:00:00.000Z"));
    const second = await later.reserve(PROJECT, REQUEST, "job", { allowReclaim: true });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe("held");
    expect(second.ok === false && second.reason === "held" && second.holder.runId).toBe("run_abc");
    // A started reservation is never stale-reclaimable: the long-running case is precisely the one
    // where "it has been quiet a while" must not mean "start another".
    expect(isReclaimable((await later.get(PROJECT, REQUEST))!, new Date("2026-10-01T00:00:00.000Z"))).toBe(false);
  });

  it("reclaims a crashed reservation only when the caller supplies run evidence", async () => {
    const { store } = memoryBlobStore();
    const crashed = new CommissionReservationStore(store, at("2026-09-15T08:00:00.000Z"));
    expect((await crashed.reserve(PROJECT, REQUEST, "job_that_died")).ok).toBe(true);
    // Never marked started: the process died between reserving and starting.

    const wellPast = new Date(Date.parse("2026-09-15T08:00:00.000Z") + RESERVATION_STALE_MS + 1_000).toISOString();
    const next = new CommissionReservationStore(store, at(wellPast));

    // Without evidence, a stale reservation stays held. Reclaiming on an assumption IS the
    // double-spend; it just wears the costume of a repair.
    const blind = await next.reserve(PROJECT, REQUEST, "job");
    expect(blind.ok).toBe(false);
    expect(blind.ok === false && blind.reason).toBe("held");

    const withEvidence = await next.reserve(PROJECT, REQUEST, "job", { allowReclaim: true });
    expect(withEvidence.ok).toBe(true);
    expect(withEvidence.ok === true && withEvidence.reclaimedFrom?.reservedBy).toBe("job_that_died");
    expect(withEvidence.ok === true && withEvidence.reservation.detail).toContain("reclaimed from job_that_died");
  });

  it("frees the request id immediately when a start was refused", async () => {
    const { store } = memoryBlobStore();
    const s = new CommissionReservationStore(store, at(NOW));
    expect((await s.reserve(PROJECT, REQUEST, "job")).ok).toBe(true);
    await s.abandon(PROJECT, REQUEST, "start refused: subject gate");

    const held = (await s.get(PROJECT, REQUEST))!;
    expect(held.state).toBe("abandoned");
    expect(held.detail).toContain("subject gate");
    // Abandoned is reclaimable at once — one refused start must not wedge the id for the stale window.
    expect(isReclaimable(held, new Date(NOW))).toBe(true);
    const retry = await s.reserve(PROJECT, REQUEST, "job", { allowReclaim: true });
    expect(retry.ok).toBe(true);
  });

  it("reports an unreadable or unwritable store instead of behaving as though the id were free", async () => {
    const { store, control } = memoryBlobStore();
    const s = new CommissionReservationStore(store, at(NOW));

    control.failGet = new Error("bucket unreachable");
    const readFailure = await s.reserve(PROJECT, REQUEST, "job");
    expect(readFailure.ok).toBe(false);
    expect(readFailure.ok === false && readFailure.reason).toBe("store_unavailable");
    expect(readFailure.ok === false && readFailure.reason === "store_unavailable" && readFailure.detail).toContain("bucket unreachable");

    control.failGet = undefined;
    control.failSet = new Error("write denied");
    const writeFailure = await s.reserve(PROJECT, REQUEST, "job");
    expect(writeFailure.ok).toBe(false);
    expect(writeFailure.ok === false && writeFailure.reason).toBe("store_unavailable");
  });

  it("stores the reservation under a tenant-scoped key and stamps its contract", async () => {
    const { store, values } = memoryBlobStore();
    const s = new CommissionReservationStore(store, at(NOW));
    await s.reserve(PROJECT, REQUEST, "job");
    const [key] = [...values.keys()];
    // Tenant FIRST in the path, so scoping is a property of the key space rather than of a filter a
    // caller could forget (the capability-gaps lesson).
    expect(key).toBe(`commission-reservations/${PROJECT}/${REQUEST}.json`);
    expect((values.get(key)!.data as CommissionReservation).contract).toBe(COMMISSION_RESERVATION_CONTRACT);
  });
});

describe("commission reservations — the pass lease", () => {
  it("lets one pass per project run at a time, and frees it on release", async () => {
    const { store } = memoryBlobStore({ yieldOnGet: true });
    const a = new CommissionReservationStore(store, at(NOW));
    const b = new CommissionReservationStore(store, at(NOW));

    const [first, second] = await Promise.all([a.acquirePass(PROJECT, "job"), b.acquirePass(PROJECT, "operator")]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const winner = (first.ok ? first : second) as { ok: true; token: string };
    const loser = (first.ok ? second : first) as { ok: false; reason: string; detail: string };
    expect(loser.reason).toBe("held");
    expect(loser.detail).toContain("already in flight");

    await a.releasePass(PROJECT, winner.token);
    expect((await b.acquirePass(PROJECT, "operator")).ok).toBe(true);
  });

  it("takes over a lease left behind by a crashed pass, but not a live one", async () => {
    const { store } = memoryBlobStore();
    const held = new CommissionReservationStore(store, at(NOW));
    const lease = await held.acquirePass(PROJECT, "job_that_died");
    expect(lease.ok).toBe(true);

    const stillWarm = new CommissionReservationStore(store, at(new Date(Date.parse(NOW) + PASS_LEASE_STALE_MS - 1_000).toISOString()));
    expect((await stillWarm.acquirePass(PROJECT, "operator")).ok).toBe(false);

    const expired = new CommissionReservationStore(store, at(new Date(Date.parse(NOW) + PASS_LEASE_STALE_MS + 1_000).toISOString()));
    expect((await expired.acquirePass(PROJECT, "operator")).ok).toBe(true);
  });

  it("will not release a lease it no longer owns", async () => {
    const { store } = memoryBlobStore();
    const s = new CommissionReservationStore(store, at(NOW));
    const mine = await s.acquirePass(PROJECT, "job");
    expect(mine.ok).toBe(true);
    await s.releasePass(PROJECT, "someone-elses-token");
    // Still held: releasing by a foreign token is a no-op, so a pass that overran its TTL cannot
    // delete the lease of whoever legitimately took over from it.
    expect((await s.acquirePass(PROJECT, "operator")).ok).toBe(false);
  });
});
