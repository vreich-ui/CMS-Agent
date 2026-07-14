import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface ProjectRepository {
  list(): Promise<ProjectConnectionConfig[]>;
  get(projectId: string): Promise<ProjectConnectionConfig | undefined>;
  save(config: ProjectConnectionConfig): Promise<ProjectConnectionConfig>;
  // Remove a registered project. Returns whether a record existed. Code-defined default projects
  // re-seed on the next read, so callers must gate deletion (see projectAdmin.deleteProject).
  delete(projectId: string): Promise<boolean>;
  health(): Promise<RepositoryHealth>;
}
