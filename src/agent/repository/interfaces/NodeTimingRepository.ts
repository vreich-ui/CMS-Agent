import type { NodeTimingFilters, NodeTimingRecord } from "../../workspace/nodeTimings.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

// Mirrors UsageRepository exactly (record/list/clear/health): a node timing record is metering data
// the same shape a usage record is, just for wall-clock/outcome instead of tokens/cost. See
// nodeTimings.ts's header for why this exists and what may NOT yet consume it.
export interface NodeTimingRepository {
  record(record: NodeTimingRecord): Promise<NodeTimingRecord>;
  list(filters?: NodeTimingFilters): Promise<NodeTimingRecord[]>;
  clear(): void;
  health(): Promise<RepositoryHealth>;
}
