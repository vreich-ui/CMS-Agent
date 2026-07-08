import type { ModelUsageFilters, ModelUsageRecord } from "../../observability/modelUsageTypes.js";

export interface UsageRepository {
  record(record: ModelUsageRecord): Promise<ModelUsageRecord>;
  list(filters?: ModelUsageFilters): Promise<ModelUsageRecord[]>;
  clear(): void;
}
