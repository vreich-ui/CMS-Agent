import type { ProjectProfile } from "../runtime/types.js";
import { projectA } from "./project-a.js";

const projects = new Map<string, ProjectProfile>([[projectA.projectId, projectA]]);

export function getProject(projectId: string): ProjectProfile {
  const project = projects.get(projectId);
  if (!project) throw new Error(`Unknown projectId: ${projectId}`);
  return project;
}

export function listProjects(): ProjectProfile[] {
  return [...projects.values()];
}
