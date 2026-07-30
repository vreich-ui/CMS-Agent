// G3 (T-2 re-run, run_1785405350649_9u5mjz): platform went a full definitionVersion behind dr-lurie
// on the object-dialect parameters with nothing noticing until a live run's cost regressed. Being
// absent from defaultProjectConnections (fixed in defaultProjects.ts) was the mechanism, but the
// underlying gap is that nothing ever CHECKED whether an active, publish-capable project actually has
// the object-dialect config its own publish hook needs. This is that check: a project whose hooks
// declare executePublish (i.e. it participates in the object-native publish flow — see
// projectHooks.ts) is assumed to need a complete ProjectObjectDialect; one that lacks it, or is
// missing a required field within it, is reported by name and by field, not silently tolerated.
import { getProjectHooks } from "./projectHooks.js";
import type { ProjectConnectionConfig, ProjectObjectDialect } from "./projectTypes.js";

const REQUIRED_DIALECT_FIELDS: Array<keyof ProjectObjectDialect> = ["siteObjectId", "taxonomyRegistryObjectId", "objectIdSource", "defaultObjectType"];

// Every project whose registered hooks execute a live publish needs a complete dialect; a project
// with no executePublish hook (pdf-tool, monetizer) is not object-native and needs none.
const needsObjectDialect = (projectId: string): boolean => getProjectHooks(projectId)?.executePublish !== undefined;

export type ProjectDialectFinding = { projectId: string; missingFields: string[] };

// Pure: no I/O, callable from a repository's health() or a startup check alike. Only active projects
// are checked — a disabled project's incomplete config is not an operational problem.
export function auditProjectObjectDialects(projects: ProjectConnectionConfig[]): ProjectDialectFinding[] {
  const findings: ProjectDialectFinding[] = [];
  for (const project of projects) {
    if (project.status !== "active" || !needsObjectDialect(project.projectId)) continue;
    const missingFields = project.objectDialect
      ? REQUIRED_DIALECT_FIELDS.filter((field) => !project.objectDialect![field])
      : [...REQUIRED_DIALECT_FIELDS];
    if (missingFields.length) findings.push({ projectId: project.projectId, missingFields });
  }
  return findings;
}

export function formatProjectDialectFindings(findings: ProjectDialectFinding[]): string[] {
  return findings.map((finding) => `${finding.projectId}: missing objectDialect.${finding.missingFields.join(", objectDialect.")}`);
}
