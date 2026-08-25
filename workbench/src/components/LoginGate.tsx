// WP-44 — the operator login/session UI, later repointed from a broker
// password session to the Cloud Run MCP transport's bearer token
// (workbench-cloudrun). The broker (server/) path still authenticates with
// a single operator password and issues an httpOnly session cookie; the
// Cloud Run transport instead holds a manually entered MCP bearer token —
// either way this SPA never holds a secret longer than it has to, and the
// two states surface identically as `SessionInfo` (see api/client.ts's doc
// comment). This file owns:
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
//     `getSession()` on mount and renders a credential screen instead of the
//     app until authenticated — a password form for the broker transport, or
//     a bearer-token entry panel for the Cloud Run transport (see
//     `TokenEntryGate` below).
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
import { AuthError, IS_CLOUD_RUN_TRANSPORT, IS_MOCK, IS_READ_ONLY, getSession, login, logout, type SessionInfo } from '../api/client';

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
 * The Cloud Run transport's unauthenticated screen: collects an MCP bearer
 * token instead of an operator password or an Identity sign-in — Cloud Run
 * is the sole control plane and always uses direct bearer-token auth (see
 * client.ts's Cloud Run MCP transport section and ui/src/connection.ts's
 * header comment). Deliberately NOT OAuth and NOT a new auth system: this is
 * parity with ui/'s own connection model — a free-text credential the
 * operator pastes in, held client-side, sent as `Authorization: Bearer
 * <token>` on every request.
 *
 * The token itself never appears anywhere but this field's own (write-only)
 * state: not logged, not rendered back, and (per client.ts's persistence
 * rule, mirroring ui/App.tsx exactly) only written to localStorage outside
 * deployed mode. Errors surfaced here already pass through client.ts's
 * `redactSecretText`, so even a server response that echoes a header back
 * can't leak the token into this panel's own error text.
 */
function TokenEntryGate({ notice }: { notice: string | null }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    // Read then clear immediately — the field is write-only, same rule as
    // the broker LoginForm's password field below.
    const value = token;
    setToken('');
    setSubmitting(true);
    setError(null);
    try {
      await submitLogin(value);
      queryClient.clear(); // nothing fetched pre-auth is trustworthy to keep
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Could not reach the Cloud Run MCP endpoint. Try again.');
    } finally {
      setSubmitting(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="scrim open" style={{ position: 'fixed', background: 'var(--bg)', paddingTop: '18vh' }}>
      <form className="modal" onSubmit={handleSubmit} aria-labelledby="logingate-title">
        <div className="wordmark" style={{ marginBottom: 4 }}>
          Conductor
          <small>agent workspace</small>
        </div>
        <h3 id="logingate-title" style={{ marginTop: 10 }}>
          Workspace MCP bearer token required
        </h3>
        <div className="sub">
          This console talks directly to the live Cloud Run workspace control plane. Paste the workspace MCP bearer
          token to continue — it is sent only as an <code>Authorization</code> header on each request and is never
          logged or displayed back.
        </div>

        {notice && (
          <p className="note" style={{ color: 'var(--acc)' }}>
            {notice}
          </p>
        )}

        <div className="field">
          <label className="lbl" htmlFor="lg-token">
            mcp bearer token
          </label>
          <input
            id="lg-token"
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={submitting}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'lg-token-error' : undefined}
          />
        </div>

        {error && (
          <p id="lg-token-error" role="alert" className="note" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}

        <div className="foot">
          <span />
          <button className="btn pri" type="submit" disabled={submitting || token.trim().length === 0}>
            {submitting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
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
    // The Cloud Run transport's "session" is purely local (see
    // client.ts's getSessionCloudRun): whether a bearer token is already
    // set, either freshly entered this page load or (outside deployed mode
    // only) restored from localStorage. No network round trip needed to
    // know that — the first real tool call is what actually proves the
    // token, surfacing a precise 401/403 via AuthError if it's wrong.
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
  return IS_CLOUD_RUN_TRANSPORT ? <TokenEntryGate notice={auth.notice} /> : <LoginForm notice={auth.notice} />;
}
