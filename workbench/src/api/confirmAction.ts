// The single gate every mutating verb goes through. Read verbs (and the two
// read-shaped validation calls, `node_validate_input` / `workspace_validate_node`)
// never pass through here — they call `callVerb` directly from verbs.ts.

import {
  __beginConfirmedCall,
  __endConfirmedCall,
  IS_MOCK,
  IS_READ_ONLY,
  MUTATING_VERBS,
  ReadOnlyError,
} from './client';

export { MUTATING_VERBS };

export interface ConfirmOptions {
  /** The MCP verb this confirmation gates, e.g. "workflow_cancel_run". */
  verb: string;
  /** Human-readable statement of what will happen — shown in the confirm UI. */
  effect: string;
  /** True for irreversible/high-stakes actions (publish, cancel, promote). */
  danger?: boolean;
}

export type ConfirmHandler = (opts: ConfirmOptions) => boolean | Promise<boolean>;

/** Thrown when the operator declines the confirmation prompt. */
export class ActionCancelledError extends Error {
  readonly verb: string;
  constructor(verb: string) {
    super(`"${verb}" was cancelled by the operator.`);
    this.name = 'ActionCancelledError';
    this.verb = verb;
  }
}

function defaultConfirmHandler(opts: ConfirmOptions): boolean {
  // Mock mode: let fixture-driven flows (including automated smoke tests)
  // proceed without a real dialog. A later WP (WP-21) injects the actual UI
  // via setConfirmHandler for both mock and live mode.
  if (IS_MOCK) return true;
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    const danger = opts.danger ? '\n\nThis action cannot be undone.' : '';
    return window.confirm(`${opts.verb}\n\n${opts.effect}${danger}`);
  }
  return false;
}

let confirmHandler: ConfirmHandler = defaultConfirmHandler;

/** WP-21 calls this to swap in the real confirmation modal. */
export function setConfirmHandler(handler: ConfirmHandler): void {
  confirmHandler = handler;
}

/** Restores the default handler — mainly for tests. */
export function resetConfirmHandler(): void {
  confirmHandler = defaultConfirmHandler;
}

/**
 * Wraps a mutating verb call: refuses outright in read-only mode, otherwise
 * resolves a confirmation before invoking `fn` (which should call `callVerb`
 * for the named verb). Every exported mutating function in verbs.ts is built
 * on this — never call `callVerb` directly for a verb in `MUTATING_VERBS`.
 */
export async function confirmAction<T>(opts: ConfirmOptions, fn: () => Promise<T>): Promise<T> {
  if (IS_READ_ONLY) {
    // U7 polish — this used to pass its own developer-facing message
    // (naming VITE_READ_ONLY), which shadowed ReadOnlyError's own P2-06
    // operator-copy default in client.ts. Passing nothing lets that good
    // default through instead.
    throw new ReadOnlyError(opts.verb);
  }

  const ok = await confirmHandler(opts);
  if (!ok) {
    throw new ActionCancelledError(opts.verb);
  }

  __beginConfirmedCall();
  try {
    return await fn();
  } finally {
    __endConfirmedCall();
  }
}
