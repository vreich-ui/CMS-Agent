// U6 — keeps `store.overlay` and the address bar the same fact.
//
// Opening a modal pushes a history entry, so Back closes it — which is what
// every browser user's hands already expect, and what makes "open the diff
// for these two revisions" a thing Wolf can bookmark or paste into a note
// and land on tomorrow. Closing replaces rather than pushes, so dismissing
// a modal doesn't leave a dead entry you have to press Back twice through.

import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { overlayFromSearch, overlayToSearch } from './types';

export function useOverlayUrl(): void {
  const overlay = useStore((s) => s.overlay);
  const syncModalFromUrl = useStore((s) => s.syncModalFromUrl);
  const lastWritten = useRef<string | null>(null);
  const hydrated = useRef(false);

  // Address bar -> store, on first paint and on Back/Forward.
  useEffect(() => {
    function apply() {
      const next = overlayFromSearch(window.location.search);
      lastWritten.current = overlayToSearch(next, window.location.search);
      syncModalFromUrl(next);
    }
    if (!hydrated.current) {
      hydrated.current = true;
      apply();
    }
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, [syncModalFromUrl]);

  // Store -> address bar.
  useEffect(() => {
    if (!hydrated.current) return;
    const search = overlayToSearch(overlay, window.location.search);
    if (search === lastWritten.current) return;
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (overlay) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    lastWritten.current = search;
  }, [overlay]);
}
