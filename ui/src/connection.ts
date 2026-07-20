// Connection model for the workspace MCP client.
//
// Authentication state is modeled explicitly as a discriminated union instead of being inferred
// from incidental field values (the old code derived "secure proxy" from an exact string match on
// the endpoint field and dropped the manual token whenever it matched — see
// docs/constellation/data-model-gaps.md §1). The mode is chosen by the user; the endpoint string
// never decides which credential is sent.
//
// This module is framework-free so root vitest can test it directly.

export type ConnectionMode = "direct" | "secure-proxy";

export type DirectConnection = {
  mode: "direct";
  endpoint: string;
  // Manual MCP bearer token. Empty means "not entered yet"; the client refuses to send a request
  // rather than sending one without credentials.
  token: string;
};

export type SecureProxyConnection = {
  mode: "secure-proxy";
  endpoint: string;
  // Resolved per request so an expired/renewed identity JWT is picked up automatically and no
  // credential value is captured at connection-construction time.
  getAccessToken: () => Promise<string | undefined>;
};

export type McpConnection = DirectConnection | SecureProxyConnection;

export const defaultEndpointForMode = (mode: ConnectionMode): string =>
  mode === "secure-proxy" ? "/api/workspace-mcp" : "/api/mcp";

// Which control plane the UI talks to (DIRECTION.md Phase 4). Netlify is the default and is never
// retired; Cloud Run is offered only when a build-time endpoint is configured. This is a separate
// axis from the auth mode: the Cloud Run plane always uses direct token auth against its absolute
// URL (the Identity secure proxy is a Netlify-only construct), so selecting it implies direct mode.
export type ControlPlane = "netlify" | "cloud-run";

// The Cloud Run endpoint is injected by the React layer from import.meta.env, keeping this module
// framework-free (root vitest tests it directly). Empty/absent means the Cloud Run plane is hidden.
export const controlPlaneAvailable = (cloudRunEndpoint: string | undefined): boolean =>
  typeof cloudRunEndpoint === "string" && cloudRunEndpoint.trim().length > 0;

export const resolveControlPlaneEndpoint = (plane: ControlPlane, mode: ConnectionMode, cloudRunEndpoint: string | undefined): string =>
  plane === "cloud-run" ? (cloudRunEndpoint?.trim() ?? "") : defaultEndpointForMode(mode);

export type ConnectionAuthSummary =
  | { kind: "direct-missing-token"; label: string }
  | { kind: "direct-ready"; label: string }
  | { kind: "secure-proxy"; label: string };

// Synchronous, render-safe description of the credential state. Never includes credential values.
export function summarizeConnectionAuth(connection: McpConnection): ConnectionAuthSummary {
  if (connection.mode === "secure-proxy") {
    return { kind: "secure-proxy", label: "Netlify Identity secure proxy; MCP tokens stay server-side." };
  }
  return connection.token.trim()
    ? { kind: "direct-ready", label: "Bearer token set; sent with every direct MCP request." }
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
