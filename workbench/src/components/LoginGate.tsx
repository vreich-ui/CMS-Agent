// WP-44 — the operator login/session UI. The broker (server/) authenticates
// with a single operator password and issues an httpOnly session cookie;
// this SPA never holds a secret, only ever a `SessionInfo` (see
// api/client.ts's doc comment on the broker contract). This file owns:
//
//   - a tiny external store (module state + useSyncExternalStore, the same
//     pattern ConfirmDialog.tsx/confirmAction.ts already use for the confirm
//     dialog) so TopBar.tsx and CommandPalette.tsx can read/act on session
//     state without prop-drilling and without adding session data to the
//     zustand store (store.ts's WP additions are scoped to open/closed UI
//     state only — see its doc comments).
//   - `LoginGate`, mounted once in App.tsx around the whole app: in fixture
//     mode (IS_MOCK) it renders children immediately, full stop — the app
//     must stay demonstrable with no broker running. Otherwise it checks
//     `getSession()` on mount and renders a password screen instead of the
//     app until authenticated.
//   - `reportAuthExpired`, wired into App.tsx's QueryClient (QueryCache /
//     MutationCache `onError`) so a 401/AuthError from *any* verb call, at
//     any point in the app, brings this gate back with an explanation
//     instead of leaving the operator on a broken screen.
//   - `performLogout`, called from TopBar's account menu and the command
//     palette's "Log out" action.

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthError, IS_MOCK, IS_NETLIFY_TRANSPORT, IS_READ_ONLY, getSession, login, logout, type SessionInfo } from '../api/client';

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

export interface AuthSnapshot {
  status: AuthStatus;
  operator: string | null;
  readOnly: boolean;
  /** Explanation to show on the gate — a login failure, a rate-limit
   * message, or "your session expired" after a mid-session 401. Null in the
   * ordinary "just haven't logged in yet" case. */
  notice: string | null;
}

const initial: AuthSnapshot = IS_MOCK
  ? { status: 'authenticated', operator: 'mock-operator', readOnly: IS_READ_ONLY, notice: null }
  : { status: 'checking', operator: null, readOnly: true, notice: null };

let state: AuthSnapshot = initial;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot(): AuthSnapshot {
  return state;
}
function setState(patch: Partial<AuthSnapshot>): void {
  state = { ...state, ...patch };
  emit();
}

/** Read the current auth snapshot outside of React (mirrors store.getState() elsewhere in this app). */
export function getAuthSnapshot(): AuthSnapshot {
  return state;
}

/** Subscribes to auth-state changes. TopBar/CommandPalette use `useAuthState()` below instead; this is exported for symmetry and for non-React callers. */
export { subscribe as subscribeAuth };

/** React hook mirroring `useStore`'s shape, for TopBar.tsx and CommandPalette.tsx. */
export function useAuthState(): AuthSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

let checkStarted = false;

/** Runs once per page load (guarded) — LoginGate's mount effect calls this. Exported so a re-check can be forced after a forced-unauthenticated test state, if ever needed. */
export async function checkSession(): Promise<void> {
  if (IS_MOCK) return;
  try {
    const s: SessionInfo = await getSession();
    setState(
      s.authenticated
        ? { status: 'authenticated', operator: s.operator ?? 'operator', readOnly: s.readOnly, notice: null }
        : { status: 'unauthenticated', operator: null, readOnly: s.readOnly, notice: null },
    );
  } catch {
    // A network failure here reads the same as "not logged in" — the login
    // screen's own submit will surface a sharper error if the broker is
    // actually unreachable.
    setState({ status: 'unauthenticated', operator: null, notice: null });
  }
}

/**
 * Called from App.tsx's QueryClient (QueryCache/MutationCache `onError`)
 * whenever any verb call anywhere in the app throws AuthError — the broker
 * contract's own signal that the session cookie expired or was revoked.
 * Never called in fixture mode (nothing ever throws AuthError there).
 */
export function reportAuthExpired(message: string): void {
  if (IS_MOCK) return;
  setState({ status: 'unauthenticated', operator: null, notice: message });
}

/** Submits the password field. Throws on failure (AuthError, generic message or rate-limited — both already carry the broker's own text, see client.ts's login()); the caller (the login form below) is responsible for display. Never resolves with, stores, or logs the password itself. */
export async function submitLogin(password: string): Promise<void> {
  const s = await login(password);
  setState({ status: 'authenticated', operator: s.operator ?? 'operator', readOnly: s.readOnly, notice: null });
}

/** TopBar's "Log out" and the palette's "Log out" action both call this. No-op in fixture mode — there is no real session to end. */
export async function performLogout(clearCache?: () => void): Promise<void> {
  if (IS_MOCK) return;
  await logout();
  setState({ status: 'unauthenticated', operator: null, notice: null });
  clearCache?.();
}

// --- test-only escape hatches -------------------------------------------
// Playwright's tests/auth.spec.ts drives these directly (dynamic
// `import('/src/components/LoginGate.tsx')`, exactly like
// tests/runcontrol.spec.ts already does against store.ts) rather than
// toggling VITE_MOCK/VITE_API_BASE — the whole suite runs against one
// shared `npm run dev` process (see playwright.config.ts), and IS_MOCK is
// fixed for that process's lifetime, so there is no way to make a *real*
// unauthenticated/expired broker response happen from inside a test. These
// stub exactly the two states a real broker would produce; they never
// touch the network and are meant to be called only from tests.
export function __test_setUnauthenticated(notice: string | null = null): void {
  setState({ status: 'unauthenticated', operator: null, notice });
}
export function __test_reset(): void {
  state = IS_MOCK
    ? { status: 'authenticated', operator: 'mock-operator', readOnly: IS_READ_ONLY, notice: null }
    : { status: 'unauthenticated', operator: null, readOnly: true, notice: null };
  emit();
}

function LoadingScreen() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        color: 'var(--muted)',
        fontFamily: 'var(--sans)',
        fontSize: 13,
      }}
    >
      Checking session…
    </div>
  );
}

/**
 * The Netlify-transport unauthenticated screen: opens the Netlify Identity
 * widget instead of collecting a password. Reuses `submitLogin` (an empty
 * string is passed and never read — see client.ts's `login()` netlify
 * branch) so this shares the same authenticated-state transition as the
 * password form below, rather than duplicating it.
 */
function IdentitySignIn({ notice }: { notice: string | null }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSignIn(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitLogin('');
      queryClient.clear(); // nothing fetched pre-auth is trustworthy to keep
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Could not complete Netlify Identity sign-in. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="scrim open" style={{ position: 'fixed', background: 'var(--bg)', paddingTop: '18vh' }}>
      <div className="modal" aria-labelledby="logingate-title">
        <div className="wordmark" style={{ marginBottom: 4 }}>
          Conductor
          <small>agent workspace</small>
        </div>
        <h3 id="logingate-title" style={{ marginTop: 10 }}>
          Sign in
        </h3>
        <div className="sub">
          This console controls a real workspace. Sign in with Netlify Identity to continue — the workspace token
          never leaves the server.
        </div>

        {notice && (
          <p className="note" style={{ color: 'var(--acc)' }}>
            {notice}
          </p>
        )}

        {error && (
          <p role="alert" className="note" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}

        <div className="foot">
          <span />
          <button className="btn pri" type="button" onClick={() => void handleSignIn()} disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginForm({ notice }: { notice: string | null }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    // Read then clear immediately — the field is write-only. The value
    // never lives anywhere else (no state variable outlives this call, no
    // console.log, no localStorage) — see this file's header comment and
    // WP-44's "never store, log, or display a password" rule.
    const pw = password;
    setPassword('');
    setSubmitting(true);
    setError(null);
    try {
      await submitLogin(pw);
      queryClient.clear(); // nothing fetched pre-auth is trustworthy to keep
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Could not reach the broker. Try again.');
    } finally {
      setSubmitting(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div
      className="scrim open"
      style={{ position: 'fixed', background: 'var(--bg)', paddingTop: '18vh' }}
    >
      <form className="modal" onSubmit={handleSubmit} aria-labelledby="logingate-title">
        <div className="wordmark" style={{ marginBottom: 4 }}>
          Conductor
          <small>agent workspace</small>
        </div>
        <h3 id="logingate-title" style={{ marginTop: 10 }}>
          Sign in
        </h3>
        <div className="sub">This console controls a real workspace. The broker holds the secret — you never will.</div>

        {notice && (
          <p className="note" style={{ color: 'var(--acc)' }}>
            {notice}
          </p>
        )}

        <div className="field">
          <label className="lbl" htmlFor="lg-password">
            password
          </label>
          <input
            id="lg-password"
            ref={inputRef}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'lg-error' : undefined}
          />
        </div>

        {error && (
          // a11y M7 — on a failed login, focus returns to this (unchanged)
          // input; refocusing the same element doesn't by itself cause most
          // screen readers to read newly-appeared sibling content, so the
          // error needs its own live announcement.
          <p id="lg-error" role="alert" className="note" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}

        <div className="foot">
          <span />
          <button className="btn pri" type="submit" disabled={submitting || password.length === 0}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function LoginGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();

  useEffect(() => {
    if (IS_MOCK || checkStarted) return;
    checkStarted = true;
    if (IS_NETLIFY_TRANSPORT) {
      // Mirrors ui/src/hooks/useIdentitySession.ts: the widget script tracks
      // whether a Netlify Identity session already exists (from a previous
      // visit), so init() runs once before the initial checkSession() below
      // can see it, and a 'logout' fired from the widget's own UI (not just
      // TopBar's "Log out") brings the gate back too. A missing widget
      // (script blocked or offline) degrades to an explained unauthenticated
      // state rather than an unhandled crash — fixture-mode dev never
      // reaches this branch at all.
      const identity = window.netlifyIdentity;
      if (!identity) {
        setState({ status: 'unauthenticated', operator: null, notice: 'Netlify Identity widget is not loaded.' });
        return;
      }
      identity.on('logout', () => setState({ status: 'unauthenticated', operator: null, notice: null }));
      identity.init();
    }
    void checkSession();
  }, []);

  // No separate IS_MOCK branch here: fixture mode's `initial` snapshot above
  // is already `authenticated` and nothing in fixture mode ever changes
  // it (checkSession() no-ops under IS_MOCK) — so this one check already
  // skips the gate for real fixture-mode use. Keeping it as the *only*
  // check (rather than short-circuiting on IS_MOCK first) is what lets
  // tests/auth.spec.ts's test-only `__test_setUnauthenticated` actually
  // render the login screen to exercise it.
  if (auth.status === 'authenticated') return <>{children}</>;
  if (auth.status === 'checking') return <LoadingScreen />;
  return IS_NETLIFY_TRANSPORT ? <IdentitySignIn notice={auth.notice} /> : <LoginForm notice={auth.notice} />;
}
