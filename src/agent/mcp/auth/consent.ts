// Human approval step for the authorization endpoint.
//
// This is the page the browser lands on when Claude opens the authorization URL. Previously the
// SPA catch-all served the workspace dashboard here — a dead end with no way to hand a code back
// to the connector. Instead we render a tiny, self-contained consent screen: whoever holds the
// workspace approval secret (a human) confirms, and the loop closes with a redirect carrying the
// authorization code. No Netlify Identity widget or third-party script is required.

import { timingSafeEqual } from "node:crypto";
import type { WorkspaceActor } from "../../workspace/changeTypes.js";
import type { ValidatedAuthorizationRequest } from "./oauthService.js";

// The approval secret gates who may authorize a connector. A dedicated secret is preferred; we
// fall back to MCP_API_TOKEN so a minimally-configured deployment still works, and document that.
export const resolveApprovalSecret = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const dedicated = env.MCP_OAUTH_APPROVAL_SECRET?.trim();
  if (dedicated) return dedicated;
  const fallback = env.MCP_API_TOKEN?.trim();
  return fallback || undefined;
};

export const verifyApproval = (provided: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean => {
  const secret = resolveApprovalSecret(env);
  if (!secret || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

// A token minted through this flow represents the OAuth client (Claude) acting under a human's
// authorization. The honest attribution for the tools it then calls is an agent actor labelled by
// the client — consistent with the "direct MCP → agent" default elsewhere.
export const actorForApproval = (request: ValidatedAuthorizationRequest): WorkspaceActor => ({
  kind: "agent",
  label: request.clientName ? `${request.clientName} (oauth)` : "mcp-oauth-client"
});

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const hiddenField = (name: string, value: string | undefined): string =>
  value === undefined ? "" : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b0d10; color: #e7e9ee; }
  main { width: min(440px, 92vw); background: #14181d; border: 1px solid #262c33; border-radius: 14px; padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { margin: 8px 0; color: #aab2bd; }
  dl { margin: 18px 0; padding: 14px; background: #0e1216; border-radius: 10px; border: 1px solid #222831; }
  dt { color: #7d8794; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  dd { margin: 2px 0 12px; word-break: break-all; }
  dd:last-child { margin-bottom: 0; }
  label { display: block; margin: 18px 0 6px; font-weight: 600; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 9px; border: 1px solid #2b333c; background: #0b0e12; color: inherit; font-size: 15px; }
  button { margin-top: 18px; width: 100%; padding: 11px; border: 0; border-radius: 9px; background: #3b82f6; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2f6fe0; }
  .err { color: #ff8f8f; margin-top: 14px; }
  .muted { color: #6b7480; font-size: 12px; margin-top: 18px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export const renderConsentPage = (
  request: ValidatedAuthorizationRequest,
  options: { actionPath: string; error?: string; secretConfigured: boolean }
): string => {
  const rawParams: Record<string, string | undefined> = {
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    scope: request.scope,
    state: request.state,
    resource: request.resource
  };
  const hidden = Object.entries(rawParams).map(([name, value]) => hiddenField(name, value)).join("\n");
  const clientLabel = request.clientName ? escapeHtml(request.clientName) : "An MCP client";
  const notConfigured = options.secretConfigured
    ? ""
    : `<p class="err">No approval secret is configured on this deployment (set MCP_OAUTH_APPROVAL_SECRET). Authorization cannot be granted until it is set.</p>`;
  const error = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : "";
  return page("Authorize MCP connection", `
    <h1>Authorize workspace access</h1>
    <p><strong>${clientLabel}</strong> is requesting permission to program this CMS Agent workspace over MCP.</p>
    <dl>
      <dt>Client</dt><dd>${clientLabel}</dd>
      <dt>Scope</dt><dd>${escapeHtml(request.scope)}</dd>
      <dt>Redirect</dt><dd>${escapeHtml(request.redirectUri)}</dd>
    </dl>
    <form method="POST" action="${escapeHtml(options.actionPath)}">
      ${hidden}
      <label for="approval">Workspace approval secret</label>
      <input id="approval" name="approval" type="password" autocomplete="off" autofocus ${options.secretConfigured ? "" : "disabled"} />
      ${notConfigured}
      ${error}
      <button type="submit" ${options.secretConfigured ? "" : "disabled"}>Approve connection</button>
    </form>
    <p class="muted">Approving grants a scoped access token to the client above. You can revoke it by rotating the workspace tokens.</p>
  `);
};

export const renderErrorPage = (error: string, description: string): string =>
  page("Authorization error", `
    <h1>Authorization error</h1>
    <p class="err">${escapeHtml(error)}</p>
    <p>${escapeHtml(description)}</p>
    <p class="muted">Close this window and retry the connection from your MCP client.</p>
  `);
