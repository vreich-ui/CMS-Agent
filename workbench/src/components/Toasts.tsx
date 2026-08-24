import { useSyncExternalStore } from 'react';

interface ToastItem {
  id: number;
  title: string;
  body?: string;
}

let nextId = 1;
let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return toasts;
}

/** Push a toast. Any module can call this directly — no hook required. */
export function toast(title: string, body?: string) {
  const id = nextId++;
  toasts = [...toasts, { id, title, body }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 3800);
}

/** Convenience hook so components can grab `toast` without a separate import. */
export function useToast() {
  return toast;
}

export function Toasts() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    // a11y C1: every mutation outcome in the app surfaces only through this
    // one toast container — without role/aria-live it was completely silent
    // to assistive tech. "polite" (not "assertive") so a toast never
    // interrupts whatever the screen reader is already reading.
    <div id="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div className="toast" key={t.id}>
          <div>{t.title}</div>
          {t.body !== undefined && <div className="mono">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}
