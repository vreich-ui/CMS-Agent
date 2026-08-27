// U6 — "every modal is dismissible with Escape without losing typed work".
//
// A modal that throws away an edit when you press Escape teaches you not to
// press Escape, and then you stop dismissing modals at all. So: whatever a
// modal was holding when it closed stays in memory, keyed by that exact
// modal instance (kind + params), and is handed back if the same one
// reopens. Memory only — deliberately not persisted, because a draft that
// outlives the tab would be a second, invisible source of truth for a
// prompt.
//
// Cleared explicitly on commit (the edit became a revision — there is
// nothing left to restore) and never automatically, so "I closed that by
// accident" is always recoverable within the session.

const drafts = new Map<string, unknown>();

export function saveDraft(key: string, value: unknown): void {
  drafts.set(key, value);
}

export function readDraft<T>(key: string): T | undefined {
  return drafts.get(key) as T | undefined;
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

/** Test-only. */
export function __clearAllDrafts(): void {
  drafts.clear();
}
