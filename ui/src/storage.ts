// Safe localStorage access: private-mode/storage-denied browsers throw on any access, and UI
// preferences must degrade to in-memory defaults instead of crashing the shell.

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Preferences simply don't persist when storage is unavailable.
  }
}
