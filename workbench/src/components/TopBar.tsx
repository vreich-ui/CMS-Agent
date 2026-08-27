import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRun, useWorkflows } from '../api/hooks';
import { IS_MOCK } from '../api/client';
import { performLogout, useAuthState } from './LoginGate';
import { useStore } from '../store';
import type { ScreenId } from '../types';
import { Ic } from './Icons';
import { toast } from './Toasts';

const NAV: Array<{ id: ScreenId; label: string }> = [
  { id: 'library', label: 'Workflows' },
  { id: 'bench', label: 'Workbench' },
  { id: 'runs', label: 'Runs' },
  { id: 'learning', label: 'Learning' },
  { id: 'registry', label: 'Registry' },
];

const THEME_ICON: Record<string, string> = { auto: '◐', light: '☀', dark: '☾' };

export function TopBar() {
  const screen = useStore((s) => s.screen);
  const setScreen = useStore((s) => s.setScreen);
  const wf = useStore((s) => s.wf);
  const setWf = useStore((s) => s.setWf);
  const setNode = useStore((s) => s.setNode);
  const mode = useStore((s) => s.mode);
  const runId = useStore((s) => s.runId);
  const unbindRun = useStore((s) => s.unbindRun);
  const theme = useStore((s) => s.theme);
  const cycleTheme = useStore((s) => s.cycleTheme);
  const openPalette = useStore((s) => s.openPalette);

  const workflowsQ = useWorkflows();
  const runQ = useRun(runId);
  const auth = useAuthState();
  const queryClient = useQueryClient();

  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setAccountOpen(false);
      }
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  async function handleLogout() {
    setAccountOpen(false);
    await performLogout(() => queryClient.clear());
    toast('Logged out', 'Your session cookie was cleared.');
  }

  const workflows = workflowsQ.data ?? [];
  const activeWf = workflows.find((w) => w.id === wf);
  const showRunChip = Boolean(runId) && screen === 'bench' && mode === 'run';
  const run = runQ.data;

  /** Mirrors the mockup's pickWf(): jump to the new workflow's first node,
   * and drop a bound run that belongs to a different workflow — otherwise
   * the rail/dock would show one workflow's nodes against another's run. */
  function pickWorkflow(id: string) {
    const target = workflows.find((w) => w.id === id);
    const firstNode = target?.phases[0]?.[1]?.[0];
    if (run && run.wf !== id) unbindRun();
    setWf(id);
    if (firstNode) setNode(firstNode);
    setMenuOpen(false);
  }

  return (
    <div className="topbar">
      <div className="wordmark">
        Conductor
        <small>agent workspace</small>
      </div>
      {/* a11y S6/N2/N3 — click-through navigation between whole screens,
          not a tab-panel swap, so aria-current="page" (not the tablist/tab
          pattern) plus a label distinguishing this <nav> from Registry's
          own section nav when both would otherwise announce as just
          "navigation". */}
      <nav className="main" id="mainnav" aria-label="Primary">
        {NAV.map((n) => (
          <button
            key={n.id}
            data-s={n.id}
            aria-current={screen === n.id ? 'page' : undefined}
            className={screen === n.id ? 'on' : ''}
            onClick={() => setScreen(n.id)}
          >
            {n.label}
          </button>
        ))}
      </nav>
      <div
        ref={wrapRef}
        style={{ position: 'relative', marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}
      >
        {showRunChip && runId && run && (
          <div className="runchip" id="runchip">
            <span className={`dot ${run.status}`} />
            {' …' + run.id.slice(-10)} · {run.proj} · {run.dry ? 'dry' : 'live'}
            <button className="x" onClick={unbindRun} title="unbind" aria-label="Unbind run">
              ✕
            </button>
          </div>
        )}
        <button
          className="wfsel"
          id="wfsel"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="lbl">workflow</span>
          <span className="fn">
            {activeWf && <Ic id={activeWf.icon} />}
            {activeWf?.name ?? wf}
          </span>
          <span className="car">▾</span>
        </button>
        <div className={`wfmenu${menuOpen ? ' open' : ''}`} id="wfmenu">
          {workflows.map((w) => (
            <button key={w.id} onClick={() => pickWorkflow(w.id)}>
              <Ic id={w.icon} />
              <span>
                <span className="t">{w.name}</span>
                <span className="sub">{w.short}</span>
              </span>
              <span className="n">{w.phases.reduce((n, [, ids]) => n + ids.length, 0)} nodes</span>
            </button>
          ))}
          <button className="dis" disabled>
            <Ic id="ic-charity" />
            <span>
              <span className="t">Foundation-charity conductor</span>
              <span className="sub">foundation &amp; charity publishing specialist — planned</span>
            </span>
            <span className="n">— nodes</span>
          </button>
        </div>
        {/* U1(d) — operator-worded: what state the workspace is in and what
            it means for what you can do here, never the env-flag name that
            happens to control it (that's an implementation detail, not
            something the operator can act on). */}
        {auth.status === 'authenticated' && (
          <span
            className="chip"
            style={auth.readOnly ? { color: 'var(--acc)' } : { color: 'var(--ok)' }}
            title={
              auth.readOnly
                ? 'Read-only workspace — you can look, but nothing here can change anything: runs, publishes, and edits are all blocked.'
                : 'Read-write workspace — your actions here take real effect: runs execute, publishes go live, edits save immediately.'
            }
          >
            {auth.readOnly ? 'read-only' : 'read-write'}
          </span>
        )}
        <button
          className="kbd"
          id="themebtn"
          title={`Theme: ${theme} (click to cycle)`}
          onClick={cycleTheme}
        >
          {THEME_ICON[theme]}
        </button>
        <button className="kbd" id="kbtn" title="Command palette" onClick={openPalette}>
          ⌘K
        </button>
        {/* U1(d) — this used to be an unexplained "operator ▾" caret. It
            holds exactly two things: who's signed in, and Log out — so it
            now says "Session" up front instead of making the operator
            guess what a bare name-plus-caret opens. */}
        {auth.status === 'authenticated' && (
          <div ref={accountRef} style={{ position: 'relative' }}>
            <button
              className="kbd"
              id="accountbtn"
              aria-haspopup="true"
              aria-expanded={accountOpen}
              title={`Session — signed in as ${auth.operator ?? 'operator'}. Click for account actions.`}
              onClick={() => setAccountOpen((v) => !v)}
            >
              Session: {auth.operator ?? 'operator'} ▾
            </button>
            <div className={`wfmenu${accountOpen ? ' open' : ''}`} id="accountmenu" style={{ minWidth: 190 }}>
              <button onClick={handleLogout} disabled={IS_MOCK} title={IS_MOCK ? 'Fixture mode has no real session to end.' : undefined}>
                <span>
                  <span className="t">Log out</span>
                  <span className="sub">clears the session cookie</span>
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
