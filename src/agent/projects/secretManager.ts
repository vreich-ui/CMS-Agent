// T12.20 — the TOKEN half of "minting a tenant must not require editing a deployment".
//
// WHAT THIS EXISTS FOR. 87c21af moved a tenant's ENDPOINT onto its registry record because
// hand-adding <CLIENT>_MCP_ENDPOINT per tenant "does not work for me" (Wolf, 2026-08-18). The token
// stayed an env var NAME, so every tenant still needed its VALUE present on every plane. On
// 2026-08-20 that bill came due: the `continuation-tick` Cloud Run JOB — a second executor that has
// been picking up queued nodes every ~2 minutes since Aug 14 — carries no tenant MCP variables at
// all. Roughly half of every capture node execution landed there and failed with "Project MCP
// endpoint is not configured", while the same call through the cms-agent-mcp SERVICE succeeded.
// Two planes, same code, different environment. Adding four variables would have fixed that job and
// silently mis-configured the next plane, and the next tenant.
//
// So the token resolves the same way the endpoint does: ENV FIRST, RECORD SECOND. The record stores
// a Secret Manager REFERENCE — never a value — and any plane running as a Google service account
// resolves it with no per-tenant, per-plane configuration whatsoever.
//
// WHY THIS DOES NOT WEAKEN "secrets: env var NAMES over MCP, never values". A resource name like
// projects/p/secrets/tenant-acme-mcp-token/versions/latest is a POINTER, exactly as an env var name
// is a pointer. It grants nothing on its own: reading it requires roles/secretmanager.secretAccessor
// on the plane's own identity, which is an IAM decision made once, outside this system, and revocable
// without touching the registry. The value never enters the registry, an MCP response, a log line, a
// run record or an error message — the failure strings below are deliberately about REACHABILITY and
// PERMISSION, never about content.
//
// ZERO DEPENDENCIES, deliberately. This talks to the metadata server and the Secret Manager REST API
// with fetch rather than pulling in @google-cloud/secret-manager, because this module has to load on
// planes that are not Google at all (the Netlify functions) and must degrade there to "no identity
// available" rather than to a missing native dependency. On a non-Google plane the env var path is
// the one that answers, exactly as before.
//
// TODO (T12.21, ratified 2026-08-20): fortify. A stored secret is still a long-lived shared bearer.
// The end state is one of:
//   (B) one fleet signing key, short-lived per-call JWTs scoped to the tenant, verified tenant-side
//       against the fleet public key installed at genesis — mirrors scopedBearerTokens.ts, which
//       already does exactly this for the site -> CMS-Agent direction; or
//   (C) Google-issued OIDC ID tokens verified tenant-side against Google's JWKS — no shared secret
//       anywhere, nothing to rotate, nothing to leak.
// Both need tenant-side auth changes in platform's mcp.ts, which is why they are not this change.
// What this change buys is that neither of them will need a per-tenant, per-plane edit either.
import { Buffer } from "node:buffer";

/** A Secret Manager SECRET VERSION resource name. Pinned narrowly so a caller cannot smuggle an
 *  arbitrary URL, a different Google API path, or a traversal through this field. */
export const SECRET_VERSION_REF_RE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/(?:latest|[1-9][0-9]{0,18})$/;

export const isSecretVersionRef = (value: string): boolean => SECRET_VERSION_REF_RE.test(value);

// Two hosts, deliberately. `metadata.google.internal` is the documented name, but it is a DNS name
// and DNS is the part that fails: on 2026-08-20 this module reported "no Google service-account
// identity" from a plane that demonstrably HAS one (the same process reads the GCS run store through
// Application Default Credentials, which is metadata-server auth). The link-local address needs no
// resolver, so trying it second turns a DNS failure into a working read instead of a wrong
// diagnosis. GCE_METADATA_HOST is Google's own override and is honoured first when set.
const METADATA_PATH = "/computeMetadata/v1/instance/service-account/token";
const metadataUrls = (env: NodeJS.ProcessEnv): string[] => {
  const override = env.GCE_METADATA_HOST?.trim();
  return (override ? [override] : ["metadata.google.internal", "169.254.169.254"]).map(
    (host) => `http://${host}${METADATA_PATH}`
  );
};
const SECRET_ACCESS_BASE = "https://secretmanager.googleapis.com/v1/";

/** How long a resolved secret is reused before it is read again. Short enough that a rotation takes
 *  effect without a redeploy; long enough that a busy run does not hammer Secret Manager. */
export const SECRET_CACHE_TTL_MS = 5 * 60_000;
/** Renew the plane's access token this long before it actually expires. */
const ACCESS_TOKEN_SAFETY_MS = 60_000;

export type SecretAccessDeps = { fetchImpl?: typeof fetch; now?: () => number; env?: NodeJS.ProcessEnv };
export type SecretAccessResult = { ok: true; value: string } | { ok: false; error: string };

type CacheEntry = { value: string; expiresAt: number };
const secretCache = new Map<string, CacheEntry>();
let accessTokenCache: { token: string; expiresAt: number } | undefined;

/** Test seam. Never call from production code — the caches are the point. */
export const __resetSecretCachesForTesting = (): void => {
  secretCache.clear();
  accessTokenCache = undefined;
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/**
 * The plane's own OAuth access token from the metadata server. Returns the token, or WHAT ACTUALLY
 * WENT WRONG — the first version of this returned a bare undefined and the caller turned that into a
 * confident "this plane has no Google identity", which was false and sent a diagnosis down the wrong
 * path for an hour. Every attempt is reported.
 */
async function planeAccessToken(
  fetchImpl: typeof fetch,
  now: () => number,
  env: NodeJS.ProcessEnv
): Promise<{ token: string } | { error: string }> {
  if (accessTokenCache && accessTokenCache.expiresAt > now()) return { token: accessTokenCache.token };
  const attempts: string[] = [];
  for (const url of metadataUrls(env)) {
    const host = new URL(url).host;
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { "Metadata-Flavor": "Google" } });
    } catch (error) {
      // The exception NAME only — a message could carry a proxy URL or an internal address.
      attempts.push(`${host}: unreachable (${error instanceof Error ? error.name : typeof error})`);
      continue;
    }
    if (!response.ok) {
      attempts.push(`${host}: HTTP ${response.status}`);
      continue;
    }
    const body = (await readJson(response)) as { access_token?: unknown; expires_in?: unknown } | undefined;
    const token = typeof body?.access_token === "string" ? body.access_token : "";
    if (!token) {
      attempts.push(`${host}: responded without an access_token`);
      continue;
    }
    const ttlMs = typeof body?.expires_in === "number" ? body.expires_in * 1000 : 300_000;
    accessTokenCache = { token, expiresAt: now() + Math.max(0, ttlMs - ACCESS_TOKEN_SAFETY_MS) };
    return { token };
  }
  return { error: attempts.join("; ") || "no metadata host was tried" };
}

/**
 * Read one secret version. Returns the value or a SAFE reason — every failure string here describes
 * reachability or permission and never the secret's content or length.
 */
export async function accessSecretValue(ref: string, deps: SecretAccessDeps = {}): Promise<SecretAccessResult> {
  if (!isSecretVersionRef(ref)) {
    return {
      ok: false,
      error:
        "tokenSecretRef is not a Secret Manager version resource name (expected projects/<project>/secrets/<name>/versions/<latest|N>)."
    };
  }
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const cached = secretCache.get(ref);
  if (cached && cached.expiresAt > now()) return { ok: true, value: cached.value };

  const identity = await planeAccessToken(fetchImpl, now, deps.env ?? process.env);
  if ("error" in identity) {
    return {
      ok: false,
      error: `could not obtain this plane's Google identity from the metadata server (${identity.error}). If this plane genuinely is not on Google, set the token env var here instead; if it is, that is a metadata reachability problem, not a token problem.`
    };
  }
  const accessToken = identity.token;

  let response: Response;
  try {
    response = await fetchImpl(`${SECRET_ACCESS_BASE}${ref}:access`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
  } catch {
    return { ok: false, error: "Secret Manager was unreachable from this plane." };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `Secret Manager refused the read (HTTP ${response.status}) — confirm this plane's service account holds roles/secretmanager.secretAccessor on that secret and that the version exists.`
    };
  }
  const body = (await readJson(response)) as { payload?: { data?: unknown } } | undefined;
  const data = typeof body?.payload?.data === "string" ? body.payload.data : "";
  if (!data) return { ok: false, error: "Secret Manager returned no payload for that version." };

  // Trailing newlines are the single most common way a hand-created secret 401s at runtime; a
  // bearer token never legitimately has surrounding whitespace, so trimming is safe and saves an
  // outage that presents as "the token is wrong".
  const value = Buffer.from(data, "base64").toString("utf8").trim();
  if (!value) return { ok: false, error: "the stored secret version is empty." };

  secretCache.set(ref, { value, expiresAt: now() + SECRET_CACHE_TTL_MS });
  return { ok: true, value };
}
