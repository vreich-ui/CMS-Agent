import { InMemoryExecutionStore } from "../../workspace/executionStore.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ExecutionRepository } from "../interfaces/ExecutionRepository.js";

export class MemoryExecutionRepository extends InMemoryExecutionStore implements ExecutionRepository {
  constructor(private readonly backend: RepositoryBackend = "memory") { super(); }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
