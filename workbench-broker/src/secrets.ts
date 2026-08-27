/**
 * Google Secret Manager access for the MCP workspace bearer token (Track A, A1.2).
 *
 * Mirrors the pattern already proven in this repo at
 * `src/agent/projects/secretManager.ts` (metadata-server access token +
 * plain REST `:access` call, base64-decoded payload, error strings that
 * describe reachability/permission and never content) but is reimplemented
 * independently here rather than imported: workbench-broker is its own npm
 * package with its own `package.json` and deliberately zero runtime
 * dependencies (see workbench-broker/README.md §"Node built-ins only"), and
 * this broker only ever runs as a Cloud Run service, so it does not need
 * that module's Netlify-plane ADC fallback via `google-auth-library` — the
 * metadata server is always present here.
 *
 * The resolved secret value is returned to the caller exactly once, at
 * startup, and is never logged, cached to disk, or included in any HTTP
 * response — see index.ts's startup sequence.
 */

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-account/default/token";
const SECRET_ACCESS_BASE = "https://secretmanager.googleapis.com/v1/";

/** A Secret Manager SECRET VERSION resource name, pinned narrowly like the sibling regex in
 *  src/agent/projects/secretManager.ts — this prevents a caller from smuggling an arbitrary URL,
 *  a different Google API path, or a traversal through this field. */
export const SECRET_VERSION_REF_RE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/(?:latest|[1-9][0-9]{0,18})$/;

export function isSecretVersionRef(value: string): boolean {
  return SECRET_VERSION_REF_RE.test(value);
}

export interface SecretAccessDeps {
  fetchImpl?: typeof fetch;
}

export type SecretAccessResult = { ok: true; value: string } | { ok: false; error: string };

/** The plane's own OAuth access token via the Cloud Run/GCE metadata server. */
async function planeAccessToken(deps: SecretAccessDeps): Promise<{ token: string } | { error: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  } catch (error) {
    return { error: `metadata server unreachable (${error instanceof Error ? error.name : typeof error})` };
  }
  if (!response.ok) {
    return { error: `metadata server responded HTTP ${response.status}` };
  }
  let body: { access_token?: unknown } | undefined;
  try {
    body = (await response.json()) as { access_token?: unknown };
  } catch {
    body = undefined;
  }
  const token = typeof body?.access_token === "string" ? body.access_token : "";
  if (!token) return { error: "metadata server responded without an access_token" };
  return { token };
}

/**
 * Reads one Secret Manager secret version and returns its decoded value, or a SAFE reason string —
 * every failure here describes reachability/permission, never the secret's own content or length.
 */
export async function accessSecretValue(ref: string, deps: SecretAccessDeps = {}): Promise<SecretAccessResult> {
  if (!isSecretVersionRef(ref)) {
    return {
      ok: false,
      error:
        "is not a Secret Manager version resource name (expected projects/<project>/secrets/<name>/versions/<latest|N>).",
    };
  }

  const identity = await planeAccessToken(deps);
  if ("error" in identity) {
    return {
      ok: false,
      error: `could not obtain this plane's Google identity (${identity.error}) — this broker must run as a service account with roles/secretmanager.secretAccessor on the secret.`,
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${SECRET_ACCESS_BASE}${ref}:access`, {
      headers: { authorization: `Bearer ${identity.token}` },
    });
  } catch {
    return { ok: false, error: "Secret Manager was unreachable from this plane." };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `Secret Manager responded HTTP ${response.status} for this secret. Check the secret exists and this service account has roles/secretmanager.secretAccessor.`,
    };
  }

  let body: { payload?: { data?: unknown } } | undefined;
  try {
    body = (await response.json()) as { payload?: { data?: unknown } };
  } catch {
    body = undefined;
  }
  const b64 = typeof body?.payload?.data === "string" ? body.payload.data : "";
  if (!b64) return { ok: false, error: "Secret Manager response did not include payload.data." };

  const value = Buffer.from(b64, "base64").toString("utf8");
  if (!value) return { ok: false, error: "Secret Manager returned an empty secret value." };
  return { ok: true, value };
}
