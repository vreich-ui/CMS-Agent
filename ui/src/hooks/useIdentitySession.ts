import { useCallback, useEffect, useMemo, useState } from "react";
import type { IdentityUser } from "../types/identity";

export type SessionState = {
  loading: boolean;
  authenticated: boolean;
  authorized: boolean;
  email?: string;
  error?: string;
  accessToken?: string;
};

const unauthenticated: SessionState = { loading: false, authenticated: false, authorized: false };

const getAccessToken = (user: IdentityUser | null) => user?.token?.access_token;

async function fetchSession(accessToken: string): Promise<SessionState> {
  const response = await fetch("/api/session", { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) return unauthenticated;
  return {
    loading: false,
    authenticated: Boolean(payload.authenticated),
    authorized: Boolean(payload.authorized),
    email: typeof payload.email === "string" ? payload.email : undefined,
    error: response.ok ? undefined : payload.error?.message ?? `Session check failed with HTTP ${response.status}.`,
    accessToken
  };
}

export function useIdentitySession(enabled: boolean) {
  const [state, setState] = useState<SessionState>(enabled ? { ...unauthenticated, loading: true } : { ...unauthenticated });

  const refresh = useCallback(async (user: IdentityUser | null = window.netlifyIdentity?.currentUser() ?? null) => {
    if (!enabled) return;
    const accessToken = getAccessToken(user);
    if (!accessToken) {
      setState(unauthenticated);
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    setState(await fetchSession(accessToken));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const identity = window.netlifyIdentity;
    if (!identity) {
      setState({ ...unauthenticated, error: "Netlify Identity widget is not loaded." });
      return;
    }
    identity.on("init", (user) => void refresh(user ?? null));
    identity.on("login", (user) => void refresh(user ?? null));
    identity.on("logout", () => setState(unauthenticated));
    identity.init();
    void refresh(identity.currentUser());
  }, [enabled, refresh]);

  const actions = useMemo(() => ({
    login: () => window.netlifyIdentity?.open("login"),
    logout: () => window.netlifyIdentity?.logout(),
    refresh
  }), [refresh]);

  return { session: state, ...actions };
}
