import { buildProjectOptions } from "../projects";
import { projectConnectionBadge } from "../nodeInspector";
import type { ProjectSummary } from "../types/workspace";

// GitHub-selector spirit: always available, upper-left, low visual emphasis, keyboard operable.
// A native labeled select is fully accessible at the current project count; a searchable combobox
// is the documented growth path once the list outgrows a select. Selection is a UI preference
// (localStorage) and never touches the current route.
type Props = {
  projects: ProjectSummary[] | null;
  runProjectIds: string[];
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  error?: string | null;
  onRetry?: () => void;
};

export function ProjectSelector({ projects, runProjectIds, selectedProjectId, onSelect, error, onRetry }: Props) {
  const groups = buildProjectOptions(projects, runProjectIds, selectedProjectId);
  // Connection badge (CHANGE-PLAN R-11): whether the selected client is reachable at all is
  // context for everything else on screen, so it belongs next to the selector rather than three
  // clicks away on the Access page. `title` carries the env var names — a badge that says "not
  // configured" without naming what to configure is a dead end.
  const badge = projectConnectionBadge(projects?.find((project) => project.projectId === selectedProjectId) ?? null);
  return <div className="project-selector">
    <label>
      <span className="project-selector-label">Project</span>
      <select value={selectedProjectId ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
        <option value="">All projects</option>
        {groups.orphanSelection && <option value={groups.orphanSelection.id}>{groups.orphanSelection.label}</option>}
        {groups.registered.length > 0 && <optgroup label="Registered projects">
          {groups.registered.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </optgroup>}
        {groups.fromRuns.length > 0 && <optgroup label="Seen in runs">
          {groups.fromRuns.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </optgroup>}
      </select>
    </label>
    {badge && <span className={`connection-badge connection-badge--${badge.tone}`} title={badge.title}>{badge.label}</span>}
    {error && onRetry && <button type="button" className="link-button" onClick={onRetry} title={error}>Retry projects</button>}
  </div>;
}
