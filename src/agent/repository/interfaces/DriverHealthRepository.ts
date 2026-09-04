import type { TenantDriverHealth, TickLedgerEntry } from "../../workspace/driverHealth.js";
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
  getTenantHealth(projectId: string): Promise<TenantDriverHealth | undefined>;
  listTenantHealth(): Promise<TenantDriverHealth[]>;
  clear(): void;
  health(): Promise<RepositoryHealth>;
}
