// U4 — shared "since your last visit" tracking for the Learning → Activity
// feed, plus local (non-store) subtab routing so index.tsx can add an
// "Activity" subtab without touching the app-wide LearnTab union
// (src/types.ts — out of scope for this WP) or the global zustand store
// (src/store.ts — same). Mirrors the useSyncExternalStore module-store
// pattern overlay.ts already established in this folder: no zustand, no new
// dependency, just a tiny external store this folder's own components share.
//
// LAST_VISIT_KEY is DELIBERATELY the exact same key
// src/screens/Workbench/Rail.tsx already reads/writes (read-only for this
// WP — see its own comment above LAST_VISIT_KEY there). Sharing the key —
// not just the shape of the logic — is what keeps "since your last visit"
// meaning the same instant on both surfaces: visiting either one updates
// the one clock the other reads, so the rail's per-node "learned" badge and
// this feed's "new" marking can never disagree about the boundary. try/catch
// around every access follows the pattern store.ts's theme persistence
// established (THEME_KEY) and Rail.tsx repeats for this same key.

import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { changesListEvents } from '../../api/verbs';
import type { LearnTab } from '../../types';

export const LAST_VISIT_KEY = 'cw-rail-lastvisit';

export function readLastVisit(): number {
  try {
    const v = localStorage.getItem(LAST_VISIT_KEY);
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function writeLastVisit(ts: number): void {
  try {
    localStorage.setItem(LAST_VISIT_KEY, String(ts));
  } catch {
    // ignore — storage unavailable (private window, blocked site data, ...)
  }
}

// --- local subtab routing: the "act" pseudo-tab -----------------------------
//
// The store's `lrn` field stays exactly the 7-value LearnTab union it always
// was (other WPs' code calls `setLearn(...)` expecting those 7 values and
// nothing else). This adds an 8th, LOCAL-only tab that layers on top of it:
// index.tsx shows Activity whenever this flag is set, and falls back to the
// store's own `lrn` otherwise — so every existing call site that navigates
// via the store (Flywheel's `go()`, deep links, etc.) keeps working exactly
// as before.

export type LrnTabExt = LearnTab | 'act';

let activityOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot(): boolean {
  return activityOpen;
}

export function openActivity(): void {
  if (!activityOpen) {
    activityOpen = true;
    emit();
  }
}
export function closeActivity(): void {
  if (activityOpen) {
    activityOpen = false;
    emit();
  }
}
export function useActivityOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// --- unseen-count baseline --------------------------------------------------
//
// One shared, unfiltered, most-recent-N read backs three consumers: the
// Activity subtab's own "new" row marking, the small numeral badge on that
// subtab's label, and Flywheel's "recent activity" preview column — all via
// the same react-query cache entry (same key => one network call, not
// three). Read-only; never writes the visit timestamp itself (only
// Activity.tsx's own mount does that — see its "marking a visit" note) so
// merely rendering the badge elsewhere in the app never clears it.

export const ACTIVITY_BASELINE_LIMIT = 200;

export function activityBaselineQueryKey(): unknown[] {
  return ['changes', 'activity-baseline', ACTIVITY_BASELINE_LIMIT];
}

export function useActivityBaseline() {
  return useQuery({
    queryKey: activityBaselineQueryKey(),
    queryFn: () => changesListEvents({ limit: ACTIVITY_BASELINE_LIMIT }),
    staleTime: 30_000,
  });
}

/**
 * Count of events newer than the last recorded visit. `null` while loading
 * or on a failed baseline fetch — deliberately not `0`, so a broken verb
 * never reads as "nothing new" on the tab label (same "degrade to nothing
 * visible, never to a false all-clear" rule AttentionStrip.tsx and Rail.tsx
 * already follow for their own chips).
 */
export function useUnseenActivityCount(): number | null {
  const q = useActivityBaseline();
  if (!q.data) return null;
  const lastVisit = readLastVisit();
  let count = 0;
  for (const e of q.data.events) {
    const ts = Date.parse(e.createdAt);
    if (Number.isFinite(ts) && ts > lastVisit) count += 1;
  }
  return count;
}
