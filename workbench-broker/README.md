# Conductor Workbench broker (WP-04)

Auth + MCP credential broker between the Conductor Workbench SPA and the
CMS Agent MCP Streamable-HTTP endpoint. The SPA is a static bundle that
holds no secrets; this server holds the MCP bearer token, owns the MCP
session lifecycle, authenticates the single operator (Wolf), and enforces
read-only mode as a server-side guarantee.

Node built-ins only (`node:http`, `node:crypto`) — no framework, no runtime
dependencies beyond TypeScript and `node --test`.

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
| `PORT` | no (default `8787`) | |
| `SESSION_SECRET` | **yes** | >= 32 chars, HMACs the session cookie |
| `OPERATOR_PASSWORD_HASH` | **yes** | from `npm run hash` above |
| `CMS_AGENT_MCP_URL` | **yes** (unless `MOCK_UPSTREAM=1`) | the workspace's MCP endpoint |
| `CMS_AGENT_MCP_TOKEN` | **yes** (unless `MOCK_UPSTREAM=1`) | the workspace's bearer token |
| `READ_ONLY` | no (default `1`, i.e. **on**) | server-side mutation block |
| `ALLOWED_ORIGIN` | no (default `http://localhost:5173`) | the SPA's origin, reflected in CORS |
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
default-deny + READ_ONLY enforcement, MCP content-block unwrapping (fetch
stubbed), and a full HTTP smoke test that boots the server on an ephemeral
port with `MOCK_UPSTREAM=1` and drives login → session → mcp → logout.

You do not need real MCP credentials to develop or test this server: set
`MOCK_UPSTREAM=1` and `src/mcp.ts` returns canned results instead of calling
out, so the whole HTTP surface is exercisable end-to-end without a live
workspace.

## 5. The HTTP contract (fixed — see spec/HANDOFF.md §6 for the verb map)

```
POST  /api/login    {password}          -> 200 {ok:true, operator, readOnly} + httpOnly session cookie | 401 {ok:false,error}
POST  /api/logout                       -> 200 {ok:true}, clears cookie
GET   /api/session                      -> 200 {authenticated, operator?, readOnly, workspace?:{version,ok}}
POST  /api/mcp      {verb, args?}       -> 200 {ok:true,data} | {ok:false,error:{code,message,verb}}
                                            401 if no/expired session; 403 if verb is mutating and READ_ONLY is on
GET   /api/health                       -> 200 {ok, mcp:{reachable,workspaceVersion}}
```

`verb` must be one of the verbs transcribed from `spec/HANDOFF.md` §6 into
`src/policy.ts`. Anything else is refused with 400 `unknown_verb` —
default-deny, not pass-through.

## 6. Deploying

The SPA (`app/dist`) is static files servable from anywhere (Netlify,
Cloud Storage + CDN, a plain nginx container — whatever). It only needs one
build-time env var: `VITE_API_BASE` pointed at this broker's public URL.
This broker and the SPA do **not** need to share a host.

### Google Cloud Run

```bash
docker build -t conductor-workbench-broker .
docker tag conductor-workbench-broker gcr.io/<project>/conductor-workbench-broker
docker push gcr.io/<project>/conductor-workbench-broker

gcloud run deploy conductor-workbench-broker \
  --image gcr.io/<project>/conductor-workbench-broker \
  --port 8787 \
  --set-env-vars READ_ONLY=1,ALLOWED_ORIGIN=https://<your-spa-host> \
  --set-secrets SESSION_SECRET=broker-session-secret:latest,OPERATOR_PASSWORD_HASH=broker-password-hash:latest,CMS_AGENT_MCP_URL=broker-mcp-url:latest,CMS_AGENT_MCP_TOKEN=broker-mcp-token:latest
```

Put `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `CMS_AGENT_MCP_TOKEN` (and
`CMS_AGENT_MCP_URL` if you'd rather not have it in plain env) in Secret
Manager rather than `--set-env-vars` for anything that's actually secret.
Cloud Run terminates TLS for you, so cookies with `Secure` work as-is.

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
  returned in any response body, never included in an error message.
- `/api/session` and `/api/health` report presence/reachability, never
  credential values.
- Access log lines are `{method, path, verb, status, durationMs}` only —
  no bodies, no headers, no MCP call arguments.
- `READ_ONLY` defaults to on. A broker that starts with a missing or
  unrecognized `READ_ONLY` value is safe by construction, not permissive.

## 8. Single-operator scope

This broker is built for exactly one operator (Wolf) with one shared
password and one session identity (`"wolf"` baked into the token payload).
See the handoff report for what would need to change to support multiple
users later.
