# MCP Authorization and session control

This document explains why a remote MCP client (for example, Claude's custom connector) could not
finish authenticating against `/api/mcp`, and how the workspace now presents a spec-compliant MCP
**comm port**: OAuth 2.1 discovery + authorization, and Streamable-HTTP session control.

## The symptom

Adding the "manipulate nodes" workspace MCP as a remote connector opened the browser on the
workspace **dashboard** and never returned to the client, so authentication could not complete.

## Root cause

The endpoint exposed tools but none of the transport-level authorization a remote client expects.
Three gaps combined to produce the dead-end redirect:

1. **No OAuth discovery metadata.** A connector first fetches
   `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server`
   (RFC 8414). Those routes did not exist, and because `netlify.toml` ended with a catch-all
   `/* -> /index.html`, the probes returned the **SPA dashboard HTML with `200`** instead of JSON.
   The browser step therefore landed on the dashboard.
2. **No `WWW-Authenticate` header** on the `401` from `/api/mcp`. Per the MCP Authorization spec a
   protected resource must advertise `WWW-Authenticate: Bearer resource_metadata="…"`; without it a
   client has no pointer to begin discovery.
3. **No authorization endpoints.** There was nowhere to register a client, obtain a code, or
   exchange it for a token, so even a well-behaved client could not close the loop. The Netlify
   Identity login page is not an OAuth authorization endpoint and never redirects back to the client
   with a code.

## What changed

### OAuth 2.1 authorization server (`src/agent/mcp/auth`)

A small, self-contained authorization server implementing exactly the surface a connector drives:

- `metadata.ts` — builds the two discovery documents from the request origin.
- `oauthService.ts` — Dynamic Client Registration (RFC 7591), the authorization-code grant with
  mandatory PKCE `S256` (RFC 7636), refresh-token rotation, and opaque bearer access tokens.
- `pkce.ts` — constant-time `S256` verification.
- `consent.ts` — the human approval step. Whoever holds `MCP_OAUTH_APPROVAL_SECRET` approves the
  connection on a tiny consent screen; no Netlify Identity widget or third-party script is involved.
- `wwwAuthenticate.ts` — the `Bearer resource_metadata=…` challenge builder and bearer parser.

Codes and tokens never persist in the clear — they are stored under a SHA-256 hash of their value,
so a leaked blob cannot be replayed. Codes are one-time use; refresh tokens rotate on use.

### Routing

The well-known and `/oauth/*` routes are registered in `netlify.toml` **ahead of** the SPA
catch-all. This is the specific fix for the dashboard redirect: discovery URLs now return JSON, and
the authorize URL returns the consent screen instead of `index.html`.

### `/api/mcp` accepts OAuth tokens and emits the challenge

The handler accepts **either** the static `MCP_API_TOKEN` (unchanged, back-compatible) **or** an
OAuth-minted access token, and returns `401` + `WWW-Authenticate` when neither is present. A token
minted through the OAuth flow is attributed as an `agent` actor labelled by the client — the honest
mapping for a connector acting under a human's authorization (attribution, not authorization; see
`docs/constellation` and `changeTypes.ts`).

### Streamable-HTTP session control (`src/agent/mcp/transport`)

`initialize` mints an `Mcp-Session-Id` (returned as a response header and echoed in the result) and
negotiates the protocol version. Subsequent requests carrying the header are validated and slide the
idle window forward; unknown/expired sessions return `404` so the client re-initializes. `DELETE`
terminates a session. Sessions expire on a sliding idle window (default 30 min) capped by an absolute
max age (default 12 h).

Session enforcement is **non-breaking**: stateless bearer callers that omit the header keep working,
matching the endpoint's prior behavior and the in-app UI proxy. Set `MCP_REQUIRE_SESSION=true` to
require a session on every non-`initialize` request.

### Shared state store (`src/agent/mcp/state`)

Netlify Functions are stateless across invocations, so authorization codes, tokens, registered
clients, and sessions cannot live in a module-level `Map` in production — the `authorize` call and
the `token` call that follows it usually land on different invocations. A small TTL-aware key/value
store mirrors the repository layer: an in-process `MemoryStateStore` for dev/test and a
`BlobStateStore` selected by `WORKSPACE_STORE=blobs`. Expiry is enforced on read, so an
eventually-consistent backend can never resurrect a dead session or token.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `MCP_OAUTH_APPROVAL_SECRET` | Secret entered on the consent screen to approve a connection. | Falls back to `MCP_API_TOKEN` |
| `MCP_REQUIRE_SESSION` | Require a valid `Mcp-Session-Id` on every non-`initialize` request. | `false` |
| `WORKSPACE_STORE` | `blobs` persists sessions/OAuth state in Netlify Blobs (required in production). | `memory` |

## Connecting Claude

1. Set `MCP_OAUTH_APPROVAL_SECRET` (and `WORKSPACE_STORE=blobs`) in Netlify.
2. Add `https://<host>/api/mcp` as a custom/remote MCP connector.
3. When the browser opens the consent screen, enter the approval secret. The client receives a token
   and connects.

## Security notes

- Access/refresh tokens and authorization codes are stored hashed; only the client ever holds the
  raw value.
- Authorization codes are single-use and short-lived; refresh tokens rotate on use.
- `redirect_uri` values are validated at registration and must match exactly at authorization time;
  `javascript:`/`data:` schemes and non-loopback `http` are rejected.
- The approval secret is compared in constant time.
- The consent page sets `noindex`, escapes all reflected values, and is served `no-store`.
- Rotating `MCP_API_TOKEN` / `MCP_OAUTH_APPROVAL_SECRET` invalidates future approvals; individual
  tokens also expire on their own TTL.
