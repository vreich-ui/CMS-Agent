// WP-21 — the real confirmation modal for every mutating verb. Replaces
// api/confirmAction.ts's window.confirm() stub: App.tsx calls
// setConfirmHandler(requestConfirm) once at module load, so every call to
// confirmAction() anywhere in the app (Dock, ThisRunTab, StartRunModal, and
// any later WP) renders through this one component instead of a native
// dialog. Markup reuses the mockup's `.scrim`/`.modal`/`.foot` classes — no
// new CSS.
//
// Non-negotiables from the WP brief (HANDOFF §5/§7.3): name the verb, state
// its effect in plain language, danger actions get `.btn.danger` and do NOT
// default-focus the confirm button, Escape/scrim cancel, focus returns to
// the trigger.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ConfirmOptions } from '../api/confirmAction';

interface PendingConfirm {
  id: number;
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
  trigger: HTMLElement | null;
}

let pending: PendingConfirm | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot() {
  return pending;
}

/** a11y C4 — App.tsx needs to know whether the confirm dialog is currently
 * showing (its own state is module-external, not in the zustand store) so
 * it can fold it into the same "an overlay is open" boolean that drives
 * `inert` on the rest of the page. */
export function useConfirmPending(): boolean {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return state !== null;
}

// Every mutating handler in Dock.tsx/ThisRunTab.tsx/StartRunModal.tsx calls
// this with e.currentTarget as the FIRST thing it does, before any state
// change — critically, before the button it was clicked from can become
// `disabled` (which several of these handlers do immediately, to prevent a
// second click while the mutation is in flight). A disabled button
// auto-blurs in every browser, so by the time confirmAction actually shows
// this dialog, document.activeElement is no longer reliable — it's often
// already <body>. This side channel captures the real trigger before that
// happens; requestConfirm falls back to document.activeElement only if a
// caller forgets to set one.
let nextTrigger: HTMLElement | null = null;
export function setNextConfirmTrigger(el: HTMLElement | null): void {
  nextTrigger = el;
}

/** The ConfirmHandler App.tsx registers via setConfirmHandler — resolves once the operator confirms, cancels, hits Escape, or clicks the scrim. */
export function requestConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    pending = { id: nextId++, opts, resolve, trigger: nextTrigger ?? (document.activeElement as HTMLElement | null) };
    nextTrigger = null;
    emit();
  });
}

function settle(ok: boolean) {
  if (!pending) return;
  const current = pending;
  pending = null;
  emit();
  current.resolve(ok);
}

// Nicer dialog titles than a raw verb string — falls back to a humanized
// version of the verb for anything not listed (future verbs stay legible
// without needing an edit here).
const VERB_TITLES: Record<string, string> = {
  workflow_pause_run: 'Pause run',
  workflow_resume_run: 'Resume run',
  workflow_cancel_run: 'Cancel run',
  workflow_reset_run: 'Reset run',
  workflow_retry_node: 'Retry node',
  workflow_run_next_node: 'Run next node',
  workflow_run_until: 'Run until…',
  workflow_start_dry_run: 'Start run',
  workflow_set_operator_publish_decision: 'Record publish decision',
  workflow_publish_run: 'Publish run',
};

function titleForVerb(verb: string): string {
  const known = VERB_TITLES[verb];
  if (known) return known;
  const words = verb.replace(/^workflow_/, '').split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function ConfirmDialog() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const triggerRef = useRef<HTMLElement | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state) {
      triggerRef.current = state.trigger;
      // Destructive actions never default-focus Confirm (HANDOFF §5.2) — land
      // on Cancel instead so a stray Enter keypress can't fire the mutation.
      const toFocus = state.opts.danger ? cancelRef.current : confirmRef.current;
      toFocus?.focus();
    } else {
      // Focus returns to the trigger (HANDOFF §7.3). This only works if the
      // trigger is not itself `disabled` right now — see setNextConfirmTrigger's
      // doc comment above: callers must not disable the trigger element while
      // this dialog is open, or the browser silently drops this focus() call.
      triggerRef.current?.focus?.();
      triggerRef.current = null;
    }
  }, [state]);

  if (!state) return null;
  const { verb, effect, danger } = state.opts;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      settle(false);
      return;
    }
    // Two-element focus trap: Cancel <-> Confirm.
    if (e.key === 'Tab') {
      e.preventDefault();
      const goingToConfirm = e.shiftKey
        ? document.activeElement === confirmRef.current
        : document.activeElement === cancelRef.current;
      (goingToConfirm ? confirmRef.current : cancelRef.current)?.focus();
    }
  }

  return (
    <div
      className="scrim open"
      ref={scrimRef}
      onMouseDown={(e) => {
        if (e.target === scrimRef.current) settle(false);
      }}
    >
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmdialog-title"
        onKeyDown={onKeyDown}
      >
        <h3 id="confirmdialog-title">{titleForVerb(verb)}</h3>
        <div className="sub mono">{verb}</div>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{effect}</p>
        <div className="foot">
          <span />
          <span>
            <button className="btn" ref={cancelRef} onClick={() => settle(false)}>
              Cancel
            </button>
            <button
              className={`btn ${danger ? 'danger' : 'pri'}`}
              ref={confirmRef}
              onClick={() => settle(true)}
              style={{ marginLeft: 8 }}
            >
              {danger ? 'Confirm — cannot be undone' : 'Confirm'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
