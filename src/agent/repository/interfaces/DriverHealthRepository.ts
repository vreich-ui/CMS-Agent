import type { TenantDriverHealth, TickLedgerEntry } from "../../workspace/driverHealth.js";
import type { DispatchHeartbeat } from "../../workspace/dispatchHeartbeat.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

// W0 T0.2/T0.3 — the store behind the tick ledger and the per-tenant background-dispatch stamp.
// Mirrors NodeTimingRepository's shape (record/list/health/clear) for the same reason: this is
// metering data about the DRIVERS, kept beside the run records rather than inside them, so a tick
// that drove nothing still leaves a durable trace. Everything here is best-effort telemetry — no
// caller may make a dispatch decision conditional on a write to it succeeding.
export type TickLedgerFilters = { from?: string; to?: string; limit?: number };

export interface DriverHealthRepository {
  recordTick(entry: TickLedgerEntry): Promise<TickLedgerEntry>;
  listTicks(filters?: TickLedgerFilters): Promise<TickLedgerEntry[]>;
  // Drops ledger entries that started before `before` (ISO 8601). Returns how many were removed.
  pruneTicks(before: string): Promise<number>;
  recordTenantDispatch(record: TenantDriverHealth): Promise<TenantDriverHealth>;
  // D3 — the in-flight dispatch heartbeat (dispatchHeartbeat.ts). One document per run, overwritten
  // in place, cleared when the dispatch ends. Deliberately NOT on the run record: that record is
  // compare-and-swap and a 15-second write to it would manufacture the conflict D1 exists to survive.
  recordDispatchHeartbeat(beat: DispatchHeartbeat): Promise<DispatchHeartbeat>;
  getDispatchHeartbeat(runId: string): Promise<DispatchHeartbeat | undefined>;
  clearDispatchHeartbeat(runId: string): Promise<void>;
  getTenantHealth(projectId: string): Promise<TenantDriverHealth | undefined>;
  listTenantHealth(): Promise<TenantDriverHealth[]>;
  clear(): void;
  health(): Promise<RepositoryHealth>;
}
