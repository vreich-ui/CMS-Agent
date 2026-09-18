// Session-local state for two things that still have no better home:
//
//   1. `useApprovedDelta`/`bumpApprovedExamples` — dataset_finetune_readiness's
//      `approvedExamples` has no live mutator anywhere (fixture or real
//      backend): `feedback_record` only ever bumps `preferencePairs`
//      (mockStore.recordPreferencePair()), whatever verdict is passed. This
//      is a real backend/fixture gap, out of CMS-Agent track A's scope
//      (learning/playbook views only — see AGENTS.md's per-task boundary and
//      the track-A report), so it is left exactly as WP-54 built it. Read by
//      Flywheel.tsx, Datasets.tsx, Workbench/tabs/{ThisRunTab,LearningTab}.tsx.
//
//   2. `useCuratedNodeIds`/`markNodeCuratedThisSession` — a SESSION-ONLY
//      "which nodes did I successfully persist a lesson to, this session"
//      set, read only by Flywheel.tsx's "Curate" stage counter. This is
//      deliberately NOT a source of playbook truth any more: as of track A,
//      Learning/PlaybookPanel.tsx (shared by Playbooks.tsx and the node's
//      Learning tab) reads and writes the REAL persisted playbook via
//      playbook_get/playbook_apply_delta (api/verbs.ts, api/adapters.ts) and
//      calls markNodeCuratedThisSession only as a side effect, purely so
//      Flywheel's counter still moves. There is no bulk "list every node's
//      playbook" verb (playbook_get takes exactly one nodeId), so a true
//      fleet-wide "N nodes have a playbook" count cannot be computed
//      honestly without 48 individual reads; this session-scoped
//      approximation is the documented, deliberate stand-in — see the
//      CMS-Agent-track-A report's dependency note. Fixing Flywheel's counter
//      properly needs either a `playbook.list` verb or an accepted N-read
//      cost, neither decided here.

import { useSyncExternalStore } from 'react';

interface OverlayState {
  approvedDelta: number;
  curatedThisSession: Set<string>;
}

const state: OverlayState = {
  approvedDelta: 0,
  curatedThisSession: new Set(),
};

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getVersion(): number {
  return version;
}

// --- mutations ---------------------------------------------------------

export function bumpApprovedExamples(): void {
  state.approvedDelta += 1;
  emit();
}

export function markNodeCuratedThisSession(nodeId: string): void {
  if (state.curatedThisSession.has(nodeId)) return;
  state.curatedThisSession.add(nodeId);
  emit();
}

// --- snapshots -----------------------------------------------------------

export function getApprovedDelta(): number {
  return state.approvedDelta;
}
export function getCuratedNodeIds(): string[] {
  return [...state.curatedThisSession];
}

// --- hooks -----------------------------------------------------------------

export function useApprovedDelta(): number {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getApprovedDelta();
}
export function useCuratedNodeIds(): string[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getCuratedNodeIds();
}
