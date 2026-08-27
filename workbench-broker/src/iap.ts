/**
 * Google IAP JWT verification (Track A, A1.5).
 *
 * Under `AUTH_MODE=iap`, access to this service is already gated by IAP at
 * the load balancer — but a plain `X-Goog-Authenticated-User-Email` header
 * is spoofable by anyone who can reach the container directly (a
 * misconfigured ingress setting, a debug port, a future regression). So the
 * operator identity this broker trusts comes from verifying the signed
 * `X-Goog-IAP-JWT-Assertion` header against Google's own public keys, not
 * from reading the header IAP also happens to set.
 *
 * IAP signs this assertion with ES256 over Google's published JWK set
 * (https://www.gstatic.com/iap/verify/public_key-jwk). Node's own
 * `node:crypto` can import a JWK-format EC public key directly
 * (`createPublicKey({key, format:"jwk"})`, available since Node 15) and
 * verify an ES256/JWS signature against it with `dsaEncoding:"ieee-p1363"`
 * (the raw r‖s concatenation JWS uses, as opposed to crypto's DER default) —
 * so this needs no JWT/JOSE library. `google-auth-library` (already a
 * transitive dependency of the main repo, via
 * src/agent/projects/secretManager.ts) ships an `OAuth2Client.verifySignedJwtWithCertsAsync`
 * that does the same verification and would have been the fallback named in
 * the task brief if this had turned out to need one; it did not, so this
 * broker's zero-runtime-dependency footprint (see README.md) stays intact.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
const EXPECTED_ISSUER = "https://cloud.google.com/iap";
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — Google rotates these keys infrequently.
const CLOCK_SKEW_S = 60;

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  expiresAt: number;
}

let jwksCache: JwksCacheEntry | null = null;

export interface IapVerifyDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type IapVerifyResult =
  | { ok: true; email: string; payload: Record<string, unknown> }
  | { ok: false; error: string };

function base64UrlToBuffer(b64url: string): Buffer {
  return Buffer.from(b64url, "base64url");
}

async function fetchJwks(deps: IapVerifyDeps): Promise<Jwk[] | { error: string }> {
  const now = (deps.now ?? Date.now)();
  // A caller-supplied fetchImpl means "this is a test" — always fetch fresh so tests stay
  // deterministic and offline, mirroring src/agent/projects/secretManager.ts's convention of
  // treating an injected fetchImpl as the test-only path.
  if (!deps.fetchImpl && jwksCache && jwksCache.expiresAt > now) {
    return jwksCache.keys;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(JWKS_URL);
  } catch (error) {
    return { error: `IAP public key set was unreachable (${error instanceof Error ? error.name : typeof error}).` };
  }
  if (!response.ok) {
    return { error: `IAP public key set fetch returned HTTP ${response.status}.` };
  }
  let body: { keys?: Jwk[] } | undefined;
  try {
    body = (await response.json()) as { keys?: Jwk[] };
  } catch {
    return { error: "IAP public key set response was not valid JSON." };
  }
  const keys = Array.isArray(body?.keys) ? body!.keys : [];
  if (keys.length === 0) return { error: "IAP public key set response contained no keys." };
  if (!deps.fetchImpl) {
    jwksCache = { keys, expiresAt: now + JWKS_CACHE_TTL_MS };
  }
  return keys;
}

/**
 * Verifies an IAP-signed JWT assertion (the `X-Goog-IAP-JWT-Assertion` header value) and returns
 * the operator's email from the JWT's own signed payload — never from a separate, spoofable header.
 *
 * `audience`, when provided, must exactly match the token's `aud` claim (IAP sets this to the
 * backend service / load balancer resource the request was authorized for — see
 * docs/plan/TRACK-A-RUNBOOK.md for how to read it off the running service). Passing `undefined`
 * skips that one check — still real signature + issuer + expiry verification, just without pinning
 * to a specific IAP resource — and only for a working deployment where that value is not yet known;
 * production should set IAP_AUDIENCE.
 */
export async function verifyIapJwt(
  jwt: string,
  audience: string | undefined,
  deps: IapVerifyDeps = {}
): Promise<IapVerifyResult> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "malformed assertion (not a three-part JWT)." };
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlToBuffer(headerB64).toString("utf8"));
    payload = JSON.parse(base64UrlToBuffer(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, error: "malformed assertion (header/payload was not valid JSON)." };
  }

  if (header.alg !== "ES256") {
    return { ok: false, error: `unsupported assertion algorithm "${header.alg ?? "unknown"}" (expected ES256).` };
  }
  if (!header.kid) {
    return { ok: false, error: "assertion header is missing kid." };
  }

  const jwks = await fetchJwks(deps);
  if ("error" in jwks) return { ok: false, error: jwks.error };

  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "EC" || !jwk.x || !jwk.y) {
    return { ok: false, error: `no matching IAP public key for kid "${header.kid}".` };
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: { kty: "EC", crv: jwk.crv ?? "P-256", x: jwk.x, y: jwk.y },
      format: "jwk",
    });
  } catch {
    return { ok: false, error: "could not import the matching IAP public key." };
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = base64UrlToBuffer(sigB64);
  let validSignature: boolean;
  try {
    validSignature = cryptoVerify("sha256", signingInput, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return { ok: false, error: "signature verification failed to run." };
  }
  if (!validSignature) {
    return { ok: false, error: "assertion signature did not verify." };
  }

  if (payload.iss !== EXPECTED_ISSUER) {
    return { ok: false, error: `unexpected issuer "${String(payload.iss)}".` };
  }
  const nowS = Math.floor((deps.now ?? Date.now)() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const iat = typeof payload.iat === "number" ? payload.iat : 0;
  if (nowS >= exp + CLOCK_SKEW_S) {
    return { ok: false, error: "assertion has expired." };
  }
  if (iat > 0 && nowS < iat - CLOCK_SKEW_S) {
    return { ok: false, error: "assertion is not yet valid (iat is in the future)." };
  }
  if (audience !== undefined && payload.aud !== audience) {
    return { ok: false, error: "assertion audience does not match this deployment." };
  }

  const email = typeof payload.email === "string" ? payload.email : "";
  if (!email) {
    return { ok: false, error: "assertion payload has no email claim." };
  }

  return { ok: true, email, payload };
}

/** Test-only: clears the module-level JWKS cache so tests don't leak state into each other. */
export function __resetIapJwksCacheForTesting(): void {
  jwksCache = null;
}
