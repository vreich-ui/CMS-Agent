import { defaultProjectConnections } from "./drLurie/definition.js";
import type { ProjectConnectionConfig } from "./projectTypes.js";

const clone = <T>(value: T): T => structuredClone(value);

const defaultProjectsById = new Map(defaultProjectConnections.map((project) => [project.projectId, project]));

export function migrateDefaultProjectConfig(config: ProjectConnectionConfig): { config: ProjectConnectionConfig; changed: boolean } {
  const defaultConfig = defaultProjectsById.get(config.projectId);
  if (!defaultConfig) return { config: clone(config), changed: false };

  if (config.definitionVersion === defaultConfig.definitionVersion) {
    return { config: clone(config), changed: false };
  }

  return { config: clone(defaultConfig), changed: true };
}

export function defaultProjectConfigs(): ProjectConnectionConfig[] {
  return defaultProjectConnections.map((project) => clone(project));
}
