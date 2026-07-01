import type { ProjectProfile } from "../runtime/types.js";
import { projectA } from "./project-a.js";

export class ProjectNotFoundError extends Error {
  readonly code = "PROJECT_NOT_FOUND";

  constructor(projectId: string) {
    super(`Unknown projectId: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

const projects = new Map<string, ProjectProfile>([[projectA.projectId, projectA]]);

export function getProject(projectId: string): ProjectProfile {
  const project = projects.get(projectId);
  if (!project) throw new ProjectNotFoundError(projectId);
  return project;
}

export function listProjects(): ProjectProfile[] {
  return [...projects.values()];
}
