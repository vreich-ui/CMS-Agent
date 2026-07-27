// Code-defined default project connections. This list is the ONLY place a project earns
// default/seeded status; repositories seed and migrate from it (see defaultMigration.ts). Each
// entry's actual definition lives in that project's own folder — the workspace core stays
// project-agnostic and merely aggregates.
//
// Membership here is also a DELETION GUARD: projectAdmin.deleteProject refuses any id in this list
// ("default_project_protected") because a seeded project is re-created on the next read, so the
// delete would only appear to work. Removing an entry is therefore the first half of retiring a
// project — the persisted record survives the removal and becomes deletable via project.delete.
//
// snoocle was removed here (CHANGE-PLAN W-2): a placeholder registration for a client that never
// published through this workspace, referenced by nothing outside its own definition. Synthetic
// clients come from create-site, not from fake default registrations.
//
// monetizer deliberately STAYS, despite the plan listing it alongside snoocle: it is not a fake
// registration. src/agent/improvement/monetizerIngest.ts imports monetizerProjectConfig directly
// to power the feedback.ingest_monetizer MCP tool (the Phase 7 outer loop), so deleting the
// definition would remove a live tool from the wire surface. Retiring it is a decision about that
// loop, not registry hygiene — its workspace record is disabled in the meantime.
import type { ProjectConnectionConfig } from "./projectTypes.js";
import { drLurieProjectConfig } from "./drLurie/definition.js";
import { pdfToolProjectConfig } from "./pdfTool/definition.js";
import { monetizerProjectConfig } from "./monetizer/definition.js";

export const defaultProjectConnections: ProjectConnectionConfig[] = [
  drLurieProjectConfig,
  pdfToolProjectConfig,
  monetizerProjectConfig
];
