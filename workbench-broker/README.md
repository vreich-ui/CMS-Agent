# Conductor Workbench broker (WP-04, Track A)

Auth + MCP credential broker between the Conductor Workbench SPA and the
CMS Agent MCP Streamable-HTTP endpoint. As of Track A (Pass 2 — see
docs/plan/TRACK-A-RUNBOOK.md), this broker is also the SPA's single origin:
it serves the built `workbench/dist` bundle as static files (SPA fallback
to `index.html`) alongside its own `/api/*` surface, so the browser never
talks to Cloud Run directly and never holds an MCP credential. This server
holds the MCP bearer token (read from Google Secret Manager at startup),
owns the persistent MCP session lifecycle, resolves the operator's identity
(Google IAP by default, or the original password login), and enforces
read-only mode as a server-side guarantee.

Node built-ins only (`node:http`, `node:crypto`, `node:fs`) — no framework,
no runtime dependencies beyond TypeScript and `node --test`. IAP JWT
verification uses `node:crypto`'s built-in JWK import rather than a JOSE
library — see `src/iap.ts`'s header comment for why that was feasible here
without adding a dependency.

## 1. Generate the operator password hash

Never store the plaintext password anywhere — only its scrypt hash goes in
`.env`.

```bash
npm install
npm run hash -- 'the operator password'
```

This prints a line like:

```
scrypt$16384$8$1$<salt_b64>$<hash_b64>
```

Paste that whole line into `OPERATOR_PASSWORD_HASH` in your `.env`.

## 2. Configure

```bash
cp .env.example .env
```

Fill in every variable — `.env.example` documents each one and what breaks
without it. In short:

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no (default `8787`) | Cloud Run overrides this at deploy time |
| `AUTH_MODE` | no (default `iap`) | `iap` or `password` — see `.env.example` |
| `IAP_AUDIENCE` | no | expected `aud` claim on the IAP JWT; unset skips audience pinning |
| `SESSION_SECRET` | **yes** | >= 32 chars, HMACs the session cookie |
| `OPERATOR_PASSWORD_HASH` | **yes** | from `npm run hash` above (needed even under `AUTH_MODE=iap`) |
| `CMS_AGENT_MCP_URL` | **yes** (unless `MOCK_UPSTREAM=1`) | the workspace's MCP endpoint |
| `CMS_AGENT_MCP_TOKEN_SECRET` | preferred for real deploys | Secret Manager secret **version** resource name for the bearer token |
| `CMS_AGENT_MCP_TOKEN` | local-dev fallback | required only if `CMS_AGENT_MCP_TOKEN_SECRET` is unset and not mocked |
| `READ_ONLY` | no (default `1`, i.e. **on**) | server-side mutation block |
| `CACHE_TTL_MS` | no (default `20000`) | read-verb response cache TTL |
| `STATIC_ROOT` | no | directory holding the built SPA (`workbench/dist`); unset = static serving off |
| `ALLOWED_ORIGIN` | no (default `http://localhost:5173`) | the SPA's origin, reflected in CORS (inert once the SPA is same-origin) |
| `MOCK_UPSTREAM` | no (default off) | dev/test only — see below |

Startup fails fast with a precise message naming any missing or malformed
required variable. It will not silently start half-configured.

## 3. Run locally

```bash
npm run build
npm start
# or, for a watch-mode dev loop:
npm run dev
```

Verify it's alive:

```bash
curl http://localhost:8787/api/health
```

## 4. Test

```bash
npm test
```

Runs `node --test` over the compiled `dist/*.test.js`, covering session
sign/verify + tamper/expiry rejection, password hash verify/reject, policy
default-deny + READ_ONLY enforcement, MCP content-block unwrapping and
JSON-RPC array batching (fetch stubbed), upstream call timeouts, the
read-verb cache (hit/miss/TTL/invalidate), Secret Manager token resolution
(fetch stubbed), IAP JWT verification (a real ES256 keypair signs test
assertions — no network), static SPA serving (incl. the path-traversal
guard), the `/api/bootstrap` composition (a stub MCP client), and a full
HTTP smoke test that boots the server on an ephemeral port with
`MOCK_UPSTREAM=1` and drives login → session → mcp (single + batch) →
bootstrap → logout, plus a separate IAP-mode smoke pass with a stubbed
verifier.

You do not need real MCP credentials to develop or test this server: set
`MOCK_UPSTREAM=1` and `src/mcp.ts` returns canned results instead of calling
out, so the whole HTTP surface is exercisable end-to-end without a live
workspace.

## 5. The HTTP contract (see spec/HANDOFF.md §6 for the verb map)

```
POST  /api/login    {password}          -> 200 {ok:true, operator, readOnly} + httpOnly session cookie | 401 {ok:false,error}
                                            400 {ok:false,error:{code:"iap_mode",...}} under AUTH_MODE=iap
POST  /api/logout                       -> 200 {ok:true}, clears cookie
GET   /api/session                      -> 200 {authenticated, operator?, readOnly, workspace?:{version,ok}}
                                            operator is the IAP-verified email under AUTH_MODE=iap
POST  /api/mcp      {verb, args?}       -> 200 {ok:true,data} | {ok:false,error:{code,message,verb}}
                                            401 if unauthenticated; 403 if verb is mutating and READ_ONLY is on
POST  /api/mcp      {calls:[{verb,args?},...]}
                                         -> 200 {results:[{ok:true,data}|{ok:false,error:{code,message,verb}}, ...]}
                                            one upstream JSON-RPC array request for the whole batch;
                                            one failing call never fails the batch; 401 if unauthenticated
GET   /api/bootstrap                    -> 200 {workflows, graphs, nodeSummaries, recentRuns, attention,
                                                 workspaceVersion, capturedAt, errors?}
                                            one round trip for the shell; degrades a failed component to
                                            null + errors.<key> instead of failing the whole response.
                                            401 if unauthenticated. See src/bootstrap.ts.
GET   /api/health                       -> 200 {ok, mcp:{reachable,workspaceVersion}}
GET   /*  (not under /api/)             -> the built SPA (STATIC_ROOT), SPA-route fallback to index.html,
                                            or a clean 404 if no SPA is bundled into this image
```

`verb` must be one of the verbs transcribed from `spec/HANDOFF.md` §6 into
`src/policy.ts`. Anything else is refused with 400 `unknown_verb` —
default-deny, not pass-through. Read verbs are served from a short-TTL
cache (`CACHE_TTL_MS`) keyed on `(verb, args, cache generation)`; any
mutating verb reaching the upstream workspace bumps that generation,
invalidating every cached read.

## 6. Deploying

### Track A: single Cloud Run service (the deployed shape)

As of Track A, this broker and the Conductor Workbench SPA ship as **one**
image, built from the root `Dockerfile.workbench` (not this directory's
`Dockerfile`, which still builds the broker alone — see below), and deployed
as one Cloud Run service sitting behind Google IAP. Full copy-pasteable
commands — Secret Manager setup, IAM roles, the build, the deploy, enabling
IAP, verification, rollback — live in
[`docs/plan/TRACK-A-RUNBOOK.md`](../docs/plan/TRACK-A-RUNBOOK.md); that
runbook is the source of truth for a real deploy, not this section.

### Standalone broker only (this directory's own `Dockerfile`)

The SPA can still be served from anywhere else entirely (Cloud Storage +
CDN, a plain nginx container, Netlify) with this broker as a separate
service it talks to over the network — the original WP-04 shape, still
supported, just no longer the deployed one. The SPA needs one build-time env
var in that case: `VITE_API_BASE` pointed at this broker's public URL.

```bash
docker build -t conductor-workbench-broker .
docker tag conductor-workbench-broker gcr.io/<project>/conductor-workbench-broker
docker push gcr.io/<project>/conductor-workbench-broker

gcloud run deploy conductor-workbench-broker \
  --image gcr.io/<project>/conductor-workbench-broker \
  --port 8787 \
  --set-env-vars READ_ONLY=0,AUTH_MODE=password,ALLOWED_ORIGIN=https://<your-spa-host> \
  --set-secrets SESSION_SECRET=broker-session-secret:latest,OPERATOR_PASSWORD_HASH=broker-password-hash:latest,CMS_AGENT_MCP_URL=broker-mcp-url:latest,CMS_AGENT_MCP_TOKEN=broker-mcp-token:latest
```

Put `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `CMS_AGENT_MCP_TOKEN` (and
`CMS_AGENT_MCP_URL` if you'd rather not have it in plain env) in Secret
Manager rather than `--set-env-vars` for anything that's actually secret —
or, better, set `CMS_AGENT_MCP_TOKEN_SECRET` instead of `CMS_AGENT_MCP_TOKEN`
and let the broker itself resolve the token from Secret Manager at startup
(see `src/secrets.ts`); that path never puts the token in a Cloud Run env
var at all. Cloud Run terminates TLS for you, so cookies with `Secure` work
as-is.

### Netlify Functions

This server is written as a single long-lived `node:http` process, which is
not the Netlify Functions execution model (one function invocation per
request, no persistent in-memory session across invocations). The pieces
most affected by that:

- `src/mcp.ts`'s in-memory `Mcp-Session-Id` cache and init-mutex assume one
  running process. On Netlify Functions each invocation is a fresh
  container, so the cached session id would not survive between requests
  and every call could re-initialize.
- The in-memory login rate limiter (`LoginRateLimiter` in `src/index.ts`)
  is per-process state, so it would reset per cold start.

An adapter is small (~30-40 lines) if this target is chosen: wrap
`buildServer`'s route handlers behind a single Netlify Function using
`@netlify/functions`'s `Handler` type, translate the Netlify `event` into
the `(req, body)` shape the handlers already expect, and move the MCP
session id into a short-TTL external store (Netlify Blobs or similar) so it
survives across invocations instead of living in a module-level variable.
Given that trade-off, **Cloud Run (a normal persistent container) is the
straightforward target**; Netlify Functions works but wants that extra
session-persistence layer first.

## 7. Security notes (see also the WP-04 brief)

- The MCP bearer token appears in exactly one place: the outbound
  `Authorization` header built in `src/mcp.ts`. It is never logged, never
  returned in any response body, never included in an error message. When
  `CMS_AGENT_MCP_TOKEN_SECRET` is set (the real-deploy path), the token is
  read out of Secret Manager exactly once at process startup
  (`src/secrets.ts`) and handed straight to the MCP client — it is never
  written back onto the loaded config object, never logged, never cached to
  disk.
- Under `AUTH_MODE=iap` (the deployed default), the operator identity this
  broker trusts comes from verifying the `X-Goog-IAP-JWT-Assertion` header's
  signature against Google's own public keys (`src/iap.ts`) — never from
  reading the plain `X-Goog-Authenticated-User-Email` header IAP also sets,
  which is spoofable if this service is ever reachable off-IAP (a
  misconfigured ingress setting, a debug port, a future regression).
- `/api/session` and `/api/health` report presence/reachability, never
  credential values.
- Access log lines are `{method, path, verb, status, durationMs}` only —
  no bodies, no headers, no MCP call arguments.
- `READ_ONLY` defaults to on in this broker's own code (`config.ts`) — a
  broker that starts with a missing or unrecognized `READ_ONLY` value is
  safe by construction, not permissive. The **deployed** Track A config sets
  `READ_ONLY=0` deliberately (Wolf's decision to exit read-only — see
  docs/plan/TRACK-A-RUNBOOK.md); that is an operator choice made in the
  deploy config, not a change to the code's own safe default.

## 8. Single-operator scope

This broker is built for exactly one operator (Wolf) with one shared
password and one session identity (`"wolf"` baked into the token payload).
See the handoff report for what would need to change to support multiple
users later.
