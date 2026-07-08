import { InMemoryWorkspaceStore } from "../../mcp/workspace/store.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";

export class MemoryWorkspaceRepository extends InMemoryWorkspaceStore implements WorkspaceRepository {
  constructor(private readonly backend: RepositoryBackend = "memory") { super(); }

  async health(): Promise<RepositoryHealth> {
    return healthyRepositoryStatus(this.backend);
  }
}
