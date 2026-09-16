import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBootstrap, useRun, useWorkflows } from '../api/hooks';
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
  const bootstrapQ = useBootstrap(wf);
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
  // W3 — the node counts come off `workbench.bootstrap`, which already has them for every
  // registered workflow. This used to fetch a WHOLE GRAPH per workflow — three graph downloads
  // (~300 KB) on every cold paint — to read `.nodes.length` three times.
  const workflowCounts = bootstrapQ.data?.nodeCounts;
  // W3 — stale-while-revalidate, said out loud. The Workbench paints from a persisted cache on the
  // second visit (App.tsx), which is only honest if the screen admits how old what it is showing
  // is. `dataUpdatedAt` is when this client last heard from the server; `workspaceVersion` is what
  // the server said the workspace was at, and the refetch behind this pill is what moves it.
  const [freshnessTick, setFreshnessTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setFreshnessTick((v) => v + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);
  void freshnessTick;
  const updatedAgo = bootstrapQ.dataUpdatedAt ? Math.max(0, Math.round((Date.now() - bootstrapQ.dataUpdatedAt) / 1000)) : null;
  const freshness = bootstrapQ.isFetching
    ? 'refreshing…'
    : updatedAgo === null
      ? null
      : updatedAgo < 5
        ? 'updated just now'
        : updatedAgo < 90
          ? `updated ${updatedAgo}s ago`
          : `updated ${Math.round(updatedAgo / 60)}m ago`;
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
        {freshness && (
          <span
            className="chip"
            id="workspace-freshness"
            title={
              bootstrapQ.data
                ? `Workspace version ${bootstrapQ.data.workspaceVersion}. The Workbench paints from its last answer and refreshes in place; this is how old that answer is.`
                : undefined
            }
            onClick={() => void bootstrapQ.refetch()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void bootstrapQ.refetch(); } }}
            style={{ cursor: 'pointer' }}
          >
            {freshness}
          </span>
        )}
        <div className={`wfmenu${menuOpen ? ' open' : ''}`} id="wfmenu">
          {workflows.map((w) => (
            <button key={w.id} onClick={() => pickWorkflow(w.id)}>
              <Ic id={w.icon} />
              <span>
                <span className="t">{w.name}</span>
                <span className="sub">{w.short}</span>
              </span>
              <span className="n">{workflowCounts?.[w.id] ?? (bootstrapQ.isError ? 'unknown' : '…')} nodes</span>
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
