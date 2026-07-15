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
`BlobStateStore` for production. Expiry is enforced on read, so an eventually-consistent backend can
never resurrect a dead session or token.

**Persistence is decoupled from `WORKSPACE_STORE`.** OAuth/session state has a hard durability
requirement that workspace *data* does not: a deployment may legitimately run ephemeral in-memory
workspace data, but the remote OAuth flow still spans multiple invocations and would break with an
in-process store. `mcpStateUsesBlobs()` therefore resolves the state backend by precedence:

1. `MCP_STATE_STORE=blobs|memory` — explicit override (and the knob tests use).
2. `WORKSPACE_STORE=blobs` — if the workspace persists, so does auth state.
3. A **Netlify Blobs context is connected** for this runtime (`netlifyBlobsContextConnected()`, set
   by `connectLambdaBlobs`) — the default on a real deploy, so no env var is required.

Otherwise it falls back to the shared in-process memory store (local `node`/`vitest`). This removed
a footgun: previously OAuth silently used memory unless `WORKSPACE_STORE=blobs` was set, so a
connector would register a client and then fail `authorize` with `invalid_client` because the two
requests hit different function instances.

## Wire-facing tool naming

Internally tools are defined with dotted namespaces (`workspace.get_nodes`, `changes.get`). Those
names must never reach a remote client: connectors such as claude.ai forward `tools/list` names
verbatim into the Anthropic Messages API, whose tool-name pattern is `^[a-zA-Z0-9_-]{1,64}$` — a
single dotted name rejects the entire request (observed in production as
`tools.92.custom.name: String should match pattern`, where index 92 was `changes.get`).

The transport therefore serves **canonical underscore names only** (`workspace_get_nodes`) from
`tools/list`, and `tools/call` resolves **both** the canonical and the legacy dotted spelling, so
the in-app UI and existing scripts keep working unchanged. `canonicalToolName()` in `toolKit.ts` is
the single mapping, and `tests/agent/mcp/toolNaming.test.ts` pins the pattern, uniqueness, and the
dual-spelling contract. The server also answers the spec-required `ping` request, which clients use
as a liveness probe.

## Project independence and catalog scoping

The workspace is a project-agnostic Agent SDK host. The independence contract:

- **Generic core never imports from a client folder.** The project MCP adapter
  (`projects/projectMcpAdapter.ts`) and the default-projects seed (`projects/defaultProjects.ts`)
  are workspace-level modules; `projects/drLurie/` contains only Dr. Lurie's own definition,
  artifact policy, and knowledge notes. (`drLurie/adapter.ts` remains as a deprecated re-export.)
- **No per-project tools.** All `project.*` tools operate on any registered
  `ProjectConnectionConfig`; project-specific behavior is data (allow-lists, contracts, env-var
  names), never code in the tool layer.
- **Seed graph is project-neutral.** The default Publishing Conductor nodes carry
  `projectPolicyNotes` and neutral prompt text; client-specific policy prose belongs to that
  client's project module.
- **Catalog scoping.** `MCP_EXPOSED_TOOL_PREFIXES` (e.g. `workspace,node,project,workflow`) trims
  both `tools/list` and `tools/call` to the listed namespaces for lighter connector contexts;
  unset exposes everything.
- **Per-project hooks are the plugin seam.** `projects/projectHooks.ts` maps projectId → optional
  code hooks: `validateHandoffPolicy` (extra findings layered onto `project.validate_handoff`;
  `error` findings mark the handoff invalid, `warning` findings are advisory) and `knowledge`
  (safe structured rules surfaced on `project.get`). Dr. Lurie's artifact policy and knowledge
  rules are wired through this registry — client rules live as plugins, never in generic code.
- **Deprecated tool aliases.** One-to-one duplicate tools resolve via `DEPRECATED_TOOL_ALIASES`
  in `server.ts` (`node.list` → `workspace.get_nodes`, `node.get_execution` →
  `node.list_executions`, `workspace.update_node_schema` → `workspace.update_node_output_schema`).
  Aliases stay callable under both spellings but are not advertised by `tools/list`; alias
  callability follows the alias name's namespace in the exposure allowlist.
- **Self-healing is observable.** `repository.get_health` reports
  `workspace.details.healedDroppedNodes` whenever a tolerant load dropped corrupt node records in
  the current process, so a silent heal never goes unnoticed.
- **Two "project" concepts, named apart.** Agent execution profiles for `/api/agent` live in
  `projects/agentProfiles.ts` (formerly `registry.ts`); external client MCP connections live in
  the `ProjectRepository`. Unifying them behind one registry is roadmap; the rename keeps the
  concepts from blurring until then.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `MCP_OAUTH_APPROVAL_SECRET` | Secret entered on the consent screen to approve a connection. | Falls back to `MCP_API_TOKEN` |
| `MCP_REQUIRE_SESSION` | Require a valid `Mcp-Session-Id` on every non-`initialize` request. | `false` |
| `MCP_STATE_STORE` | Force the OAuth/session store to `blobs` or `memory`. | auto (Blobs on Netlify) |
| `WORKSPACE_STORE` | Repository (workspace data) backend; `blobs` also forces auth-state Blobs. | `memory` |

## Connecting Claude

1. Set `MCP_OAUTH_APPROVAL_SECRET` in Netlify. (OAuth/session state auto-persists in Netlify Blobs;
   no `WORKSPACE_STORE`/`MCP_STATE_STORE` change is required unless you want to force a backend.)
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
