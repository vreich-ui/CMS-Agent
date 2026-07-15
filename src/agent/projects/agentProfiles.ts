// Agent EXECUTION PROFILES for /api/agent — one of the two "project" concepts in this codebase:
//   1. ProjectProfile (this module): how the reusable base agent runs for a project — instructions,
//      workflows, skills, memory namespace, publishing target. Code-defined, consumed by runAgent.
//   2. ProjectConnectionConfig (projectTypes.ts + ProjectRepository): a registered external
//      publishing client's MCP connection — env-var references, tool allow-list, content contract.
//      Registry-persisted, consumed by the project.* MCP tools.
// They intentionally share projectId values when both exist for the same client. Unifying them
// behind one registry is roadmap; until then this file is named agentProfiles to keep the two
// concepts from blurring. (Formerly projects/registry.ts.)
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
