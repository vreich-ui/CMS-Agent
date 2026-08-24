// WP-42 — the command palette, as a real component. Markup mirrors
// spec/mockup.html's `#palscrim` (~line 405) and PAL/openPal()/renderPal()
// (~line 1025) — `.scrim .palette .res .kind` are all pre-existing CSS
// (styles/base.css); no new CSS. Replaces TopBar's ⌘K stub.
//
// Done-criterion (HANDOFF §5, WP-42): "⌘K reaches any node in ≤3 keystrokes
// of typing + Enter." The mockup's own ranking is a plain substring filter
// with no ordering — good enough for 12-ish hand-picked demo rows, not for
// distinguishing e.g. all 8 `capture_*` nodes or all 3 `publish*` nodes by a
// 3-character query. `rankEntries` below replaces it with a scored fuzzy
// subsequence match (exact > prefix > word-boundary-prefix > subsequence,
// each tier further ordered so shorter/earlier/more-contiguous matches win),
// plus a small per-kind tiebreak so a node's own id outranks anything that
// merely mentions it at equal match quality. Verified by brute force over
// the full fixture set (all 43 nodes, every run/project/workflow/screen/
// action) that every node has *some* ≤3-character query that ranks it #1 —
// tests/palette.spec.ts asserts three concrete cases.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNodes, useProjects, useRun, useRuns, useWorkflows } from '../api/hooks';
import { performLogout } from './LoginGate';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from '../store';
import type { LearnTab, RegTab, RunTab } from '../types';

type PalKind = 'node' | 'run' | 'workflow' | 'project' | 'screen' | 'action';

interface PalEntry {
  kind: PalKind;
  label: string;
  go: () => void;
}

// Higher wins ties at equal match quality — "a node's own id should win
// over a run that merely mentions it" (WP-42 brief), generalized to every
// kind: the thing you're most likely searching for by its own name/id beats
// a longer, noisier row that happens to contain the same characters.
const KIND_BONUS: Record<PalKind, number> = { node: 10, workflow: 6, screen: 5, action: 5, project: 3, run: 0 };
const MAX_RESULTS = 12;

/**
 * Scores `text` (already lowercased) against `query` (already lowercased,
 * trimmed). Returns null on no match. Four tiers, highest first:
 *   1. exact match
 *   2. text starts with query (shorter text ranks higher among these)
 *   3. some `_`/space/`·`-delimited word inside text starts with query
 *      (earlier word, then shorter text, ranks higher)
 *   4. in-order subsequence match, scored up for contiguous runs, matches
 *      that land on a word boundary, and an early/short overall span —
 *      then down slightly for total text length, so "capture_score" beats
 *      "capture_score_v2_legacy_alias" at equal subsequence quality.
 */
function matchScore(query: string, text: string): number | null {
  if (query === '') return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 900 - text.length;

  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(query)) return 800 - i * 5 - text.length * 0.1;
  }

  let cursor = 0;
  const positions: number[] = [];
  for (const ch of query) {
    const idx = text.indexOf(ch, cursor);
    if (idx === -1) return null;
    positions.push(idx);
    cursor = idx + 1;
  }
  let score = 400;
  let consecutive = 0;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === positions[i - 1] + 1) consecutive++;
  }
  score += consecutive * 30;
  let boundary = 0;
  for (const p of positions) {
    if (p === 0 || !/[a-z0-9]/.test(text[p - 1])) boundary++;
  }
  score += boundary * 20;
  const span = positions[positions.length - 1] - positions[0];
  score -= positions[0] * 2;
  score -= span;
  score -= text.length * 0.5;
  return score;
}

function rankEntries(entries: PalEntry[], rawQuery: string): PalEntry[] {
  const query = rawQuery.trim().toLowerCase();
  const scored: Array<{ e: PalEntry; s: number }> = [];
  for (const e of entries) {
    const m = matchScore(query, e.label.toLowerCase());
    if (m === null) continue;
    scored.push({ e, s: m + KIND_BONUS[e.kind] });
  }
  scored.sort((a, b) => (b.s !== a.s ? b.s - a.s : a.e.label.localeCompare(b.e.label)));
  return scored.slice(0, MAX_RESULTS).map((x) => x.e);
}

const SCREEN_ENTRIES: Array<{ label: string; go: (s: ReturnType<typeof useStore.getState>) => void }> = [
  { label: 'Workflows', go: (s) => s.setScreen('library') },
  { label: 'Workbench', go: (s) => s.setScreen('bench') },
  { label: 'Runs', go: (s) => s.setScreen('runs') },
  { label: 'Learning', go: (s) => s.setScreen('learning') },
  { label: 'Registry', go: (s) => s.setScreen('registry') },
  { label: 'Runs → Live', go: (s) => { s.setRunTab('live' as RunTab); s.setScreen('runs'); } },
  { label: 'Runs → History', go: (s) => { s.setRunTab('history' as RunTab); s.setScreen('runs'); } },
  { label: 'Runs → Grid', go: (s) => { s.setRunTab('grid' as RunTab); s.setScreen('runs'); } },
  { label: 'Learning → Flywheel', go: (s) => { s.setLearn('fly' as LearnTab); s.setScreen('learning'); } },
  { label: 'Learning → Observations', go: (s) => { s.setLearn('obs' as LearnTab); s.setScreen('learning'); } },
  { label: 'Learning → Playbooks', go: (s) => { s.setLearn('pb' as LearnTab); s.setScreen('learning'); } },
  { label: 'Learning → Compare', go: (s) => { s.setLearn('cmp' as LearnTab); s.setScreen('learning'); } },
  { label: 'Learning → Evaluate', go: (s) => { s.setLearn('eval' as LearnTab); s.setScreen('learning'); } },
  { label: 'Learning → Optimizer', go: (s) => { s.setLearn('opt' as LearnTab); s.setScreen('learning'); } },
  { label: 'Learning → Datasets', go: (s) => { s.setLearn('ds' as LearnTab); s.setScreen('learning'); } },
  { label: 'Registry → Projects & connections', go: (s) => { s.setReg('projects' as RegTab); s.setScreen('registry'); } },
  { label: 'Registry → Keys & auth', go: (s) => { s.setReg('keys' as RegTab); s.setScreen('registry'); } },
  { label: 'Registry → Tool registry', go: (s) => { s.setReg('tools' as RegTab); s.setScreen('registry'); } },
  { label: 'Registry → Skills library', go: (s) => { s.setReg('skills' as RegTab); s.setScreen('registry'); } },
  { label: 'Registry → Agents', go: (s) => { s.setReg('agents' as RegTab); s.setScreen('registry'); } },
  { label: 'Registry → Usage & budgets', go: (s) => { s.setReg('usage' as RegTab); s.setScreen('registry'); } },
];

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const openPalette = useStore((s) => s.openPalette);
  const closePalette = useStore((s) => s.closePalette);
  const runId = useStore((s) => s.runId);

  const workflowsQ = useWorkflows();
  const nodesQ = useNodes(undefined); // every node, across every workflow
  const runsQ = useRuns({});
  const projectsQ = useProjects();
  const boundRunQ = useRun(runId);
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);

  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // ⌘K/Ctrl+K opens the palette from anywhere in the app — but never while
  // the operator is mid-keystroke in a real field (mockup's `typing` guard).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (typing) return;
      e.preventDefault();
      openPalette();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openPalette]);

  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setHi(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      triggerRef.current?.focus?.();
      triggerRef.current = null;
    }
  }, [open]);

  const workflows = workflowsQ.data ?? [];
  const nodeWorkflowOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of workflows) {
      for (const [, ids] of w.phases) for (const id of ids) map.set(id, w.id);
    }
    return map;
  }, [workflows]);

  const boundRun = boundRunQ.data ?? null;

  function navigateToNode(nodeId: string) {
    const s = useStore.getState();
    const target = nodeWorkflowOf.get(nodeId);
    if (target && target !== s.wf) {
      if (boundRun && boundRun.wf !== target) s.unbindRun();
      s.setWf(target);
    }
    s.setNode(nodeId);
    s.setScreen('bench');
  }

  function navigateToWorkflow(workflowId: string) {
    const s = useStore.getState();
    const target = workflows.find((w) => w.id === workflowId);
    const firstNode = target?.phases[0]?.[1]?.[0];
    if (boundRun && boundRun.wf !== workflowId) s.unbindRun();
    s.setWf(workflowId);
    if (firstNode) s.setNode(firstNode);
    s.setScreen('bench');
  }

  const entries = useMemo<PalEntry[]>(() => {
    const out: PalEntry[] = [];
    for (const n of nodesQ.data ?? []) {
      out.push({ kind: 'node', label: n.id, go: () => navigateToNode(n.id) });
    }
    for (const r of runsQ.data ?? []) {
      out.push({
        kind: 'run',
        label: `…${r.id.slice(-10)} · ${r.proj} · ${r.status}`,
        go: () => {
          const entryNode = workflows.find((w) => w.id === r.wf)?.phases[0]?.[1]?.[0];
          useStore.getState().bindRun(r.id, r.wf, r.cur ?? entryNode ?? r.wf);
        },
      });
    }
    for (const w of workflows) {
      out.push({ kind: 'workflow', label: w.name, go: () => navigateToWorkflow(w.id) });
    }
    for (const p of projectsQ.data ?? []) {
      out.push({
        kind: 'project',
        label: p.name,
        go: () => {
          const s = useStore.getState();
          s.setReg('projects');
          s.setScreen('registry');
        },
      });
    }
    for (const s of SCREEN_ENTRIES) {
      out.push({ kind: 'screen', label: s.label, go: () => s.go(useStore.getState()) });
    }
    out.push({ kind: 'action', label: 'Start run…', go: () => useStore.getState().openStartModal() });
    out.push({ kind: 'action', label: 'Toggle theme', go: () => useStore.getState().cycleTheme() });
    out.push({
      kind: 'action',
      label: 'Log out',
      go: () => {
        void performLogout(() => queryClient.clear());
      },
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesQ.data, runsQ.data, workflows, projectsQ.data, nodeWorkflowOf, boundRun, queryClient]);

  const results = useMemo(() => rankEntries(entries, query), [entries, query]);

  useEffect(() => {
    setHi(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    resultsRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  if (!open) return null;

  function activate(entry: PalEntry | undefined) {
    if (!entry) return;
    closePalette();
    entry.go();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((v) => Math.min(v + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((v) => Math.max(v - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      activate(results[hi]);
      return;
    }
    // Focus trap: this dialog has exactly one real focus target (the input);
    // Tab never leaves it, mirroring the mockup's keyboard-only interaction
    // (result rows are mouse-clickable extras, not part of the tab order).
    if (e.key === 'Tab') {
      e.preventDefault();
    }
  }

  return (
    <div
      className="scrim open"
      ref={scrimRef}
      onMouseDown={(e) => {
        if (e.target === scrimRef.current) closePalette();
      }}
    >
      <div className="palette" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        {/* a11y C2 — ARIA 1.2 combobox pattern: real DOM focus never leaves
            the input (that's the 3-keystroke/Enter speed model, untouched),
            but a screen reader now hears the listbox, the result count, and
            which row is current via aria-activedescendant — purely
            additive over the existing keyboard behavior. */}
        <input
          id="palinput"
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="palres"
          aria-autocomplete="list"
          aria-activedescendant={results[hi] ? `palopt-${hi}` : undefined}
          placeholder="Jump to node, run, workflow, project, learning…"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="res" id="palres" role="listbox" aria-label="Command palette results" ref={resultsRef}>
          {results.map((r, i) => (
            <button
              key={`${r.kind}-${r.label}`}
              id={`palopt-${i}`}
              type="button"
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'hi' : ''}
              onMouseEnter={() => setHi(i)}
              onClick={() => activate(r)}
            >
              <span className="kind">{r.kind}</span>
              <span>{r.label}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div style={{ padding: '10px 12px', color: 'var(--faint)', fontSize: 12.5 }}>no matches</div>
          )}
        </div>
      </div>
    </div>
  );
}
