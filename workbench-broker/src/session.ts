/**
 * Stateless signed sessions.
 *
 * The session token is `base64url(payload_json).base64url(hmac_sha256(payload_json))`.
 * No server-side session store is needed — the signature is the proof of
 * authenticity, and expiresAt is checked on every read. The cookie is
 * HttpOnly so the SPA's JS can never read the token, only send it back
 * automatically.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "cw_session";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export interface SessionPayload {
  operator: string;
  issuedAt: number;
  expiresAt: number;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** Encodes and signs a session payload into a cookie-ready token string. */
export function createSessionToken(
  operator: string,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): { token: string; payload: SessionPayload } {
  const payload: SessionPayload = {
    operator,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(payloadB64, secret);
  return { token: `${payloadB64}.${sig}`, payload };
}

/**
 * Verifies a session token: checks signature (constant-time) and expiry.
 * Returns the decoded payload on success, or null on any failure — never
 * throws, so callers can treat "no valid session" uniformly.
 */
export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now()
): SessionPayload | null {
  if (!token) return null;
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1) return null;

  const payloadB64 = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  const expectedSig = sign(payloadB64, secret);

  const providedBuf = Buffer.from(providedSig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  let payload: SessionPayload;
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    payload = JSON.parse(json) as SessionPayload;
  } catch {
    return null;
  }

  if (
    typeof payload.operator !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number"
  ) {
    return null;
  }

  if (now >= payload.expiresAt) return null;

  return payload;
}

/** Builds the Set-Cookie header value for a fresh session token. */
export function buildSessionCookie(token: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const maxAgeSeconds = Math.floor(ttlMs / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** Builds the Set-Cookie header value that clears the session cookie. */
export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Parses the raw Cookie request header into a name->value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Sliding refresh: reissues a fresh token for the same operator with a renewed TTL. */
export function refreshSessionToken(
  payload: SessionPayload,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): { token: string; payload: SessionPayload } {
  return createSessionToken(payload.operator, secret, ttlMs, now);
}

export { DEFAULT_TTL_MS };
