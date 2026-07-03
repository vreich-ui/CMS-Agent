export type AccessSessionState = {
  loading: boolean;
  authenticated: boolean;
  authorized: boolean;
  email?: string;
  error?: string;
  accessToken?: string;
};

export type AccessScreen =
  | { kind: "checking"; title: "Checking session…"; detail: string }
  | { kind: "verifying"; title: "Login complete, verifying access…"; detail: string }
  | { kind: "login"; eyebrow: "CMS-Agent"; title: "Workspace login required"; button: "Log in with Google"; error?: string }
  | { kind: "unauthorized"; title: "Not authorized"; email?: string; error?: string }
  | { kind: "workspace" };

export function getAccessScreen(isDeployedMode: boolean, session: AccessSessionState): AccessScreen {
  if (!isDeployedMode) return { kind: "workspace" };

  if (session.loading && session.authenticated) {
    return { kind: "verifying", title: "Login complete, verifying access…", detail: "Checking whether this account can access the workspace." };
  }

  if (session.loading) {
    return { kind: "checking", title: "Checking session…", detail: "Checking for an existing Netlify Identity session." };
  }

  if (!session.authenticated) {
    return { kind: "login", eyebrow: "CMS-Agent", title: "Workspace login required", button: "Log in with Google", error: session.error };
  }

  if (!session.authorized) {
    return { kind: "unauthorized", title: "Not authorized", email: session.email, error: session.error };
  }

  return { kind: "workspace" };
}
