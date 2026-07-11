import { formatRoute, navPages, type AppRoute } from "../route";
import { ProjectSelector } from "./ProjectSelector";
import { ConnectionStatus } from "./ConnectionStatus";
import type { McpConnection } from "../connection";
import type { ProjectSummary } from "../types/workspace";

type Props = {
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  projects: ProjectSummary[] | null;
  projectsError: string | null;
  onRetryProjects: () => void;
  runProjectIds: string[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  connection: McpConnection;
};

// Real anchors with left-click interception: middle/cmd-click and copy-link work for free, and
// aria-current="page" is semantically honest.
function NavLink({ page, label, active, onNavigate }: { page: AppRoute["page"]; label: string; active: boolean; onNavigate: (route: AppRoute) => void }) {
  const route = { page } as AppRoute;
  return <a
    className="nav-link"
    href={formatRoute(route)}
    aria-current={active ? "page" : undefined}
    onClick={(event) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        onNavigate(route);
      }
    }}
  >{label}</a>;
}

export function AppHeader({ route, onNavigate, projects, projectsError, onRetryProjects, runProjectIds, selectedProjectId, onSelectProject, connection }: Props) {
  return <header className="app-header">
    <div className="app-header-left">
      <span className="product-mark">CMS-Agent</span>
      <ProjectSelector projects={projects} runProjectIds={runProjectIds} selectedProjectId={selectedProjectId} onSelect={onSelectProject} error={projectsError} onRetry={onRetryProjects} />
    </div>
    <nav className="app-nav" aria-label="Primary">
      {navPages.map(({ page, label }) => <NavLink key={page} page={page} label={label} active={route.page === page} onNavigate={onNavigate} />)}
    </nav>
    <ConnectionStatus connection={connection} onOpenSettings={() => onNavigate({ page: "settings" })} />
  </header>;
}
