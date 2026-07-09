import { defaultProjectConnections } from "../../projects/drLurie/definition.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import type { RepositoryBackend } from "../RepositoryManager.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ProjectRepository } from "../interfaces/ProjectRepository.js";

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, ProjectConnectionConfig>();

  constructor(private readonly backend: RepositoryBackend = "memory") {
    defaultProjectConnections.forEach((project) => this.projects.set(project.projectId, clone(project)));
  }

  async list(): Promise<ProjectConnectionConfig[]> {
    return [...this.projects.values()].map((project) => clone(project)).sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  async get(projectId: string): Promise<ProjectConnectionConfig | undefined> {
    const project = this.projects.get(projectId);
    return project ? clone(project) : undefined;
  }

  async save(config: ProjectConnectionConfig): Promise<ProjectConnectionConfig> {
    this.projects.set(config.projectId, clone(config));
    return clone(config);
  }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus(this.backend), version: `${this.backend}.v1` };
  }
}
