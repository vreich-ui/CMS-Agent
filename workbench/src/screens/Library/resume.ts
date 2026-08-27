// U1(b) — "Resume where I left off". Tracks the operator's live wf/node/run
// context (wherever it changes, on any screen — this module subscribes to
// the store directly rather than only reacting while Library itself is
// mounted) and persists it to localStorage so the chip on the next visit
// (same session or a fresh reload) can say exactly what it will restore
// before it's clicked.
//
// Storage access follows store.ts's own theme-persistence pattern: every
// read/write wrapped in try/catch, `auto`/no-value on any failure — see
// readStoredTheme()/persistTheme() there.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';

const RESUME_KEY = 'cw-resume';

export interface ResumeContext {
  wf: string;
  node: string;
  runId: string | null;
}

function persistResume(ctx: ResumeContext): void {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(ctx));
  } catch {
    // ignore — storage unavailable
  }
}

export function readResume(): ResumeContext | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ResumeContext> | null;
    if (parsed && typeof parsed.wf === 'string' && parsed.wf && typeof parsed.node === 'string' && parsed.node) {
      return { wf: parsed.wf, node: parsed.node, runId: typeof parsed.runId === 'string' ? parsed.runId : null };
    }
  } catch {
    // ignore — storage unavailable or corrupt; nothing to resume
  }
  return null;
}

// Registered once at module load. Library/index.tsx is statically imported
// by App.tsx, so this subscription is live for the whole session regardless
// of which screen is actually on screen — a run bound from the Runs table,
// or from an AttentionStrip jump, updates what "resume" means even though
// the operator never opened the Library screen in between.
//
// Deliberately scoped to bound runs only (`state.runId` truthy), not every
// wf/node change: the app boots straight onto the Workbench in build mode
// against a default workflow (store.ts's initial state), and Rail's
// adoptNode fills in a first node automatically on every cold load. If
// idle build-mode browsing were tracked too, the chip would always have
// *something* to show — even on a session that never did anything — which
// is not "where I left off", it's just where the app always starts. A
// bound run is the one state worth interrupting a fresh visit to restore.
let lastPersistedKey = '';
useStore.subscribe((state) => {
  if (!state.runId || !state.wf || !state.node) return;
  const ctx: ResumeContext = { wf: state.wf, node: state.node, runId: state.runId };
  const key = `${ctx.wf}|${ctx.node}|${ctx.runId}`;
  if (key === lastPersistedKey) return;
  lastPersistedKey = key;
  persistResume(ctx);
});

/** Reactive read — re-checks storage whenever the store changes, so the
 *  chip's own label stays truthful while the operator is on the Library
 *  screen (e.g. after unbinding a run elsewhere in the same tab). */
export function useResumeContext(): ResumeContext | null {
  const [ctx, setCtx] = useState<ResumeContext | null>(() => readResume());
  useEffect(() => {
    const unsubscribe = useStore.subscribe(() => setCtx(readResume()));
    return unsubscribe;
  }, []);
  return ctx;
}
