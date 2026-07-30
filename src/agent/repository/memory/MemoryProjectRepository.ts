import { defaultProjectConfigs, migrateDefaultProjectConfig } from "../../projects/defaultMigration.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import { auditProjectObjectDialects, formatProjectDialectFindings } from "../../projects/projectDialectAudit.js";
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

  async delete(projectId: string): Promise<boolean> {
    return this.projects.delete(projectId);
  }

  // G3 (T-2 re-run, run_1785405350649_9u5mjz): see BlobProjectRepository.health() for why.
  async health(): Promise<RepositoryHealth> {
    const findings = formatProjectDialectFindings(auditProjectObjectDialects(await this.list()));
    return { ...healthyRepositoryStatus(this.backend), version: `${this.backend}.v1`, ...(findings.length ? { details: { objectDialectFindings: findings } } : {}) };
  }
}
