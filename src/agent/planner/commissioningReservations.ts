// C7 — durable uniqueness for commissioned runs.
//
// WHY THIS EXISTS. `startCommissionedRun` used to protect itself with a check-then-act: list today's
// runs, look for the request id, then call `startDryRun`. Its own comment said what that buys —
// "this does not make commissioning atomic; it closes the window from the whole plan down to the few
// milliseconds around this call" — and a few milliseconds is exactly the window the 06:00 job and an
// operator's `planner.commission` land in, because both read the same caps, sort the same candidates
// the same deterministic way, and mint the SAME request id for the same top topic. Two live runs on
// one id is double the spend and only one row in the tenant's inbox.
//
// A PROCESS-LOCAL MUTEX IS NOT ENOUGH, which is why this is a store and not a Map. The two callers
// are not in the same process: the planner job runs on Cloud Run, `planner.commission` arrives over
// the MCP surface, and a Netlify function is a third. The only thing all three share is the object
// store, so the only lock all three can take is a durable one.
//
// THE PRIMITIVE IS create-if-absent. `setJSON(key, value, { onlyIfNew: true })` maps to
// `ifGenerationMatch: 0` on GCS and to Netlify Blobs' own create-only condition, and a failed
// precondition comes back as `{ modified: false }` rather than a throw (gcsStoreClient.ts §2). Two
// racing callers therefore get one `modified: true` and one `modified: false` from the store itself
// — no read, no window, no interpretation. `templateLibraryStore.ts` already leans on exactly this
// for version keys; this is the same guarantee applied to a request id.
//
// NO EVIDENCE MEANS NO START. Every failure mode here is reported, never swallowed. A store that
// cannot be read is `store_unavailable`, and the caller refuses to commission — the inverse of the
// `.catch(() => [])` this task exists to delete, where an unreadable run list read as "nothing is
// running" and cleared the way for the very duplicate it was checking for.
import { getBlobJsonWithEtag, getCmsAgentBlobStore, type BlobStoreClient } from "../repository/blobs/blobClient.js";

export const COMMISSION_RESERVATION_CONTRACT = "commission_reservation.v1";

/**
 * How long a reservation may sit in `reserved` before another caller may take it over.
 *
 * This is a CRASH window, not a run duration: the gap between taking the reservation and
 * `markStarted` is two awaits, so anything still `reserved` fifteen minutes later belongs to a
 * process that died in between. A run itself takes hours and is `started` for all of them, and a
 * `started` reservation is NEVER reclaimable by age — a reservation whose run is still going is the
 * one thing this module must never hand to a second caller.
 */
export const RESERVATION_STALE_MS = 15 * 60 * 1000;

/** The same TTL question for a whole commissioning pass. Long enough for a model turn plus starts. */
export const PASS_LEASE_STALE_MS = 10 * 60 * 1000;

export type ReservationState = "reserved" | "started" | "abandoned";

export type CommissionReservation = {
  contract: typeof COMMISSION_RESERVATION_CONTRACT;
  projectId: string;
  requestId: string;
  reservedAt: string;
  /** Who holds it — the job, or the operator tool. Carried so a stuck reservation names its owner. */
  reservedBy: string;
  state: ReservationState;
  runId?: string;
  startedAt?: string;
  releasedAt?: string;
  /** Why a reservation was abandoned, or which holder it was reclaimed from. */
  detail?: string;
};

export type ReserveOutcome =
  | { ok: true; reservation: CommissionReservation; reclaimedFrom?: CommissionReservation }
  | { ok: false; reason: "held"; holder: CommissionReservation }
  | { ok: false; reason: "store_unavailable"; detail: string };

// TENANT-FIRST KEY SPACE, the shape `capability-gaps/{tenantId}/{gapId}.json` and
// `driverHealth/{projectId}.json` already use: scoping is a property of the PATH, so a listing can
// never accidentally cross tenants by omitting a filter it was supposed to pass.
const PROJECT_PREFIX = (projectId: string) => `commission-reservations/${encodeURIComponent(projectId)}/`;
const reservationKey = (projectId: string, requestId: string) => `${PROJECT_PREFIX(projectId)}${encodeURIComponent(requestId)}.json`;
// `_pass` cannot collide with a request id: the tenant request-id grammar on this fleet is
// `^req_[a-z0-9_]+_\d{8}_\d{2}$`, and nothing that matches it starts with an underscore.
const passLeaseKey = (projectId: string) => `${PROJECT_PREFIX(projectId)}_pass.json`;

const MAX_WRITE_RETRIES = 3;

/** The store's own answer to a conditional write. Absent/undefined means the double did not report one. */
const wrote = (result: unknown): boolean => !result || (result as { modified?: boolean }).modified !== false;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ageMs = (iso: string, now: Date): number => {
  const then = Date.parse(iso);
  // An unparseable timestamp is treated as INFINITELY OLD rather than brand new, so a corrupted
  // record cannot wedge a request id for ever. It is still only reclaimable with run evidence.
  return Number.isNaN(then) ? Number.POSITIVE_INFINITY : now.getTime() - then;
};

export const isReclaimable = (reservation: CommissionReservation, now: Date): boolean =>
  reservation.state === "abandoned" ||
  (reservation.state === "reserved" && ageMs(reservation.reservedAt, now) >= RESERVATION_STALE_MS);

export class CommissionReservationStore {
  constructor(
    private readonly store: BlobStoreClient = getCmsAgentBlobStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async get(projectId: string, requestId: string): Promise<CommissionReservation | undefined> {
    const current = await getBlobJsonWithEtag<CommissionReservation>(this.store, reservationKey(projectId, requestId));
    return current.data ?? undefined;
  }

  /**
   * Take the reservation for one request id, or report who holds it.
   *
   * `allowReclaim` is the caller's SWORN EVIDENCE that no run exists for this request id — it is
   * passed as `true` only after a run-list read that actually succeeded. Without it a stale
   * reservation is reported as held rather than taken, because the failure this whole module exists
   * to prevent is precisely "assume nothing is running and start a second one".
   */
  async reserve(projectId: string, requestId: string, reservedBy: string, options: { allowReclaim?: boolean } = {}): Promise<ReserveOutcome> {
    const key = reservationKey(projectId, requestId);
    const now = this.now();
    const fresh: CommissionReservation = {
      contract: COMMISSION_RESERVATION_CONTRACT,
      projectId,
      requestId,
      reservedAt: now.toISOString(),
      reservedBy,
      state: "reserved"
    };

    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      let current: { data: CommissionReservation | null; etag?: string };
      try {
        current = await getBlobJsonWithEtag<CommissionReservation>(this.store, key);
      } catch (error) {
        return { ok: false, reason: "store_unavailable", detail: `reservation read failed for ${requestId}: ${errorText(error)}` };
      }

      const holder = current.data ?? undefined;
      if (holder) {
        if (!options.allowReclaim || !isReclaimable(holder, now)) return { ok: false, reason: "held", holder };
        // Reclaim is a COMPARE-AND-SWAP on the holder's own etag, not an overwrite: if a third
        // caller reclaimed it between our read and this write, we lose and re-read rather than
        // trampling the reservation they are already acting on.
        const takeover: CommissionReservation = { ...fresh, detail: `reclaimed from ${holder.reservedBy} (${holder.state}, reserved ${holder.reservedAt})` };
        let result: unknown;
        try {
          result = await this.store.setJSON(key, takeover, current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
        } catch (error) {
          return { ok: false, reason: "store_unavailable", detail: `reservation reclaim failed for ${requestId}: ${errorText(error)}` };
        }
        if (wrote(result)) return { ok: true, reservation: takeover, reclaimedFrom: holder };
        continue;
      }

      let result: unknown;
      try {
        // THE ATOMIC STEP. Not "write because the read said it was absent" — `onlyIfNew` makes the
        // store itself arbitrate, so the loser of a true race is told it lost instead of both
        // callers believing they won.
        result = await this.store.setJSON(key, fresh, { onlyIfNew: true });
      } catch (error) {
        return { ok: false, reason: "store_unavailable", detail: `reservation write failed for ${requestId}: ${errorText(error)}` };
      }
      if (wrote(result)) return { ok: true, reservation: fresh };
      // modified:false — another caller created this exact key since our read. Loop to read WHO,
      // so the refusal names them rather than saying "something went wrong".
    }

    const holder = await this.get(projectId, requestId).catch(() => undefined);
    return holder
      ? { ok: false, reason: "held", holder }
      : { ok: false, reason: "store_unavailable", detail: `reservation for ${requestId} could not be settled after ${MAX_WRITE_RETRIES} attempts` };
  }

  /** Bind the reservation to the run that was actually started. After this it is never reclaimable by age. */
  async markStarted(projectId: string, requestId: string, runId: string): Promise<void> {
    await this.patch(projectId, requestId, (held) => ({ ...held, state: "started", runId, startedAt: this.now().toISOString() }));
  }

  /**
   * Release a reservation whose start failed, so one refused start does not wedge the request id
   * until the stale window expires. Recorded as `abandoned` rather than deleted: the next pass can
   * see that this id was tried and refused, which a missing key cannot say.
   */
  async abandon(projectId: string, requestId: string, detail: string): Promise<void> {
    await this.patch(projectId, requestId, (held) => ({ ...held, state: "abandoned", releasedAt: this.now().toISOString(), detail }));
  }

  private async patch(projectId: string, requestId: string, mutate: (held: CommissionReservation) => CommissionReservation): Promise<void> {
    const key = reservationKey(projectId, requestId);
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<CommissionReservation>(this.store, key);
      if (!current.data) return;
      const result = await this.store.setJSON(key, mutate(current.data), current.etag ? { onlyIfMatch: current.etag } : undefined);
      if (wrote(result)) return;
    }
    // A reservation that cannot be stamped is not worth failing a started run over — the run exists,
    // and the stale-window rule plus the run-evidence requirement still prevent a duplicate.
  }

  // ── the pass lease ─────────────────────────────────────────────────────────
  //
  // Per-request reservations stop two callers minting the same id twice. They do NOT stop two
  // overlapping passes each reading `runsAlreadyToday: 0`, each planning a DIFFERENT topic, and each
  // starting a full day's allowance — the caps in plan.ts are computed once from a read that is
  // already stale by the time the first run starts. One lease per project per pass is what makes the
  // caps mean what they say, and taking it BEFORE the model turn means a losing caller also does not
  // pay for a plan it will not use.

  async acquirePass(projectId: string, holder: string): Promise<{ ok: true; token: string } | { ok: false; reason: "held" | "store_unavailable"; detail: string }> {
    const key = passLeaseKey(projectId);
    const now = this.now();
    const token = `${holder}:${now.toISOString()}:${Math.random().toString(36).slice(2, 10)}`;
    const lease = { contract: "commission_pass_lease.v1" as const, projectId, holder, token, acquiredAt: now.toISOString() };

    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      let current: { data: typeof lease | null; etag?: string };
      try {
        current = await getBlobJsonWithEtag<typeof lease>(this.store, key);
      } catch (error) {
        return { ok: false, reason: "store_unavailable", detail: `pass lease read failed: ${errorText(error)}` };
      }
      const held = current.data ?? undefined;
      if (held && ageMs(held.acquiredAt, now) < PASS_LEASE_STALE_MS) {
        return { ok: false, reason: "held", detail: `a commissioning pass for ${projectId} is already in flight (held by ${held.holder} since ${held.acquiredAt})` };
      }
      let result: unknown;
      try {
        result = await this.store.setJSON(key, lease, held ? (current.etag ? { onlyIfMatch: current.etag } : undefined) : { onlyIfNew: true });
      } catch (error) {
        return { ok: false, reason: "store_unavailable", detail: `pass lease write failed: ${errorText(error)}` };
      }
      if (wrote(result)) return { ok: true, token };
    }
    return { ok: false, reason: "held", detail: `pass lease for ${projectId} contended after ${MAX_WRITE_RETRIES} attempts` };
  }

  /** Release only OUR lease: a token mismatch means ours already expired and someone else holds it. */
  async releasePass(projectId: string, token: string): Promise<void> {
    const key = passLeaseKey(projectId);
    try {
      const current = await getBlobJsonWithEtag<{ token?: string }>(this.store, key);
      if (!current.data || current.data.token !== token) return;
      await this.store.delete(key);
    } catch {
      // A lease we cannot delete expires on its own; failing the pass over it would be worse.
    }
  }
}

// A single default instance, and a test seam. Built lazily so importing this module never touches the
// store — the same reason repositoryManager is lazy.
let store: CommissionReservationStore | undefined;
export const getCommissionReservationStore = (): CommissionReservationStore => (store ??= new CommissionReservationStore());
export const setCommissionReservationStore = (next: CommissionReservationStore | undefined): void => { store = next; };
