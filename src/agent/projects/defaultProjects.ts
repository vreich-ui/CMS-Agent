// Code-defined default project connections. This list is the ONLY place a project earns
// default/seeded status; repositories seed and migrate from it (see defaultMigration.ts). Each
// entry's actual definition lives in that project's own folder — the workspace core stays
// project-agnostic and merely aggregates.
import type { ProjectConnectionConfig } from "./projectTypes.js";
import { drLurieProjectConfig } from "./drLurie/definition.js";

export const defaultProjectConnections: ProjectConnectionConfig[] = [drLurieProjectConfig];
