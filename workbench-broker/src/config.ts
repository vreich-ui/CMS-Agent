/**
 * Environment loading + startup validation.
 *
 * Fails fast: if a required variable is missing or malformed, the process
 * throws a precise error naming the variable and exits before the HTTP
 * server ever binds a port. A broker that starts half-configured is a
 * broker that silently leaks or silently blocks — neither is acceptable.
 */

import { isSecretVersionRef } from "./secrets.js";

export type AuthMode = "iap" | "password";

export interface Config {
  port: number;
  sessionSecret: string;
  operatorPasswordHash: string;
  mcpUrl: string;
  /** Plain-env MCP bearer token (local dev / MOCK_UPSTREAM fallback). Empty when
   *  `mcpTokenSecretRef` is set — the real value is then resolved once at startup via Secret
   *  Manager (see secrets.ts) and handed to McpClient directly, never stored back on this object. */
  mcpToken: string;
  /** Secret Manager secret VERSION resource name for the MCP bearer token. When set, this is the
   *  token's only source of truth in a real deploy — `mcpToken` is ignored. */
  mcpTokenSecretRef: string;
  readOnly: boolean;
  allowedOrigin: string;
  mockUpstream: boolean;
  /** iap (default): trust only a verified IAP JWT for operator identity; the password login
   *  endpoints stay present but are not the access gate. password: the original cookie-session
   *  login flow, for a deployment not sitting behind IAP (e.g. local dev). */
  authMode: AuthMode;
  /** Expected `aud` claim on the IAP JWT — the backend service / load balancer resource this
   *  deployment is authorized for. Optional: unset skips audience pinning (signature + issuer +
   *  expiry are still verified) — see docs/plan/TRACK-A-RUNBOOK.md for how to read the real value
   *  off the running service once IAP is enabled. Ignored outside AUTH_MODE=iap. */
  iapAudience: string | undefined;
  /** TTL for the read-verb response cache (A1.4). */
  cacheTtlMs: number;
  /** Directory containing the built Conductor Workbench SPA (`workbench/dist`, copied into the
   *  image by Dockerfile.workbench). Unset or missing an index.html -> static serving is simply
   *  unavailable (404 for non-API paths) rather than a startup failure, so this broker still runs
   *  standalone (its historical deploy shape) when no SPA is bundled alongside it. */
  staticRoot: string | undefined;
}

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(
      `Missing required environment variable: ${name}. See .env.example for what it does and why it is required.`
    );
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function parseBoolFlag(value: string): boolean {
  // Treat "0", "false", "no" (case-insensitive) as off; everything else on.
  const normalized = value.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no" || normalized === "");
}

/**
 * Loads and validates configuration from the given env source
 * (defaults to process.env). Throws ConfigError with a precise message
 * on the first problem found.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mockUpstream = parseBoolFlag(optional(env, "MOCK_UPSTREAM", "0"));

  const portRaw = optional(env, "PORT", "8787");
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid PORT: "${portRaw}" is not a valid port number (1-65535).`);
  }

  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new ConfigError(
      `SESSION_SECRET is too short (${sessionSecret.length} chars). It must be at least 32 characters — ` +
        `generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
    );
  }

  const operatorPasswordHash = required(env, "OPERATOR_PASSWORD_HASH");
  if (!/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(operatorPasswordHash)) {
    throw new ConfigError(
      `OPERATOR_PASSWORD_HASH is malformed. Expected format "scrypt$N$r$p$salt_b64$hash_b64". ` +
        `Generate one with: npm run hash -- <password>`
    );
  }

  // MOCK_UPSTREAM=1 relaxes the MCP endpoint/token requirement so the full
  // HTTP surface can be exercised without real credentials (see smoke.test.ts).
  const mcpUrl = mockUpstream ? optional(env, "CMS_AGENT_MCP_URL", "http://mock.invalid/mcp") : required(env, "CMS_AGENT_MCP_URL");

  const mcpTokenSecretRef = optional(env, "CMS_AGENT_MCP_TOKEN_SECRET", "");
  if (mcpTokenSecretRef && !isSecretVersionRef(mcpTokenSecretRef)) {
    throw new ConfigError(
      `CMS_AGENT_MCP_TOKEN_SECRET is not a Secret Manager version resource name. Expected ` +
        `"projects/<project>/secrets/<name>/versions/<latest|N>", got "${mcpTokenSecretRef}".`
    );
  }
  // A real deploy needs exactly one source for the token: the Secret Manager ref (preferred —
  // A1.2, never sent to the browser, never logged) or the plain env var (local dev fallback).
  // MOCK_UPSTREAM never touches either.
  let mcpToken = "";
  if (mockUpstream) {
    mcpToken = optional(env, "CMS_AGENT_MCP_TOKEN", "mock-token");
  } else if (!mcpTokenSecretRef) {
    mcpToken = required(env, "CMS_AGENT_MCP_TOKEN");
  }

  const readOnly = parseBoolFlag(optional(env, "READ_ONLY", "1"));
  const allowedOrigin = optional(env, "ALLOWED_ORIGIN", "http://localhost:5173");

  const authModeRaw = optional(env, "AUTH_MODE", "iap").trim().toLowerCase();
  if (authModeRaw !== "iap" && authModeRaw !== "password") {
    throw new ConfigError(`Invalid AUTH_MODE: "${authModeRaw}" — must be "iap" or "password".`);
  }
  const authMode = authModeRaw as AuthMode;

  const iapAudienceRaw = optional(env, "IAP_AUDIENCE", "");
  const iapAudience = iapAudienceRaw === "" ? undefined : iapAudienceRaw;

  const cacheTtlMsRaw = optional(env, "CACHE_TTL_MS", "20000");
  const cacheTtlMs = Number.parseInt(cacheTtlMsRaw, 10);
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new ConfigError(`Invalid CACHE_TTL_MS: "${cacheTtlMsRaw}" is not a non-negative integer.`);
  }

  const staticRootRaw = optional(env, "STATIC_ROOT", "");
  const staticRoot = staticRootRaw === "" ? undefined : staticRootRaw;

  return {
    port,
    sessionSecret,
    operatorPasswordHash,
    mcpUrl,
    mcpToken,
    mcpTokenSecretRef,
    readOnly,
    allowedOrigin,
    mockUpstream,
    authMode,
    iapAudience,
    cacheTtlMs,
    staticRoot,
  };
}

export { ConfigError };
