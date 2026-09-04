import type { TenantDriverHealth, TickLedgerEntry } from "../../workspace/driverHealth.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { DriverHealthRepository, TickLedgerFilters } from "../interfaces/DriverHealthRepository.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

// The two key spaces the W0 plan names: `ticks/<tickId>.json` and `driverHealth/<projectId>.json`.
// One document per tick and one per tenant, no index — the ledger is read by prefix at incident time
// (a 48-hour window at a 2-minute cadence is ~1,440 small documents) and the tenant space has one
// document per project. Every method is best-effort telemetry; nothing dispatches on it.
const TICK_PREFIX = "ticks/";
const tickKey = (tickId: string) => `${TICK_PREFIX}${tickId}.json`;
const tenantKey = (projectId: string) => `driverHealth/${projectId}.json`;

export class BlobDriverHealthRepository implements DriverHealthRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async recordTick(entry: TickLedgerEntry): Promise<TickLedgerEntry> {
    await this.store.setJSON(tickKey(entry.tickId), entry);
    return entry;
  }

  async listTicks(filters: TickLedgerFilters = {}): Promise<TickLedgerEntry[]> {
    const result = await this.store.list({ prefix: TICK_PREFIX });
    const entries = await Promise.all(result.blobs.map((blob) => getBlobJson<TickLedgerEntry>(this.store, blob.key)));
    const found = entries
      .filter((entry): entry is TickLedgerEntry => entry !== null)
      .filter((entry) => (!filters.from || entry.startedAt >= filters.from) && (!filters.to || entry.startedAt <= filters.to))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return filters.limit === undefined ? found : found.slice(0, Math.max(0, Math.floor(filters.limit)));
  }

  async pruneTicks(before: string): Promise<number> {
    const result = await this.store.list({ prefix: TICK_PREFIX });
    const entries = await Promise.all(result.blobs.map(async (blob) => ({ key: blob.key, entry: await getBlobJson<TickLedgerEntry>(this.store, blob.key) })));
    const stale = entries.filter(({ entry }) => entry !== null && entry.startedAt < before);
    for (const { key } of stale) await this.store.delete(key);
    return stale.length;
  }

  async recordTenantDispatch(record: TenantDriverHealth): Promise<TenantDriverHealth> {
    await this.store.setJSON(tenantKey(record.projectId), record);
    return record;
  }

  async getTenantHealth(projectId: string): Promise<TenantDriverHealth | undefined> {
    return (await getBlobJson<TenantDriverHealth>(this.store, tenantKey(projectId))) ?? undefined;
  }

  async listTenantHealth(): Promise<TenantDriverHealth[]> {
    const result = await this.store.list({ prefix: "driverHealth/" });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<TenantDriverHealth>(this.store, blob.key)));
    return records.filter((record): record is TenantDriverHealth => record !== null).sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  clear(): void { throw new Error("BlobDriverHealthRepository.clear is only available in memory mode."); }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "driver_health.v1" }; }
}
