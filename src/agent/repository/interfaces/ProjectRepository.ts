import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface ProjectRepository {
  list(): Promise<ProjectConnectionConfig[]>;
  get(projectId: string): Promise<ProjectConnectionConfig | undefined>;
  save(config: ProjectConnectionConfig): Promise<ProjectConnectionConfig>;
  health(): Promise<RepositoryHealth>;
}
