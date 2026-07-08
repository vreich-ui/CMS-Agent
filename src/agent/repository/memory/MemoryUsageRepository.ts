import { InMemoryModelUsageStore } from "../../observability/modelUsageStore.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { UsageRepository } from "../interfaces/UsageRepository.js";

export class MemoryUsageRepository extends InMemoryModelUsageStore implements UsageRepository {
  constructor(private readonly backend: RepositoryBackend = "memory") { super(); }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
