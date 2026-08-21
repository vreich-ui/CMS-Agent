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
// HOW THE IDENTITY IS OBTAINED, and why there are two ways. The first version of this hand-rolled the
// metadata-server call with fetch, on the reasoning that this module must also load on planes that are
// not Google at all (the Netlify functions) and must degrade there to "no identity available" rather
// than to a missing dependency. That reasoning still holds for Secret Manager itself — the REST call
// below is still plain fetch, no @google-cloud/secret-manager. It did NOT hold for the token: on
// 2026-08-20 the hand-rolled call returned HTTP 404 from both metadata hosts on revision
// cms-agent-mcp-00132-5mq, a real Cloud Run instance whose SAME PROCESS was reading the GCS run store
// through Application Default Credentials at that exact moment. Two mechanisms, one identity, one of
// them working: the hand-rolled one was the broken one, and no amount of correcting its URL was going
// to make it the trustworthy one.
//
// So the token now comes from google-auth-library — the library @google-cloud/storage already uses in
// this process, on this plane, successfully. It is a transitive production dependency, so it costs no
// new install; it is imported DYNAMICALLY so a plane that does not bundle it (a Netlify function) gets
// a recorded attempt and falls through instead of failing to load. The hand-rolled metadata call is
// kept as the fallback, and its failures now quote the response body, because "HTTP 404" without a
// body is what let a wrong URL look like a missing service account for an hour.
//
// Injecting deps.fetchImpl selects the fallback path only. That keeps the unit tests deterministic and
// offline: a test that hands this module a fake fetch is testing the metadata/REST wire format, and
// must never reach for the ambient credentials of whatever machine it runs on.
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
// The ACCOUNT SEGMENT is not optional. `/instance/service-account/token` is a 404 on a real
// metadata server — `/instance/service-account/` lists the accounts, and the token lives one level
// down under a specific one, `default` being the instance's own. Omitting it produced HTTP 404 from
// BOTH hosts on a plane that has a perfectly good identity, which is precisely why the previous
// commit made this report the status per host instead of asserting "no identity": the honest
// message named a 404, and a 404 is a wrong URL, not a missing service account.
const METADATA_PATH = "/computeMetadata/v1/instance/service-account/default/token";
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
 * The plane's own OAuth access token via Application Default Credentials — the SAME mechanism
 * @google-cloud/storage uses in this process to read the run store, which is what makes it the
 * trustworthy one. Imported dynamically so a plane without the library records an attempt and falls
 * through to the metadata call rather than failing to load this module at all.
 */
async function tokenViaApplicationDefaultCredentials(): Promise<{ token: string } | { error: string }> {
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const response = await client.getAccessToken();
    const token = typeof response?.token === "string" ? response.token : "";
    if (!token) return { error: "application default credentials: resolved, but returned no access token" };
    return { token };
  } catch (error) {
    // The MESSAGE, bounded — "Could not load the default credentials" is the whole diagnosis and is
    // not sensitive. Only the name would repeat the mistake this module was written to stop making.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { error: `application default credentials: ${message.replace(/\s+/g, " ").trim().slice(0, 200)}` };
  }
}

/**
 * The plane's own OAuth access token from the metadata server. Returns the token, or WHAT ACTUALLY
 * WENT WRONG — the first version of this returned a bare undefined and the caller turned that into a
 * confident "this plane has no Google identity", which was false and sent a diagnosis down the wrong
 * path for an hour. Every attempt is reported.
 */
/**
 * The plane's own OAuth access token from the GCE/Cloud Run metadata server.
 *
 * Exported so every Google API caller on this plane shares ONE implementation. There is exactly one
 * correct metadata path (see METADATA_PATH above — the account segment is not optional), one
 * host-fallback order, and one cache; a second hand-rolled copy is how a 404 like the one that
 * motivated that comment gets reintroduced somewhere else. Callers get either a token or a SAFE
 * reason string that names reachability or status only.
 */
export async function planeAccessToken(
  fetchImpl: typeof fetch,
  now: () => number,
  env: NodeJS.ProcessEnv,
  useAmbientCredentials: boolean
): Promise<{ token: string } | { error: string }> {
  if (accessTokenCache && accessTokenCache.expiresAt > now()) return { token: accessTokenCache.token };
  const attempts: string[] = [];

  if (useAmbientCredentials) {
    const ambient = await tokenViaApplicationDefaultCredentials();
    if ("token" in ambient) {
      accessTokenCache = { token: ambient.token, expiresAt: now() + SECRET_CACHE_TTL_MS };
      return { token: ambient.token };
    }
    attempts.push(ambient.error);
  }

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
      // The BODY of a failed metadata response is the diagnosis — the server names the path it could
      // not find. Only ever read on a NON-ok response: a 200 body is the token itself.
      let detail = "";
      try {
        detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 160);
      } catch {
        detail = "";
      }
      attempts.push(`${host}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
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

  const identity = await planeAccessToken(fetchImpl, now, deps.env ?? process.env, !deps.fetchImpl);
  if ("error" in identity) {
    return {
      ok: false,
      error: `could not obtain this plane's Google identity (${identity.error}) — every mechanism tried is listed, in the order it was tried. If this plane genuinely is not on Google, set the token env var here instead; if it is, that is a metadata reachability problem, not a token problem.`
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
