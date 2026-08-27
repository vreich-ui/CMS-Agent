// U6 — the modal & layering system's shared vocabulary.
//
// Three layers, one rule-set:
//
//   popover — a glanceable READ. No commit, no form, dismissed by looking
//             away. Node quick-look in the rail and the runs grid.
//   modal   — a focused TASK with its own commit. The diff & merge studio,
//             start run, override output, a gate decision, a connection
//             test. Exactly one is open at a time.
//   route   — the five screens. Owned by store.screen, not by this module.
//
// Every modal is addressable. `?modal=diff&node=draft_writer&revA=…&revB=…`
// is a URL Wolf can bookmark, paste into a note, or reopen tomorrow and
// land on the same comparison. That is the whole point of routing overlays
// through one place rather than letting each screen own a boolean.

/** Every addressable modal. Adding one here is what makes it deep-linkable. */
export type ModalKind =
  | 'diff'      // U2 — diff & merge studio
  | 'override'  // U3 — drive mode: override a node's output
  | 'waterfall' // U5 — a run's trace waterfall
  | 'quicklook'; // U5 — node quick-look, promoted from popover to modal on small screens

export interface OverlayState {
  kind: ModalKind;
  /** Flat string params — they have to survive a round trip through the URL. */
  params: Record<string, string>;
}

export const MODAL_PARAM = 'modal';

/** Serializes overlay state into the query string, preserving unrelated params. */
export function overlayToSearch(overlay: OverlayState | null, current: string): string {
  const sp = new URLSearchParams(current);
  // Drop everything this module owns before writing the new state, so
  // closing one modal can't leave the previous one's params behind.
  for (const key of [...sp.keys()]) {
    if (key === MODAL_PARAM || key.startsWith('m.')) sp.delete(key);
  }
  if (overlay) {
    sp.set(MODAL_PARAM, overlay.kind);
    for (const [k, v] of Object.entries(overlay.params)) {
      if (v !== undefined && v !== null && v !== '') sp.set(`m.${k}`, v);
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const KINDS: ReadonlySet<string> = new Set<ModalKind>(['diff', 'override', 'waterfall', 'quicklook']);

/** Reads overlay state back out of a query string. Unknown kinds are ignored, never thrown. */
export function overlayFromSearch(search: string): OverlayState | null {
  const sp = new URLSearchParams(search);
  const kind = sp.get(MODAL_PARAM);
  if (!kind || !KINDS.has(kind)) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of sp.entries()) {
    if (k.startsWith('m.')) params[k.slice(2)] = v;
  }
  return { kind: kind as ModalKind, params };
}

/** Stable identity for one overlay instance — the key drafts are held under. */
export function overlayKey(overlay: OverlayState): string {
  const parts = Object.entries(overlay.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return [overlay.kind, ...parts].join('|');
}
