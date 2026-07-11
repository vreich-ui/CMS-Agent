// Framework-free option model for the header project selector. Registered projects come from
// project.list; dry-run projectIds (e.g. "project-a") are not registered, so they surface as a
// separate honest group. A persisted selection that matches neither is injected rather than
// silently dropped.

import type { ProjectSummary, WorkflowExecutionRecord } from "./types/workspace.js";

export type ProjectOption = { id: string; label: string };

export type ProjectOptionGroups = {
  registered: ProjectOption[];
  fromRuns: ProjectOption[];
  orphanSelection?: ProjectOption;
};

export function distinctRunProjectIds(runs: WorkflowExecutionRecord[]): string[] {
  return [...new Set(runs.map((run) => run.projectId).filter(Boolean))].sort();
}

export function buildProjectOptions(
  projects: ProjectSummary[] | null,
  runProjectIds: string[],
  selectedId: string | null
): ProjectOptionGroups {
  const registered = (projects ?? [])
    .map((project) => ({ id: project.projectId, label: project.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const registeredIds = new Set(registered.map((option) => option.id));
  const fromRuns = [...new Set(runProjectIds)]
    .filter((id) => id && !registeredIds.has(id))
    .sort()
    .map((id) => ({ id, label: id }));
  const known = new Set([...registeredIds, ...fromRuns.map((option) => option.id)]);
  const orphanSelection = selectedId && !known.has(selectedId) ? { id: selectedId, label: `${selectedId} (not found)` } : undefined;
  return { registered, fromRuns, ...(orphanSelection ? { orphanSelection } : {}) };
}
