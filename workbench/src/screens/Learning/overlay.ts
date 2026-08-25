// Session-local compensating layer for two known mock-backend gaps (see
// api/fixtures/README.md and api/client.ts's MOCK_HANDLERS — src/api/** is
// out of scope for this WP to change):
//
//   1. `playbook_curate` / `playbook_apply_delta` / `playbook_migrate_observations`
//      all fire for real (confirm-gated, respecting read-only mode) but
//      never persist — `playbook_get` always returns `{lessons: []}`
//      regardless of what was curated. Without something to hold the
//      result, the flywheel's Curate count and the node's Learning tab
//      could never move even after a genuinely successful curation — which
//      is this WP's literal done-criterion ("curating an observation moves
//      the flywheel counts and the lesson appears in the node's Learning
//      tab").
//   2. `dataset_finetune_readiness`'s `approvedExamples` has no mutator at
//      all in the fixture set — `feedback_record` only ever bumps
//      `preferencePairs` (via mockStore.recordPreferencePair()), whatever
//      verdict is passed. Real approvals/edits (WP-54) should visibly fill
//      the SFT-example meter.
//
// Both verbs still fire for real every time — this module only fills in
// the bookkeeping the fixture-mode backend doesn't do itself. Swapping in a
// live backend that actually persists playbooks/readiness would just make
// every merge below a no-op (real data would already carry what's added
// here), so nothing here needs to be torn out later — see the merge helpers
// at the bottom of playbook consumers (Learning/Playbooks.tsx,
// Workbench/tabs/LearningTab.tsx).

import { useSyncExternalStore } from 'react';

export interface CuratedLesson {
  id: string;
  text: string;
  tokens: number;
  fromObservationId?: string;
  when: string;
}

const EMPTY_LESSONS: CuratedLesson[] = [];

interface OverlayState {
  playbooks: Map<string, CuratedLesson[]>;
  removed: Map<string, CuratedLesson[]>;
  approvedDelta: number;
}

const state: OverlayState = {
  playbooks: new Map(),
  removed: new Map(),
  approvedDelta: 0,
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

function today(): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date());
}
function estimateTokens(text: string): number {
  // Rough, clearly-labelled estimate (~4 chars/token) — good enough for a
  // budget bar, never presented as an exact backend-computed figure.
  return Math.max(1, Math.round(text.length / 4));
}

// --- mutations ---------------------------------------------------------

export function addCuratedLesson(nodeId: string, text: string, fromObservationId?: string): CuratedLesson {
  const lesson: CuratedLesson = {
    id: `overlay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text,
    tokens: estimateTokens(text),
    fromObservationId,
    when: today(),
  };
  const list = state.playbooks.get(nodeId) ?? [];
  state.playbooks.set(nodeId, [...list, lesson]);
  emit();
  return lesson;
}

export function removeLesson(nodeId: string, lessonId: string): void {
  const list = state.playbooks.get(nodeId) ?? [];
  const target = list.find((l) => l.id === lessonId);
  if (!target) return;
  state.playbooks.set(
    nodeId,
    list.filter((l) => l.id !== lessonId),
  );
  const removed = state.removed.get(nodeId) ?? [];
  state.removed.set(nodeId, [...removed, target]);
  emit();
}

export function restoreLesson(nodeId: string, lessonId: string): void {
  const removed = state.removed.get(nodeId) ?? [];
  const target = removed.find((l) => l.id === lessonId);
  if (!target) return;
  state.removed.set(
    nodeId,
    removed.filter((l) => l.id !== lessonId),
  );
  const list = state.playbooks.get(nodeId) ?? [];
  state.playbooks.set(nodeId, [...list, target]);
  emit();
}

export function bumpApprovedExamples(): void {
  state.approvedDelta += 1;
  emit();
}

// --- snapshots -----------------------------------------------------------

export function getCuratedLessons(nodeId: string): CuratedLesson[] {
  return state.playbooks.get(nodeId) ?? EMPTY_LESSONS;
}
export function getRemovedLessons(nodeId: string): CuratedLesson[] {
  return state.removed.get(nodeId) ?? EMPTY_LESSONS;
}
export function getCuratedNodeIds(): string[] {
  return [...state.playbooks.entries()].filter(([, lessons]) => lessons.length > 0).map(([id]) => id);
}
export function getApprovedDelta(): number {
  return state.approvedDelta;
}

// --- hooks -----------------------------------------------------------------
// All three subscribe to the same version counter (simplest correct
// approach for a store this small — no per-key fan-out needed) and re-derive
// their own slice each time it bumps.

export function useCuratedLessons(nodeId: string): CuratedLesson[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getCuratedLessons(nodeId);
}
export function useRemovedLessons(nodeId: string): CuratedLesson[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getRemovedLessons(nodeId);
}
export function useCuratedNodeIds(): string[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getCuratedNodeIds();
}
export function useApprovedDelta(): number {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getApprovedDelta();
}
