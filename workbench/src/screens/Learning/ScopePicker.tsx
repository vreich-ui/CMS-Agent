// CMS-Agent track A — the one control that sets ./scope.ts's shared
// selection. Used at the top of the Learning screen (index.tsx, applies to
// Observations + Playbooks) and inline on a node's Learning tab
// (Workbench/tabs/LearningTab.tsx), so picking a tenant once carries across
// both surfaces.

import { useProjects } from '../../api/hooks';
import { FLEET_SCOPE, projectScope, UNSELECTED_SCOPE, useLearnScope, setLearnScope, type PlaybookScope } from './scope';

const UNSELECTED_VALUE = '__unselected__';
const FLEET_VALUE = '__fleet__';

function valueFor(scope: PlaybookScope): string {
  if (scope.kind === 'unselected') return UNSELECTED_VALUE;
  if (scope.kind === 'fleet') return FLEET_VALUE;
  return scope.projectId;
}

export function ScopePicker({ compact }: { compact?: boolean }) {
  const scope = useLearnScope();
  const projectsQ = useProjects();
  const projects = projectsQ.data ?? [];

  function onChange(value: string) {
    if (value === UNSELECTED_VALUE) setLearnScope(UNSELECTED_SCOPE);
    else if (value === FLEET_VALUE) setLearnScope(FLEET_SCOPE);
    else setLearnScope(projectScope(value));
  }

  return (
    <div className="field" style={{ marginBottom: compact ? 0 : undefined, display: 'flex', alignItems: 'center', gap: 6 }}>
      {!compact && <label style={{ margin: 0 }}>playbook scope</label>}
      <select
        value={valueFor(scope)}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Playbook scope"
        title="Every playbook read and edit below targets this scope. Fleet is the shared record every tenant's dispatch reads; a project is that tenant's own record."
      >
        <option value={UNSELECTED_VALUE}>— select a scope —</option>
        <option value={FLEET_VALUE}>Fleet (shared by every tenant)</option>
        {[...projects]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
      </select>
      {scope.kind === 'unselected' && (
        <span style={{ color: 'var(--faint)', fontSize: 11 }}>pick a scope to read or edit a playbook</span>
      )}
    </div>
  );
}
