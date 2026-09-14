import type { TenantDriverHealth, TickLedgerEntry } from "../../workspace/driverHealth.js";
import type { DispatchHeartbeat } from "../../workspace/dispatchHeartbeat.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { DriverHealthRepository, TickLedgerFilters } from "../interfaces/DriverHealthRepository.js";

export class MemoryDriverHealthRepository implements DriverHealthRepository {
  private readonly ticks = new Map<string, TickLedgerEntry>();
  private readonly tenants = new Map<string, TenantDriverHealth>();
  private readonly heartbeats = new Map<string, DispatchHeartbeat>();

  constructor(private readonly backend: RepositoryBackend = "memory") {}

  async recordTick(entry: TickLedgerEntry): Promise<TickLedgerEntry> {
    this.ticks.set(entry.tickId, entry);
    return entry;
  }

  async listTicks(filters: TickLedgerFilters = {}): Promise<TickLedgerEntry[]> {
    const entries = [...this.ticks.values()]
      .filter((entry) => (!filters.from || entry.startedAt >= filters.from) && (!filters.to || entry.startedAt <= filters.to))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return filters.limit === undefined ? entries : entries.slice(0, Math.max(0, Math.floor(filters.limit)));
  }

  async pruneTicks(before: string): Promise<number> {
    let removed = 0;
    for (const [tickId, entry] of this.ticks) {
      if (entry.startedAt < before) { this.ticks.delete(tickId); removed += 1; }
    }
    return removed;
  }

  async recordTenantDispatch(record: TenantDriverHealth): Promise<TenantDriverHealth> {
    this.tenants.set(record.projectId, record);
    return record;
  }

  async recordDispatchHeartbeat(beat: DispatchHeartbeat): Promise<DispatchHeartbeat> {
    this.heartbeats.set(beat.runId, { ...beat, nodeIds: [...beat.nodeIds] });
    return beat;
  }

  async getDispatchHeartbeat(runId: string): Promise<DispatchHeartbeat | undefined> {
    return this.heartbeats.get(runId);
  }

  async clearDispatchHeartbeat(runId: string): Promise<void> {
    this.heartbeats.delete(runId);
  }

  async getTenantHealth(projectId: string): Promise<TenantDriverHealth | undefined> {
    return this.tenants.get(projectId);
  }

  async listTenantHealth(): Promise<TenantDriverHealth[]> {
    return [...this.tenants.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  clear(): void {
    this.ticks.clear();
    this.tenants.clear();
    this.heartbeats.clear();
  }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
