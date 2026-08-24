// WP-41 — the Registry surface: the one deliberate home for everything that
// is not a node or a run. spec/mockup.html: markup `#s-registry` (~line 355)
// — `.pagewrap .pagehead .reggrid .regnav`; behaviour `renderReg()`
// (~line 975). Class names / DOM structure copied verbatim; zero new CSS.
// Left-nav state lives in the shared store (`reg`/`setReg`, already defined
// in store.ts — read, not modified here). Each section is its own file so
// per-section loading/error handling stays simple.

import { useStore } from '../../store';
import type { RegTab } from '../../types';
import { ProjectsTab } from './ProjectsTab';
import { KeysTab } from './KeysTab';
import { ToolsTab } from './ToolsTab';
import { SkillsTab } from './SkillsTab';
import { AgentsTab } from './AgentsTab';
import { UsageTab } from './UsageTab';

const NAV: Array<{ id: RegTab; label: string }> = [
  { id: 'projects', label: 'Projects & connections' },
  { id: 'keys', label: 'Keys & auth' },
  { id: 'tools', label: 'Tool registry' },
  { id: 'skills', label: 'Skills library' },
  { id: 'agents', label: 'Agents' },
  { id: 'usage', label: 'Usage & budgets' },
];

export function Registry() {
  const reg = useStore((s) => s.reg);
  const setReg = useStore((s) => s.setReg);

  let body;
  switch (reg) {
    case 'projects':
      body = <ProjectsTab />;
      break;
    case 'keys':
      body = <KeysTab />;
      break;
    case 'tools':
      body = <ToolsTab />;
      break;
    case 'skills':
      body = <SkillsTab />;
      break;
    case 'agents':
      body = <AgentsTab />;
      break;
    case 'usage':
      body = <UsageTab />;
      break;
  }

  return (
    <main className="pagewrap">
      <div className="pagehead">
        <h1>Registry</h1>
        <span className="sub">projects · keys · tools · skills · agents · usage</span>
      </div>
      <div className="reggrid">
        {/* a11y S6/N2/N3 — this reads as navigation between whole sections
            (not a tab-panel swap), so aria-current="page" rather than the
            tablist/tab pattern; aria-label distinguishes it from TopBar's
            own unlabeled <nav> (both otherwise announce as just
            "navigation" when this screen is active). */}
        <nav className="regnav" id="regnav" aria-label="Registry sections">
          {NAV.map((n) => (
            <button
              key={n.id}
              data-r={n.id}
              aria-current={reg === n.id ? 'page' : undefined}
              className={reg === n.id ? 'on' : ''}
              onClick={() => setReg(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div id="regbody">
          {/* a11y M3 — heading level skipped from h1 straight to each
              section's own h3s, with no h2 anywhere in Registry. */}
          <h2 className="sr-only">{NAV.find((n) => n.id === reg)?.label}</h2>
          {body}
        </div>
      </div>
    </main>
  );
}
