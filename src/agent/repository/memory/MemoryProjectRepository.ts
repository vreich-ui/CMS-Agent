import { defaultProjectConfigs, migrateDefaultProjectConfig } from "../../projects/defaultMigration.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ProjectRepository } from "../interfaces/ProjectRepository.js";

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, ProjectConnectionConfig>();

  constructor(private readonly backend: RepositoryBackend = "memory") {
    defaultProjectConfigs().forEach((project) => this.projects.set(project.projectId, clone(project)));
  }

  async list(): Promise<ProjectConnectionConfig[]> {
    return (await Promise.all([...this.projects.keys()].map((projectId) => this.get(projectId))))
      .filter((project): project is ProjectConnectionConfig => project !== undefined)
      .sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  async get(projectId: string): Promise<ProjectConnectionConfig | undefined> {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    const migrated = migrateDefaultProjectConfig(project);
    if (migrated.changed) this.projects.set(projectId, clone(migrated.config));
    return clone(migrated.config);
  }

  async save(config: ProjectConnectionConfig): Promise<ProjectConnectionConfig> {
    this.projects.set(config.projectId, clone(config));
    return clone(config);
  }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus(this.backend), version: `${this.backend}.v1` };
  }
}
