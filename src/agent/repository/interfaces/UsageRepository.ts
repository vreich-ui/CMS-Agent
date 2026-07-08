import type { ModelUsageFilters, ModelUsageRecord } from "../../observability/modelUsageTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface UsageRepository {
  record(record: ModelUsageRecord): Promise<ModelUsageRecord>;
  list(filters?: ModelUsageFilters): Promise<ModelUsageRecord[]>;
  clear(): void;
  health(): Promise<RepositoryHealth>;
}
