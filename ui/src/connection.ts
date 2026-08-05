// Connection model for the workspace MCP client.
//
// GCloud is the only control plane the UI ever talks to (Netlify's MCP proxy paths and the
// Identity secure-proxy auth mode were retired once Cloud Run became the sole target — the
// Cloud Run plane always used direct bearer-token auth against its absolute URL, so once it is
// the only plane, the secure-proxy branch is simply dead). The connection is a plain
// endpoint + bearer token: the endpoint defaults to the build-time Cloud Run URL and stays a
// free-text field so an operator can override it for local dev or a staging Cloud Run service.
//
// This module is framework-free so root vitest can test it directly.

export type McpConnection = {
  endpoint: string;
  // Manual MCP bearer token. Empty means "not entered yet"; the client refuses to send a request
  // rather than sending one without credentials.
  token: string;
};

export type ConnectionAuthSummary =
  | { kind: "direct-missing-token"; label: string }
  | { kind: "direct-ready"; label: string };

// Synchronous, render-safe description of the credential state. Never includes credential values.
export function summarizeConnectionAuth(connection: McpConnection): ConnectionAuthSummary {
  return connection.token.trim()
    ? { kind: "direct-ready", label: "Bearer token set; sent with every MCP request." }
    : { kind: "direct-missing-token", label: "Enter an MCP bearer token to call workspace tools." };
}

// --- Redaction -----------------------------------------------------------------------------
// Bearer credentials must never appear in logs, error messages, DOM text, or serialized error
// details. Redaction is pattern-based for strings ("Bearer <value>") and key-based for objects
// (any key that looks credential-like), so even server responses that echo a header are safe to
// surface.

// Matches "Bearer <value>" where <value> plausibly is a credential: it contains at least one
// digit or token punctuation (dot, underscore, tilde, plus, slash, equals), or is a long
// alpha/dash string. Plain prose like "bearer token" is left readable; when in doubt the pattern
// errs toward redacting. Key-based redaction below covers structured values regardless.
const BEARER_VALUE = /bearer\s+(?:[a-z0-9._~+/=-]*[0-9._~+/=][a-z0-9._~+/=-]*|[a-z-]{12,})/gi;
const SECRET_KEY = /authorization|token|api[-_]?key|cookie|secret|passkey|jwt/i;
const MAX_REDACTION_DEPTH = 8;

export function redactSecretText(text: string): string {
  return text.replace(BEARER_VALUE, "Bearer [redacted]");
}

export function redactSecretValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return "[redacted: depth limit]";
  if (typeof value === "string") return redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => redactSecretValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : redactSecretValue(item, depth + 1)
      ])
    );
  }
  return value;
}
